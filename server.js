require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const { google } = require('googleapis');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Trust Lambda/API Gateway proxy for correct HTTPS detection
if (isProd) app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// cookie-session: stateless — OAuth tokens stored in signed cookie, no DB needed
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET || 'dev-secret-change-me'],
  maxAge: 24 * 60 * 60 * 1000,
  secure: isProd,
  httpOnly: true,
  sameSite: 'lax',
}));

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback'
  );
}

function requireAuth(req, res, next) {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// Start OAuth flow
app.get('/auth/google', (req, res) => {
  const oauth2Client = createOAuthClient();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

// OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  try {
    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    res.redirect('/');
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

// Auth status
app.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!req.session.tokens });
});

// Logout
app.post('/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// Decode base64url encoded email part
function decodeBase64(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// Extract all text from email parts recursively
function extractTextParts(payload) {
  const parts = [];
  if (!payload) return parts;

  if (payload.body && payload.body.data) {
    parts.push({ mimeType: payload.mimeType, data: decodeBase64(payload.body.data) });
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      parts.push(...extractTextParts(part));
    }
  }
  return parts;
}

// Find unsubscribe URL from email body
function findUnsubscribeInBody(payload) {
  const textParts = extractTextParts(payload);
  const unsubscribePatterns = [
    /https?:\/\/[^\s"'<>]+unsubscribe[^\s"'<>]*/gi,
    /https?:\/\/[^\s"'<>]+opt[-_]?out[^\s"'<>]*/gi,
    /https?:\/\/[^\s"'<>]+optout[^\s"'<>]*/gi,
  ];

  for (const part of textParts) {
    for (const pattern of unsubscribePatterns) {
      const matches = part.data.match(pattern);
      if (matches && matches.length > 0) {
        // Return the first clean match
        return matches[0].replace(/[.,;)>]+$/, '');
      }
    }
  }
  return null;
}

// Parse List-Unsubscribe header
function parseListUnsubscribe(headerValue) {
  if (!headerValue) return null;

  // Extract URLs from angle brackets: <url>, <mailto:...>
  const urlMatch = headerValue.match(/<(https?:\/\/[^>]+)>/i);
  if (urlMatch) return urlMatch[1];

  // Fallback: bare URL
  const bareUrl = headerValue.match(/https?:\/\/[^\s,>]+/i);
  if (bareUrl) return bareUrl[0];

  return null;
}

// Fetch emails with unsubscribe links
app.get('/api/emails', requireAuth, async (req, res) => {
  const { range = 'yesterday' } = req.query;

  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(req.session.tokens);

  // Refresh token if needed
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      req.session.tokens = { ...req.session.tokens, ...tokens };
    } else {
      req.session.tokens = { ...req.session.tokens, access_token: tokens.access_token };
    }
  });

  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const daysBack = range === 'week' ? 7 : 1;
    const afterDate = new Date();
    afterDate.setDate(afterDate.getDate() - daysBack);
    const afterTimestamp = Math.floor(afterDate.getTime() / 1000);

    // Search for emails with unsubscribe content
    const searchQuery = `after:${afterTimestamp} (unsubscribe OR "opt out" OR "opt-out")`;

    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      q: searchQuery,
      maxResults: 200
    });

    const messages = listResponse.data.messages || [];

    if (messages.length === 0) {
      return res.json({ emails: [] });
    }

    // Fetch message details in parallel (batches of 20)
    const batchSize = 20;
    const results = [];

    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      const detailPromises = batch.map(msg =>
        gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full',
          metadataHeaders: ['From', 'Subject', 'List-Unsubscribe', 'List-Unsubscribe-Post']
        }).catch(() => null)
      );
      const batchResults = await Promise.all(detailPromises);
      results.push(...batchResults.filter(Boolean));
    }

    const emails = [];

    for (const msgData of results) {
      const payload = msgData.data.payload;
      const headers = payload.headers || [];

      const getHeader = (name) =>
        headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      const from = getHeader('From');
      const subject = getHeader('Subject');
      const listUnsubscribeHeader = getHeader('List-Unsubscribe');

      // Parse sender
      const emailMatch = from.match(/[\w.+%-]+@[\w.-]+\.[a-zA-Z]{2,}/);
      const senderEmail = emailMatch ? emailMatch[0].toLowerCase() : from;
      const domain = senderEmail.includes('@') ? senderEmail.split('@')[1] : '';

      // Get unsubscribe URL: prefer List-Unsubscribe header, fall back to body scan
      let unsubscribeUrl = parseListUnsubscribe(listUnsubscribeHeader);
      if (!unsubscribeUrl) {
        unsubscribeUrl = findUnsubscribeInBody(payload);
      }

      if (!unsubscribeUrl) continue; // Skip if no unsubscribe link found

      // Avoid duplicates by domain+unsubscribe combo
      const key = `${senderEmail}|${unsubscribeUrl}`;
      if (emails.some(e => `${e.senderEmail}|${e.unsubscribeUrl}` === key)) continue;

      emails.push({
        senderEmail,
        domain,
        subject,
        unsubscribeUrl,
        date: new Date(parseInt(msgData.data.internalDate)).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
        })
      });
    }

    // Sort by domain
    emails.sort((a, b) => a.domain.localeCompare(b.domain));

    res.json({ emails, total: emails.length });
  } catch (err) {
    console.error('Gmail API error:', err.message);
    if (err.code === 401 || (err.response && err.response.status === 401)) {
      req.session.tokens = null;
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }
    res.status(500).json({ error: 'Failed to fetch emails: ' + err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Lambda handler export
const serverless = require('serverless-http');
module.exports.handler = serverless(app);

// Local dev server
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
}
