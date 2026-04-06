require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const path = require('path');
const serverless = require('serverless-http');
const {
  GetCommand, PutCommand, UpdateCommand, DeleteCommand,
  QueryCommand, ScanCommand, BatchWriteCommand, BatchGetCommand,
} = require('@aws-sdk/lib-dynamodb');

const isProd = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const SESSIONS_TABLE = process.env.SESSIONS_TABLE;
const ALLOWLIST_TABLE = process.env.ALLOWLIST_TABLE;
const HISTORY_TABLE = process.env.HISTORY_TABLE;
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE;

// Bump this date string whenever the privacy policy changes materially.
// Users who have not accepted this version will be prompted on next login.
const PRIVACY_POLICY_VERSION = '2026-03-31';

// Fail fast in production if required secrets are missing
if (isProd && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is required in production');
}

// ---------------------------------------------------------------------------
// DynamoDB client (production only — skipped in local dev)
// ---------------------------------------------------------------------------
let ddb = null;
if (SESSIONS_TABLE || ALLOWLIST_TABLE || HISTORY_TABLE) {
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
    this.ddb.send(new GetCommand({ TableName: this.tableName, Key: { sessionId: sid } }))
      .then(({ Item }) => {
        if (!Item) return callback(null, null);
        if (Item.expiresAt < Math.floor(Date.now() / 1000)) return callback(null, null);
        if (!Item.data) return callback(null, null);
        let sessionData;
        try { sessionData = JSON.parse(Item.data); } catch { return callback(null, null); }
        if (Item.encryptedTokens && sessionData.user) {
          try {
            sessionData.user.googleTokens = decryptTokens(Item.encryptedTokens);
          } catch {
            // Decryption failed (e.g. after key rotation) — session survives but
            // Gmail calls will return 401 and trigger re-authentication.
          }
        }
        callback(null, sessionData);
      })
      .catch(callback);
  }

  set(sid, sessionData, callback) {
    try {
      const maxAge = sessionData.cookie?.maxAge || 86400000;
      const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(maxAge / 1000);

      // Strip tokens from the session blob and store them encrypted in a separate field.
      const dataToStore = { ...sessionData };
      let encryptedTokens = null;
      if (dataToStore.user?.googleTokens) {
        encryptedTokens = encryptTokens(dataToStore.user.googleTokens);
        dataToStore.user = { ...dataToStore.user };
        delete dataToStore.user.googleTokens;
      }

      this.ddb.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          sessionId: sid,
          data: JSON.stringify(dataToStore),
          encryptedTokens,
          email: sessionData.user?.email || null,
          expiresAt,
          createdAt: sessionData._createdAt || Math.floor(Date.now() / 1000),
        },
      }))
        .then(() => callback(null))
        .catch(callback);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    this.ddb.send(new DeleteCommand({ TableName: this.tableName, Key: { sessionId: sid } }))
      .then(() => callback(null))
      .catch(callback);
  }

  touch(sid, sessionData, callback) {
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
app.disable('x-powered-by');
if (isProd) app.set('trust proxy', 1);

// Security headers
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // unsafe-inline required for inline theme-init script and onclick handlers;
  // cdn.jsdelivr.net required for Chart.js; lh3.googleusercontent.com for Google avatars
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https://lh3.googleusercontent.com data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '));
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  name: 'app.sid',
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: { secure: isProd, httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 },
}));

// ---------------------------------------------------------------------------
// Token encryption (AES-256-GCM, key derived from SESSION_SECRET)
// Google OAuth tokens are encrypted before being written to DynamoDB and
// decrypted when the session is read back. Raw tokens never touch the database.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const _tokenKey = crypto.scryptSync(
  process.env.SESSION_SECRET || 'dev-secret-change-me',
  'email-unsub-token-key',
  32
);

function encryptTokens(tokens) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _tokenKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptTokens(data) {
  const buf = Buffer.from(data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', _tokenKey, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
}

// ---------------------------------------------------------------------------
// CSRF protection
// ---------------------------------------------------------------------------

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
  const { Item } = await ddb.send(new GetCommand({ TableName: ALLOWLIST_TABLE, Key: { email } }));
  return Item || null;
}

async function upsertAllowlistEntry(email, updates) {
  if (!ddb || !ALLOWLIST_TABLE) return;
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
  await ddb.send(new PutCommand({ TableName: ALLOWLIST_TABLE, Item: entry }));
}

async function deleteAllowlistEntry(email) {
  if (!ddb || !ALLOWLIST_TABLE) return;
  await ddb.send(new DeleteCommand({ TableName: ALLOWLIST_TABLE, Key: { email } }));
}

async function getAllAllowlistEntries() {
  if (!ddb || !ALLOWLIST_TABLE) return [];
  const { Items = [] } = await ddb.send(new ScanCommand({ TableName: ALLOWLIST_TABLE }));
  return Items.sort((a, b) => (a.addedAt || '').localeCompare(b.addedAt || ''));
}

// ---------------------------------------------------------------------------
// Unsubscribe history helpers
// ---------------------------------------------------------------------------
const localHistory = new Map(); // local dev fallback: key = `${userEmail}#${domain}`

// Cache for getUnsubscribedDomains — avoids a DynamoDB round-trip on every email fetch.
// TTL: 5 minutes. Invalidated immediately when the user unsubscribes.
const unsubDomainsCache = new Map(); // key: email → { domains: Set, expiresAt: number }
const UNSUB_CACHE_TTL_MS = 5 * 60 * 1000;

async function logUnsubscribe(userEmail, domain, senderEmail, unsubscribeUrl) {
  if (!ddb || !HISTORY_TABLE) {
    const key = `${userEmail}#${domain}`;
    const existing = localHistory.get(key) || { count: 0 };
    localHistory.set(key, {
      userEmail, domain, senderEmail, unsubscribeUrl,
      unsubscribedAt: new Date().toISOString(),
      count: existing.count + 1,
    });
    return;
  }
  // Invalidate cache so the next email fetch reflects the new unsubscribe
  unsubDomainsCache.delete(userEmail);
  await ddb.send(new UpdateCommand({
    TableName: HISTORY_TABLE,
    Key: { userEmail, domain },
    UpdateExpression: 'SET senderEmail = :se, unsubscribeUrl = :url, unsubscribedAt = :at, #cnt = if_not_exists(#cnt, :zero) + :one',
    ExpressionAttributeNames: { '#cnt': 'count' },
    ExpressionAttributeValues: {
      ':se': senderEmail,
      ':url': unsubscribeUrl,
      ':at': new Date().toISOString(),
      ':zero': 0,
      ':one': 1,
    },
  }));
}

async function getUnsubscribedDomains(userEmail) {
  if (!ddb || !HISTORY_TABLE) {
    const domains = new Set();
    for (const [key, val] of localHistory) {
      if (key.startsWith(`${userEmail}#`)) domains.add(val.domain);
    }
    return domains;
  }
  const cached = unsubDomainsCache.get(userEmail);
  if (cached && cached.expiresAt > Date.now()) return cached.domains;

  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: HISTORY_TABLE,
    KeyConditionExpression: 'userEmail = :email',
    ExpressionAttributeValues: { ':email': userEmail },
    ProjectionExpression: '#domain',
    ExpressionAttributeNames: { '#domain': 'domain' },
  }));
  const domains = new Set(Items.map(i => i.domain));
  unsubDomainsCache.set(userEmail, { domains, expiresAt: Date.now() + UNSUB_CACHE_TTL_MS });
  return domains;
}

async function getAllHistory() {
  if (!ddb || !HISTORY_TABLE) {
    return [...localHistory.values()]
      .sort((a, b) => (b.unsubscribedAt || '').localeCompare(a.unsubscribedAt || ''))
      .map(({ userEmail, unsubscribedAt, count }) => ({ userEmail, unsubscribedAt, count }));
  }
  const { Items = [] } = await ddb.send(new ScanCommand({
    TableName: HISTORY_TABLE,
    ProjectionExpression: 'userEmail, unsubscribedAt, #cnt',
    ExpressionAttributeNames: { '#cnt': 'count' },
  }));
  return Items.sort((a, b) => (b.unsubscribedAt || '').localeCompare(a.unsubscribedAt || ''));
}

async function getActiveSessions() {
  if (!ddb || !SESSIONS_TABLE) return [];
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
// Analytics helpers
// ---------------------------------------------------------------------------
async function getStoredAnalytics(userEmail, dates) {
  if (!ddb || !ANALYTICS_TABLE || !dates.length) return {};
  const keys = dates.map(date => ({ userEmail, date }));
  const { Responses } = await ddb.send(new BatchGetCommand({
    RequestItems: { [ANALYTICS_TABLE]: { Keys: keys } },
  }));
  const items = Responses?.[ANALYTICS_TABLE] || [];
  return Object.fromEntries(items.map(i => [i.date, i.count]));
}

async function storeAnalyticsCounts(userEmail, dateCounts) {
  if (!ddb || !ANALYTICS_TABLE) return;
  const expiresAt = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
  const entries = Object.entries(dateCounts);
  for (let i = 0; i < entries.length; i += 25) {
    const chunk = entries.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [ANALYTICS_TABLE]: chunk.map(([date, count]) => ({
          PutRequest: {
            Item: { userEmail, date, count, fetchedAt: new Date().toISOString(), expiresAt },
          },
        })),
      },
    }));
  }
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

app.get('/help', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'help.html'));
});

app.get('/access-denied', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'access-denied.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
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
      privacyAcceptedVersion: entry.privacyAcceptedVersion || null,
    };

    // Apply remember me
    const maxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    req.session.cookie.maxAge = maxAge;

    // Explicitly save session before redirecting — prevents a race condition
    // where the redirect fires before the session write to the store completes
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err.message);
        return res.redirect('/?error=auth_failed');
      }
      res.redirect('/app');
    });
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/status', (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  const { email, firstName, lastName, picture, isAdmin, privacyAcceptedVersion } = req.session.user;
  const requiresPolicyAcceptance = privacyAcceptedVersion !== PRIVACY_POLICY_VERSION;
  res.json({ authenticated: true, csrfToken: getCsrfToken(req), requiresPolicyAcceptance, user: { email, firstName, lastName, picture, isAdmin } });
});

app.post('/auth/logout', requireCsrf, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.post('/api/accept-policy', requireAuth, requireCsrf, async (req, res) => {
  try {
    await upsertAllowlistEntry(req.session.user.email, {
      privacyAcceptedVersion: PRIVACY_POLICY_VERSION,
      privacyAcceptedAt: new Date().toISOString(),
    });
    req.session.user.privacyAcceptedVersion = PRIVACY_POLICY_VERSION;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const daysBack = range === 'month' ? 30 : range === 'week' ? 7 : 1;
    const afterDate = new Date();
    afterDate.setDate(afterDate.getDate() - daysBack);
    const afterTimestamp = Math.floor(afterDate.getTime() / 1000);

    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      q: `after:${afterTimestamp} (unsubscribe OR "opt out" OR "opt-out")`,
      maxResults: 200,
    }, { timeout: 15000 });

    const messages = listResponse.data.messages || [];
    if (!messages.length) return res.json({ emails: [] });

    // First pass: fetch metadata only (headers, no body/attachments)
    const metadataHeaderNames = ['From', 'Subject', 'List-Unsubscribe', 'List-Unsubscribe-Post'];
    const results = [];
    for (let i = 0; i < messages.length; i += 20) {
      const batch = messages.slice(i, i + 20);
      const details = await Promise.all(batch.map(msg =>
        gmail.users.messages.get({
          userId: 'me', id: msg.id,
          format: 'METADATA',
          metadataHeaders: metadataHeaderNames,
        }, { timeout: 15000 }).catch(() => null)
      ));
      results.push(...details.filter(Boolean));
    }

    // Second pass: for messages with no List-Unsubscribe header, fetch full format
    // so we can scan the body for inline unsubscribe links
    const noHeaderIds = results
      .filter(d => !d.data.payload.headers.some(
        h => h.name.toLowerCase() === 'list-unsubscribe'
      ))
      .map(d => d.data.id);

    const fullFetched = new Map();
    for (let i = 0; i < noHeaderIds.length; i += 20) {
      const batch = noHeaderIds.slice(i, i + 20);
      const details = await Promise.all(batch.map(id =>
        gmail.users.messages.get({ userId: 'me', id, format: 'full' }, { timeout: 15000 }).catch(() => null)
      ));
      for (const d of details.filter(Boolean)) fullFetched.set(d.data.id, d);
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
      if (!unsubscribeUrl) {
        const fullData = fullFetched.get(msgData.data.id);
        if (fullData) unsubscribeUrl = findUnsubscribeInBody(fullData.data.payload);
      }
      if (!unsubscribeUrl) continue;

      const key = `${senderEmail}|${unsubscribeUrl}`;
      if (emails.some(e => `${e.senderEmail}|${e.unsubscribeUrl}` === key)) continue;

      const listUnsubPost = getHeader('List-Unsubscribe-Post');
      const oneClick = !!listUnsubPost && unsubscribeUrl.startsWith('http');

      emails.push({
        senderEmail, domain, subject, unsubscribeUrl, oneClick,
        date: new Date(parseInt(msgData.data.internalDate)).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
        }),
      });
    }

    emails.sort((a, b) => a.domain.localeCompare(b.domain));

    const unsubscribedDomains = await getUnsubscribedDomains(req.session.user.email);
    emails.forEach(e => { e.alreadyUnsubscribed = unsubscribedDomains.has(e.domain); });

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
// Analytics
// ---------------------------------------------------------------------------
app.get('/api/analytics', requireAuth, async (req, res) => {
  const { period = 'week' } = req.query;
  if (!['week', 'month'].includes(period)) {
    return res.status(400).json({ error: 'period must be week or month' });
  }

  const days = period === 'week' ? 7 : 30;
  const userEmail = req.session.user.email;

  // Build date label arrays (YYYY-MM-DD) for current and previous periods
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const toDateStr = d => d.toISOString().slice(0, 10);

  const labels = [], prevLabels = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayMidnight); d.setDate(d.getDate() - i);
    labels.push(toDateStr(d));
  }
  for (let i = days * 2 - 1; i >= days; i--) {
    const d = new Date(todayMidnight); d.setDate(d.getDate() - i);
    prevLabels.push(toDateStr(d));
  }

  const todayStr = labels[labels.length - 1];
  const allDates = [...prevLabels, ...labels];

  try {
    // Read whatever is already stored
    const stored = await getStoredAnalytics(userEmail, allDates);

    // Determine which dates need a Gmail fetch: today always re-fetches, others only if missing
    const toFetch = allDates.filter(d => d === todayStr || !(d in stored));

    let capped = false;
    if (toFetch.length > 0) {
      const oauth2Client = createOAuthClient();
      oauth2Client.setCredentials(req.session.user.googleTokens);
      oauth2Client.on('tokens', tokens => {
        req.session.user.googleTokens = { ...req.session.user.googleTokens, ...tokens };
      });
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      // Single Gmail call covering from the oldest date to be fetched through today
      const oldestDate = toFetch[0]; // already sorted oldest-first
      const afterTimestamp = Math.floor(new Date(oldestDate).getTime() / 1000);

      const listResponse = await gmail.users.messages.list({
        userId: 'me',
        q: `(unsubscribe OR "opt out" OR "opt-out") after:${afterTimestamp}`,
        maxResults: 500,
      }, { timeout: 15000 });

      capped = !!(listResponse.data.nextPageToken);
      const messages = listResponse.data.messages || [];

      // Initialise all fetched dates at zero so days with no emails still get stored
      const dateCounts = Object.fromEntries(toFetch.map(d => [d, 0]));

      if (messages.length > 0) {
        for (let i = 0; i < messages.length; i += 20) {
          const batch = messages.slice(i, i + 20);
          const details = await Promise.all(
            batch.map(msg =>
              gmail.users.messages.get({
                userId: 'me', id: msg.id, format: 'METADATA',
                metadataHeaders: ['List-Unsubscribe'],
              }, { timeout: 15000 }).catch(() => null)
            )
          );
          for (const d of details) {
            if (!d) continue;
            const headers = d.data.payload?.headers || [];
            const hasHeader = headers.some(h => h.name.toLowerCase() === 'list-unsubscribe' && h.value);
            if (!hasHeader) continue;
            const dateStr = toDateStr(new Date(parseInt(d.data.internalDate)));
            if (dateStr in dateCounts) dateCounts[dateStr]++;
          }
        }
      }

      await storeAnalyticsCounts(userEmail, dateCounts);
      Object.assign(stored, dateCounts);
    }

    const counts = labels.map(d => stored[d] || 0);
    const total = counts.reduce((a, b) => a + b, 0);
    const previousTotal = prevLabels.reduce((sum, d) => sum + (stored[d] || 0), 0);

    res.json({ labels, counts, total, previousTotal, capped });
  } catch (err) {
    console.error('Analytics error:', err.message);
    if (err.code === 401 || err.response?.status === 401) {
      req.session.destroy();
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Unsubscribe logging
// ---------------------------------------------------------------------------
app.post('/api/unsubscribe', requireAuth, requireCsrf, async (req, res) => {
  const { domain, senderEmail, unsubscribeUrl } = req.body;
  if (!domain || !unsubscribeUrl) {
    return res.status(400).json({ error: 'domain and unsubscribeUrl are required' });
  }
  try {
    await logUnsubscribe(req.session.user.email, domain, senderEmail || '', unsubscribeUrl);
    res.json({ ok: true });
  } catch (err) {
    console.error('Unsubscribe log error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// One-click unsubscribe (RFC 8058 — server-side POST proxy)
// ---------------------------------------------------------------------------
app.post('/api/one-click-unsubscribe', requireAuth, requireCsrf, async (req, res) => {
  const { domain, senderEmail, unsubscribeUrl } = req.body;
  if (!domain || !unsubscribeUrl) {
    return res.status(400).json({ error: 'domain and unsubscribeUrl are required' });
  }

  let parsed;
  try { parsed = new URL(unsubscribeUrl); } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only HTTP(S) URLs are supported' });
  }

  try {
    const postBody = 'List-Unsubscribe=One-Click';
    await new Promise((resolve, reject) => {
      const mod = parsed.protocol === 'https:' ? require('https') : require('http');
      const reqOut = mod.request(unsubscribeUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(10000), // covers DNS + connect + idle, not just socket idle
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postBody),
          'User-Agent': 'Mozilla/5.0 (compatible; EmailUnsubscribeManager/1.0)',
        },
      }, (r) => {
        r.resume(); // drain response
        if (r.statusCode >= 400) return reject(new Error(`Remote server returned ${r.statusCode}`));
        resolve(r.statusCode);
      });
      reqOut.on('error', reject);
      reqOut.write(postBody);
      reqOut.end();
    });

    await logUnsubscribe(req.session.user.email, domain, senderEmail || '', unsubscribeUrl);
    res.json({ ok: true });
  } catch (err) {
    console.error('One-click unsubscribe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// User settings
// ---------------------------------------------------------------------------
app.get('/api/user-settings', requireAuth, async (req, res) => {
  try {
    const userEmail = req.session.user.email;
    if (!ddb || !ALLOWLIST_TABLE) return res.json({});
    const { Item } = await ddb.send(new GetCommand({ TableName: ALLOWLIST_TABLE, Key: { email: userEmail } }));
    res.json(Item?.settings || {});
  } catch (err) {
    console.error('Get user-settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user-settings', requireAuth, requireCsrf, async (req, res) => {
  // Validate: only accept known boolean keys, reject anything else
  const ALLOWED_SETTINGS = new Set(['darkMode', 'suppressCleanConfirmation']);
  const unknown = Object.keys(req.body).filter(k => !ALLOWED_SETTINGS.has(k));
  if (unknown.length) {
    return res.status(400).json({ error: `Unknown setting key(s): ${unknown.join(', ')}` });
  }
  const sanitized = {};
  for (const key of ALLOWED_SETTINGS) {
    if (key in req.body) sanitized[key] = !!req.body[key];
  }

  try {
    const userEmail = req.session.user.email;
    if (!ddb || !ALLOWLIST_TABLE) return res.json({ ok: true, settings: sanitized });
    const { Item } = await ddb.send(new GetCommand({ TableName: ALLOWLIST_TABLE, Key: { email: userEmail } }));
    const existing = Item?.settings || {};
    const merged = { ...existing, ...sanitized };
    await ddb.send(new UpdateCommand({
      TableName: ALLOWLIST_TABLE,
      Key: { email: userEmail },
      UpdateExpression: 'SET settings = :s',
      ExpressionAttributeValues: { ':s': merged },
    }));
    res.json({ ok: true, settings: merged });
  } catch (err) {
    console.error('Post user-settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Clean inbox — senders list + trash action
// ---------------------------------------------------------------------------
app.get('/api/clean-inbox/senders', requireAuth, async (req, res) => {
  try {
    const userEmail = req.session.user.email;
    if (!ddb || !HISTORY_TABLE) return res.json({ senders: [] });
    const { Items = [] } = await ddb.send(new QueryCommand({
      TableName: HISTORY_TABLE,
      KeyConditionExpression: 'userEmail = :email',
      ExpressionAttributeValues: { ':email': userEmail },
    }));
    const senders = Items.map(({ domain, senderEmail, unsubscribedAt, count }) => ({ domain, senderEmail, unsubscribedAt, count }));
    res.json({ senders });
  } catch (err) {
    console.error('Clean inbox senders error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clean-inbox', requireAuth, requireCsrf, async (req, res) => {
  try {
    const { ignoreStarred = false, ignoreImportant = false } = req.body;
    const userEmail = req.session.user.email;

    // Get unsubscribed senders from history table
    let senders = [];
    if (ddb && HISTORY_TABLE) {
      const { Items = [] } = await ddb.send(new QueryCommand({
        TableName: HISTORY_TABLE,
        KeyConditionExpression: 'userEmail = :email',
        ExpressionAttributeValues: { ':email': userEmail },
      }));
      senders = Items;
    }

    if (!senders.length) {
      return res.json({ trashed: 0, message: 'No unsubscribed senders found' });
    }

    // Build Gmail search query
    const senderEmails = [...new Set(senders.map(s => s.senderEmail).filter(e => e))];
    const domains = [...new Set(senders.map(s => s.domain).filter(d => d))];
    const domainsWithoutEmail = domains.filter(d => !senders.some(s => s.senderEmail && s.domain === d));

    const fromParts = [
      ...senderEmails,
      ...domainsWithoutEmail.map(d => `*@${d}`),
    ];

    let query = `from:(${fromParts.join(' OR ')})`;
    if (ignoreStarred) query += ' -is:starred';
    if (ignoreImportant) query += ' -is:important';
    query += ' -in:trash';

    // Set up Gmail client
    const oauth2Client = createOAuthClient();
    oauth2Client.setCredentials(req.session.user.googleTokens);
    oauth2Client.on('tokens', (tokens) => {
      req.session.user.googleTokens = { ...req.session.user.googleTokens, ...tokens };
    });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Fetch up to 500 message IDs (one page only)
    const listResponse = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 500 }, { timeout: 15000 });
    const messages = listResponse.data.messages || [];
    const capped = messages.length === 500;

    // Trash messages in parallel batches of 10
    let trashed = 0;
    for (let i = 0; i < messages.length; i += 10) {
      const batch = messages.slice(i, i + 10);
      await Promise.all(batch.map(msg => gmail.users.messages.trash({ userId: 'me', id: msg.id }, { timeout: 15000 }).catch(e => {
        console.error('Trash message error:', e.message);
      })));
      trashed += batch.length;
    }

    res.json({ trashed, capped });
  } catch (err) {
    console.error('Clean inbox error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------
app.delete('/api/account', requireAuth, requireCsrf, async (req, res) => {
  try {
    const userEmail = req.session.user.email;

    // 1. Delete all analytics records (paginated)
    if (ddb && ANALYTICS_TABLE) {
      try {
        let lastKey;
        do {
          const { Items: analyticsItems = [], LastEvaluatedKey } = await ddb.send(new QueryCommand({
            TableName: ANALYTICS_TABLE,
            KeyConditionExpression: 'userEmail = :email',
            ExpressionAttributeValues: { ':email': userEmail },
            ExclusiveStartKey: lastKey,
          }));
          lastKey = LastEvaluatedKey;
          for (let i = 0; i < analyticsItems.length; i += 25) {
            const chunk = analyticsItems.slice(i, i + 25);
            await ddb.send(new BatchWriteCommand({
              RequestItems: {
                [ANALYTICS_TABLE]: chunk.map(item => ({
                  DeleteRequest: { Key: { userEmail: item.userEmail, date: item.date } },
                })),
              },
            }));
          }
        } while (lastKey);
      } catch (e) { console.error('Account delete — analytics error:', e.message); }
    }

    // 2. Delete all history records (paginated)
    if (ddb && HISTORY_TABLE) {
      try {
        let lastKey;
        do {
          const { Items: historyItems = [], LastEvaluatedKey } = await ddb.send(new QueryCommand({
            TableName: HISTORY_TABLE,
            KeyConditionExpression: 'userEmail = :email',
            ExpressionAttributeValues: { ':email': userEmail },
            ProjectionExpression: 'userEmail, #domain',
            ExpressionAttributeNames: { '#domain': 'domain' },
            ExclusiveStartKey: lastKey,
          }));
          lastKey = LastEvaluatedKey;
          for (let i = 0; i < historyItems.length; i += 25) {
            const chunk = historyItems.slice(i, i + 25);
            await ddb.send(new BatchWriteCommand({
              RequestItems: {
                [HISTORY_TABLE]: chunk.map(item => ({
                  DeleteRequest: { Key: { userEmail: item.userEmail, domain: item.domain } },
                })),
              },
            }));
          }
        } while (lastKey);
      } catch (e) { console.error('Account delete — history error:', e.message); }
    }

    // 3. Delete all sessions for this user (paginated scan)
    if (ddb && SESSIONS_TABLE) {
      try {
        let lastKey;
        do {
          const { Items: sessionItems = [], LastEvaluatedKey } = await ddb.send(new ScanCommand({
            TableName: SESSIONS_TABLE,
            FilterExpression: 'email = :email',
            ExpressionAttributeValues: { ':email': userEmail },
            ExclusiveStartKey: lastKey,
          }));
          lastKey = LastEvaluatedKey;
          for (let i = 0; i < sessionItems.length; i += 25) {
            const chunk = sessionItems.slice(i, i + 25);
            await ddb.send(new BatchWriteCommand({
              RequestItems: {
                [SESSIONS_TABLE]: chunk.map(item => ({
                  DeleteRequest: { Key: { sessionId: item.sessionId } },
                })),
              },
            }));
          }
        } while (lastKey);
      } catch (e) { console.error('Account delete — sessions error:', e.message); }
    }

    // 4. Delete from allowlist
    try {
      if (ddb && ALLOWLIST_TABLE) {
        await ddb.send(new DeleteCommand({ TableName: ALLOWLIST_TABLE, Key: { email: userEmail } }));
      }
    } catch (e) { console.error('Account delete — allowlist error:', e.message); }

    // Destroy the current session
    req.session.destroy(() => {});

    res.json({ ok: true });
  } catch (err) {
    console.error('Account delete error:', err.message);
    res.status(500).json({ error: err.message });
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

app.get('/api/admin/history', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json({ history: await getAllHistory() });
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
module.exports.app = app;
module.exports.parseListUnsubscribe = parseListUnsubscribe;
module.exports.findUnsubscribeInBody = findUnsubscribeInBody;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
}
