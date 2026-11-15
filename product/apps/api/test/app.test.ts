import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { hashToken, parseSessionCookie, type Session, type SessionStore } from '../src/sessions.ts';
import { readConfig } from '../src/config.ts';

class FakeStore implements SessionStore {
  readonly records = new Map<string, Session>();
  async insert(input: Session & { tokenHash: string }): Promise<void> { this.records.set(input.tokenHash, input); }
  async findByTokenHash(tokenHash: string): Promise<Session | null> { return this.records.get(tokenHash) ?? null; }
  async revoke(tokenHash: string): Promise<void> { this.records.delete(tokenHash); }
}

const time = new Date('2026-11-13T10:00:00Z');
const origin = 'http://localhost:5173';

test('anonymous session uses an opaque HttpOnly cookie and ignores forged IDs', async () => {
  const store = new FakeStore();
  const app = await createApp({ sessions: store, ready: async () => true, publicOrigin: origin, production: true, now: () => time });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/sessions/anonymous', headers: { origin }, payload: { nickname: '小禾', userId: 'forged', role: 'speaker' } });
    assert.equal(response.statusCode, 400, 'strict input rejects client-supplied identity or role');
    const created = await app.inject({ method: 'POST', url: '/api/sessions/anonymous', headers: { origin }, payload: { nickname: '小禾' } });
    assert.equal(created.statusCode, 200);
    const cookie = created.headers['set-cookie'];
    assert.equal(typeof cookie, 'string');
    assert.match(cookie as string, /HttpOnly; SameSite=Lax; Path=\/; Max-Age=43200; Secure/);
    const token = parseSessionCookie(cookie as string);
    assert.ok(token);
    assert.equal(store.records.has(hashToken(token)), true);
    assert.equal(JSON.stringify(created.json()).includes(token), false, 'response body never exposes token');
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().nickname, '小禾');
    assert.equal(me.json().id, created.json().id);
    const reopened = await app.inject({ method: 'POST', url: '/api/sessions/anonymous', headers: { cookie, origin }, payload: {} });
    assert.deepEqual(reopened.json(), created.json());
    assert.equal(reopened.headers['set-cookie'], undefined);
    const loggedOut = await app.inject({ method: 'POST', url: '/api/sessions/logout', headers: { cookie, origin } });
    assert.equal(loggedOut.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode, 401);
  } finally { await app.close(); }
});

test('cross-origin mutations and expired sessions are denied', async () => {
  const store = new FakeStore();
  let current = time;
  const app = await createApp({ sessions: store, ready: async () => false, publicOrigin: origin, production: false, now: () => current });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/health/live' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 503);
    assert.equal((await app.inject({ method: 'POST', url: '/api/sessions/anonymous', headers: { origin: 'https://attacker.example' }, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/sessions/anonymous', payload: {} })).statusCode, 403);
    const created = await app.inject({ method: 'POST', url: '/api/sessions/anonymous', headers: { origin }, payload: {} });
    const cookie = created.headers['set-cookie'];
    assert.equal(typeof cookie, 'string');
    current = new Date(time.getTime() + 12 * 60 * 60 * 1000);
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode, 401);
  } finally { await app.close(); }
});

test('production rejects mock AI, missing encryption key and non-HTTPS origin without printing secrets', () => {
  const base = {
    NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://example.com', DATABASE_URL: 'postgres://localhost/echo', REDIS_URL: 'redis://localhost',
    S3_ENDPOINT: 'https://storage.example.com', S3_REGION: 'us-east-1', S3_BUCKET: 'echo-private', AI_MODE: 'mock',
  };
  expectConfigFailure(base, 'PUBLIC_ORIGIN');
  expectConfigFailure(base, 'ENCRYPTION_MASTER_KEY');
  expectConfigFailure(base, 'AI_MODE');
});

function expectConfigFailure(env: Record<string, string>, name: string) {
  assert.throws(() => readConfig(env), error => error instanceof Error && error.message.includes(name));
}
