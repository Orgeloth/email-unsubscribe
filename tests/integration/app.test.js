'use strict';

process.env.SESSION_SECRET = 'test-secret';
const request = require('supertest');
const { app } = require('../../server');

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
describe('GET /health', () => {
  test('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Auth status
// ---------------------------------------------------------------------------
describe('GET /auth/status', () => {
  test('returns authenticated: false when no session', async () => {
    const res = await request(app).get('/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CSRF protection
// ---------------------------------------------------------------------------
describe('POST /auth/logout', () => {
  test('rejects request without CSRF token with 403', async () => {
    const res = await request(app).post('/auth/logout');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
describe('GET /api/emails', () => {
  test('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/emails');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/unsubscribe', () => {
  test('returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/api/unsubscribe')
      .send({ domain: 'test.com', unsubscribeUrl: 'https://test.com/unsub' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/users', () => {
  test('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/admin/users');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/history', () => {
  test('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/admin/history');
    expect(res.status).toBe(401);
  });
});
