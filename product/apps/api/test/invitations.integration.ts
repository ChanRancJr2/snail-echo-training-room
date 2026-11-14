import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { PgRoomStore } from '../src/rooms.ts';
import { PgSessionStore } from '../src/session-store-pg.ts';

test('only invitation links can grant a seat, including links issued by the previous release', async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const origin = 'http://localhost:3100';
  const app = await createApp({ rooms: new PgRoomStore(pool), sessions: new PgSessionStore(pool), publicOrigin: origin, production: false, ready: async () => true });
  const post = (url: string, payload: object, cookie?: string) => app.inject({ method: 'POST', url, payload, headers: { origin, ...(cookie ? { cookie } : {}) } });
  const session = async () => String((await post('/api/sessions/anonymous', {})).headers['set-cookie']).split(';')[0]!;
  try {
    const host = await session();
    const guest = await session();
    const outsider = await session();
    const created = (await post('/api/rooms', { mode: 'sync', createKey: randomUUID() }, host)).json();
    const id = created.state.id;
    assert.match(created.inviteToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(created.inviteCode, undefined);
    const options = { role: 'observer', minutes: 60, maxUses: 1, password: 'safe1234' };
    const invite = (await post(`/api/rooms/${id}/invitations`, options, host)).json();
    assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(invite.code, undefined);
    assert.equal((await post('/api/rooms/join', { code: 'ABCDE2' }, guest)).statusCode, 400);
    assert.equal((await post('/api/rooms/join', { token: invite.token, code: 'ABCDE2' }, guest)).statusCode, 400);
    assert.equal((await post('/api/rooms/join', { token: invite.token, password: 'incorrect' }, guest)).statusCode, 403);
    const joined = await post('/api/rooms/join', { token: invite.token, password: options.password }, guest);
    assert.equal(joined.statusCode, 200);
    assert.equal(joined.json().you.role, 'observer');
    assert.equal((await post('/api/rooms/join', { token: invite.token }, guest)).json().you.memberId, joined.json().you.memberId);
    assert.equal((await post('/api/rooms/join', { token: invite.token, password: options.password }, outsider)).statusCode, 410);
    const legacy = randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO invitations (id, room_id, token_hash, expires_at, max_uses, code) VALUES ($1,$2,$3,now()+interval '1 hour',1,$4)",
      [randomUUID(), id, createHash('sha256').update(legacy).digest('hex'), randomBytes(3).toString('hex').toUpperCase().replace(/[01]/g, 'Z')]);
    assert.equal((await post('/api/rooms/join', { token: legacy }, outsider)).json().you.role, 'listener');
    assert.equal((await post(`/api/rooms/${id}/leave`, {}, host)).statusCode, 200);
    assert.equal((await post('/api/rooms/join', { token: created.inviteToken }, outsider)).statusCode, 410);
  } finally { await app.close(); await pool.end(); }
});
