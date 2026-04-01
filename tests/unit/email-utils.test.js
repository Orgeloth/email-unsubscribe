'use strict';

process.env.SESSION_SECRET = 'test-secret';
const { parseListUnsubscribe, findUnsubscribeInBody } = require('../../server');

// ---------------------------------------------------------------------------
// parseListUnsubscribe
// ---------------------------------------------------------------------------
describe('parseListUnsubscribe', () => {
  test('extracts URL from angle-bracket format', () => {
    expect(parseListUnsubscribe('<https://example.com/unsub?id=123>'))
      .toBe('https://example.com/unsub?id=123');
  });

  test('extracts URL from bare format', () => {
    expect(parseListUnsubscribe('https://example.com/unsubscribe'))
      .toBe('https://example.com/unsubscribe');
  });

  test('prefers angle-bracket URL when both present', () => {
    expect(parseListUnsubscribe('<https://example.com/unsub>, <mailto:unsub@example.com>'))
      .toBe('https://example.com/unsub');
  });

  test('returns null for mailto-only header', () => {
    expect(parseListUnsubscribe('<mailto:unsub@example.com>')).toBeNull();
  });

  test('returns null for null input', () => {
    expect(parseListUnsubscribe(null)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseListUnsubscribe('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findUnsubscribeInBody
// ---------------------------------------------------------------------------
describe('findUnsubscribeInBody', () => {
  function makePayload(text) {
    // server.js decodes URL-safe base64; standard base64 is compatible after
    // the replace(/-/g, '+').replace(/_/g, '/') transform is a no-op here.
    return {
      mimeType: 'text/plain',
      body: { data: Buffer.from(text).toString('base64') },
    };
  }

  test('finds unsubscribe URL in plain text', () => {
    expect(findUnsubscribeInBody(makePayload('Click here: https://example.com/unsubscribe?id=1')))
      .toBe('https://example.com/unsubscribe?id=1');
  });

  test('finds opt-out URL', () => {
    expect(findUnsubscribeInBody(makePayload('To stop emails visit https://example.com/opt-out')))
      .toBe('https://example.com/opt-out');
  });

  test('finds opt_out URL', () => {
    expect(findUnsubscribeInBody(makePayload('https://example.com/opt_out?u=abc')))
      .toBe('https://example.com/opt_out?u=abc');
  });

  test('strips trailing punctuation from URL', () => {
    expect(findUnsubscribeInBody(makePayload('Visit https://example.com/unsubscribe.')))
      .toBe('https://example.com/unsubscribe');
  });

  test('returns null when no unsubscribe link present', () => {
    expect(findUnsubscribeInBody(makePayload('Hello, this is a normal email with no links.')))
      .toBeNull();
  });

  test('returns null for null payload', () => {
    expect(findUnsubscribeInBody(null)).toBeNull();
  });
});
