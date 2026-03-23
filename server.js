require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const path = require('path');
const serverless = require('serverless-http');

const isProd = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const SESSIONS_TABLE = process.env.SESSIONS_TABLE;
const ALLOWLIST_TABLE = process.env.ALLOWLIST_TABLE;

// Fail fast in production if required secrets are missing
if (isProd && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is required in production');
}

// ---------------------------------------------------------------------------
// DynamoDB client (production only — skipped in local dev)
// ---------------------------------------------------------------------------
let ddb = null;
if (SESSIONS_TABLE || ALLOWLIST_TABLE) {
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
  ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

// ---------------------------------------------------------------------------
// Custom DynamoDB session store
// ---------------------------------------------------------------------------
class DynamoDBStore extends session.Store {
  constructor(tableName, client) {
    super();
    this.tableName = tableName;
    this.ddb = client;
  }

  get(sid, callback) {
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    this.ddb.send(new GetCommand({ TableName: this.tableName, Key: { sessionId: sid } }))
      .then(({ Item }) => {
        if (!Item) return callback(null, null);
        if (Item.expiresAt < Math.floor(Date.now() / 1000)) return callback(null, null);
        callback(null, JSON.parse(Item.data));
      })
      .catch(callback);
  }

  set(sid, sessionData, callback) {
    const { PutCommand } = require('@aws-sdk/lib-dynamodb');
    const maxAge = sessionData.cookie?.maxAge || 86400000;
    const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(maxAge / 1000);
    this.ddb.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        sessionId: sid,
        data: JSON.stringify(sessionData),
        email: sessionData.user?.email || null,
        expiresAt,
        createdAt: sessionData._createdAt || Math.floor(Date.now() / 1000),
      },
    }))
      .then(() => callback(null))
      .catch(callback);
  }

  destroy(sid, callback) {
    const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
    this.ddb.send(new DeleteCommand({ TableName: this.tableName, Key: { sessionId: sid } }))
      .then(() => callback(null))
      .catch(callback);
  }

  touch(sid, sessionData, callback) {
    const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    const maxAge = sessionData.cookie?.maxAge || 86400000;
    const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(maxAge / 1000);
    this.ddb.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { sessionId: sid },
      UpdateExpression: 'SET expiresAt = :exp',
      ExpressionAttributeValues: { ':exp': expiresAt },
    }))
      .then(() => callback(null))
      .catch(callback);
  }
}

// ---------------------------------------------------------------------------
// Session middleware
// ---------------------------------------------------------------------------
let sessionStore;
if (ddb && SESSIONS_TABLE) {
  sessionStore = new DynamoDBStore(SESSIONS_TABLE, ddb);
} else {
  const MemoryStore = require('memorystore')(session);
  sessionStore = new MemoryStore({ checkPeriod: 86400000 });
}

const app = express();
if (isProd) app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: { secure: isProd, httpOnly: true, sameSite: 'strict', maxAge: 24 * 60 * 60 * 1000 },
}));

// ---------------------------------------------------------------------------
// CSRF protection
// ---------------------------------------------------------------------------
const crypto = require('crypto');

function getCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback'
  );
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user?.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ---------------------------------------------------------------------------
// DynamoDB allowlist helpers
// ---------------------------------------------------------------------------
async function getAllowlistEntry(email) {
  if (!ddb || !ALLOWLIST_TABLE) return { status: 'active', isAdmin: false }; // local dev bypass
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  const { Item } = await ddb.send(new GetCommand({ TableName: ALLOWLIST_TABLE, Key: { email } }));
  return Item || null;
}

async function upsertAllowlistEntry(email, updates) {
  if (!ddb || !ALLOWLIST_TABLE) return;
  const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
  const keys = Object.keys(updates);
  const expr = keys.map(k => `#${k} = :${k}`).join(', ');
  const names = Object.fromEntries(keys.map(k => [`#${k}`, k]));
  const values = Object.fromEntries(keys.map(k => [`:${k}`, updates[k]]));
  await ddb.send(new UpdateCommand({
    TableName: ALLOWLIST_TABLE,
    Key: { email },
    UpdateExpression: `SET ${expr}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function putAllowlistEntry(entry) {
  if (!ddb || !ALLOWLIST_TABLE) return;
  const { PutCommand } = require('@aws-sdk/lib-dynamodb');
  await ddb.send(new PutCommand({ TableName: ALLOWLIST_TABLE, Item: entry }));
}

async function deleteAllowlistEntry(email) {
  if (!ddb || !ALLOWLIST_TABLE) return;
  const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
  await ddb.send(new DeleteCommand({ TableName: ALLOWLIST_TABLE, Key: { email } }));
}

async function getAllAllowlistEntries() {
  if (!ddb || !ALLOWLIST_TABLE) return [];
  const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
  const { Items = [] } = await ddb.send(new ScanCommand({ TableName: ALLOWLIST_TABLE }));
  return Items.sort((a, b) => (a.addedAt || '').localeCompare(b.addedAt || ''));
}

async function getActiveSessions() {
  if (!ddb || !SESSIONS_TABLE) return [];
  const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
  const now = Math.floor(Date.now() / 1000);
  const { Items = [] } = await ddb.send(new ScanCommand({ TableName: SESSIONS_TABLE }));
  return Items
    .filter(item => item.expiresAt > now && item.email)
    .map(item => ({
      sessionId: item.sessionId,
      email: item.email,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// ---------------------------------------------------------------------------
// Page routes
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/app', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'app.html'));
});

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.get('/access-denied', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'access-denied.html'));
});

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.get('/auth/google', (req, res) => {
  const oauth2Client = createOAuthClient();
  const state = Buffer.from(JSON.stringify({ rememberMe: req.query.rememberMe === 'true' })).toString('base64');
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    prompt: 'consent',
    state,
  });
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  let rememberMe = false;
  try {
    rememberMe = JSON.parse(Buffer.from(state || 'e30=', 'base64').toString()).rememberMe;
  } catch (_) {}

  try {
    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user profile from Google
    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2Api.userinfo.get();
    const { email, given_name: firstName, family_name: lastName, picture } = profile;

    // Check allowlist
    const entry = await getAllowlistEntry(email);
    if (!entry) return res.redirect('/access-denied');
    if (entry.status === 'disabled') return res.redirect('/access-denied?reason=disabled');

    // Update allowlist with Google profile info and last login
    await upsertAllowlistEntry(email, {
      firstName: firstName || entry.firstName || '',
      lastName: lastName || entry.lastName || '',
      picture: picture || '',
      lastLoginAt: new Date().toISOString(),
    });

    // Set session
    req.session._createdAt = Math.floor(Date.now() / 1000);
    req.session.user = {
      email,
      firstName: firstName || '',
      lastName: lastName || '',
      picture: picture || '',
      isAdmin: entry.isAdmin || false,
      googleTokens: tokens,
    };

    // Apply remember me
    const maxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    req.session.cookie.maxAge = maxAge;

    res.redirect('/app');
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/status', (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  const { email, firstName, lastName, picture, isAdmin } = req.session.user;
  res.json({ authenticated: true, csrfToken: getCsrfToken(req), user: { email, firstName, lastName, picture, isAdmin } });
});

app.post('/auth/logout', requireCsrf, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------------------------------------------------------------------------
// Gmail API
// ---------------------------------------------------------------------------
function decodeBase64(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function extractTextParts(payload) {
  const parts = [];
  if (!payload) return parts;
  if (payload.body?.data) parts.push({ mimeType: payload.mimeType, data: decodeBase64(payload.body.data) });
  if (payload.parts) for (const part of payload.parts) parts.push(...extractTextParts(part));
  return parts;
}

function findUnsubscribeInBody(payload) {
  const patterns = [
    /https?:\/\/[^\s"'<>]+unsubscribe[^\s"'<>]*/gi,
    /https?:\/\/[^\s"'<>]+opt[-_]?out[^\s"'<>]*/gi,
  ];
  for (const part of extractTextParts(payload)) {
    for (const pattern of patterns) {
      const matches = part.data.match(pattern);
      if (matches?.length) return matches[0].replace(/[.,;)>]+$/, '');
    }
  }
  return null;
}

function parseListUnsubscribe(headerValue) {
  if (!headerValue) return null;
  const urlMatch = headerValue.match(/<(https?:\/\/[^>]+)>/i);
  if (urlMatch) return urlMatch[1];
  const bareUrl = headerValue.match(/https?:\/\/[^\s,>]+/i);
  return bareUrl ? bareUrl[0] : null;
}

app.get('/api/emails', requireAuth, async (req, res) => {
  const { range = 'yesterday' } = req.query;
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(req.session.user.googleTokens);

  oauth2Client.on('tokens', (tokens) => {
    req.session.user.googleTokens = { ...req.session.user.googleTokens, ...tokens };
  });

  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const daysBack = range === 'week' ? 7 : 1;
    const afterDate = new Date();
    afterDate.setDate(afterDate.getDate() - daysBack);
    const afterTimestamp = Math.floor(afterDate.getTime() / 1000);

    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      q: `after:${afterTimestamp} (unsubscribe OR "opt out" OR "opt-out")`,
      maxResults: 200,
    });

    const messages = listResponse.data.messages || [];
    if (!messages.length) return res.json({ emails: [] });

    const results = [];
    for (let i = 0; i < messages.length; i += 20) {
      const batch = messages.slice(i, i + 20);
      const details = await Promise.all(batch.map(msg =>
        gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' }).catch(() => null)
      ));
      results.push(...details.filter(Boolean));
    }

    const emails = [];
    for (const msgData of results) {
      const payload = msgData.data.payload;
      const headers = payload.headers || [];
      const getHeader = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      const from = getHeader('From');
      const subject = getHeader('Subject');
      const emailMatch = from.match(/[\w.+%-]+@[\w.-]+\.[a-zA-Z]{2,}/);
      const senderEmail = emailMatch ? emailMatch[0].toLowerCase() : from;
      const domain = senderEmail.includes('@') ? senderEmail.split('@')[1] : '';

      let unsubscribeUrl = parseListUnsubscribe(getHeader('List-Unsubscribe'));
      if (!unsubscribeUrl) unsubscribeUrl = findUnsubscribeInBody(payload);
      if (!unsubscribeUrl) continue;

      const key = `${senderEmail}|${unsubscribeUrl}`;
      if (emails.some(e => `${e.senderEmail}|${e.unsubscribeUrl}` === key)) continue;

      emails.push({
        senderEmail, domain, subject, unsubscribeUrl,
        date: new Date(parseInt(msgData.data.internalDate)).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
        }),
      });
    }

    emails.sort((a, b) => a.domain.localeCompare(b.domain));
    res.json({ emails, total: emails.length });
  } catch (err) {
    console.error('Gmail API error:', err.message);
    if (err.code === 401 || err.response?.status === 401) {
      req.session.destroy();
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }
    res.status(500).json({ error: 'Failed to fetch emails: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json({ users: await getAllAllowlistEntries() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users', requireAuth, requireAdmin, requireCsrf, async (req, res) => {
  const { email, isAdmin = false } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });
  try {
    const existing = await getAllowlistEntry(email);
    if (existing && existing.status) return res.status(409).json({ error: 'User already exists' });
    await putAllowlistEntry({
      email: email.toLowerCase().trim(),
      firstName: '',
      lastName: '',
      picture: '',
      status: 'active',
      isAdmin: Boolean(isAdmin),
      addedAt: new Date().toISOString(),
      lastLoginAt: null,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/users/:email', requireAuth, requireAdmin, requireCsrf, async (req, res) => {
  const { email } = req.params;
  const allowed = ['status', 'isAdmin', 'firstName', 'lastName'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });
  try {
    await upsertAllowlistEntry(email, updates);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:email', requireAuth, requireAdmin, requireCsrf, async (req, res) => {
  try {
    await deleteAllowlistEntry(req.params.email);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/sessions', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json({ sessions: await getActiveSessions() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/sessions/:sid', requireAuth, requireAdmin, requireCsrf, async (req, res) => {
  try {
    await new Promise((resolve, reject) => sessionStore.destroy(req.params.sid, err => err ? reject(err) : resolve()));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// Lambda / local dev
// ---------------------------------------------------------------------------
module.exports.handler = serverless(app);

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
}
