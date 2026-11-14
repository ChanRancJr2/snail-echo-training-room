import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { PgSessionStore } from '../src/session-store-pg.ts';
import { PgRoomStore } from '../src/rooms.ts';
import { PgRoundStore } from '../src/rounds.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for room integration tests');
const origin = 'http://localhost:3100';

test('two clients prepare, start once, leave, and create a clean second room', async () => {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const deps = { sessions: new PgSessionStore(pool), rooms: new PgRoomStore(pool), rounds: new PgRoundStore(pool), publicOrigin: origin, production: false, ready: async () => true };
  const a = await createApp(deps);
  const b = await createApp(deps);
  const post = async (app: typeof a, path: string, cookie: string | undefined, payload: object) => app.inject({ method: 'POST', url: path, headers: { origin, ...(cookie ? { cookie } : {}) }, payload });
  try {
    const speaker = await post(a, '/api/sessions/anonymous', undefined, { nickname: '表达者' });
    const listener = await post(b, '/api/sessions/anonymous', undefined, { nickname: '复述者' });
    const stranger = await post(b, '/api/sessions/anonymous', undefined, { nickname: '陌生人' });
    const speakerCookie = speaker.headers['set-cookie'] as string;
    const listenerCookie = listener.headers['set-cookie'] as string;
    const strangerCookie = stranger.headers['set-cookie'] as string;
    const createKey = crypto.randomUUID();
    const created = await post(a, '/api/rooms', speakerCookie, { mode: 'sync', createKey });
    assert.equal(created.statusCode, 201);
    const { state, inviteToken } = created.json();
    assert.equal(state.members.length, 1);
    assert.equal(state.status, 'WAITING');
    assert.equal((await post(a, '/api/rooms', speakerCookie, { mode: 'sync', createKey })).json().state.id, state.id);
    assert.equal((await b.inject({ method: 'GET', url: `/api/rooms/${state.id}`, headers: { cookie: strangerCookie } })).statusCode, 403);
    const joined = await post(b, '/api/rooms/join', listenerCookie, { token: inviteToken });
    assert.equal(joined.statusCode, 200);
    assert.deepEqual(joined.json().members.map((m: { role: string }) => m.role), ['speaker', 'listener']);
    assert.equal((await post(b, '/api/rooms/join', strangerCookie, { token: inviteToken })).statusCode, 410);
    assert.equal((await post(b, `/api/rooms/${state.id}/start`, listenerCookie, {})).statusCode, 403);
    assert.equal((await post(a, `/api/rooms/${state.id}/start`, speakerCookie, {})).json().error, 'PLAYERS_NOT_READY');
    assert.equal((await post(a, `/api/rooms/${state.id}/ready`, speakerCookie, { ready: true })).statusCode, 200);
    assert.equal((await post(b, `/api/rooms/${state.id}/ready`, listenerCookie, { ready: true })).statusCode, 200);
    const starts = await Promise.all([post(a, `/api/rooms/${state.id}/start`, speakerCookie, {}), post(b, `/api/rooms/${state.id}/start`, speakerCookie, {})]);
    assert.deepEqual(starts.map(r => r.statusCode).sort(), [200, 409]);
    const active = await b.inject({ method: 'GET', url: `/api/rooms/${state.id}`, headers: { cookie: listenerCookie } });
    assert.equal(active.json().stage, 'TASK');
    assert.equal(active.json().status, 'ACTIVE');
    const roundId = active.json().roundId;
    assert.equal((await post(b, `/api/rounds/${roundId}/task`, listenerCookie, { expectedVersion: 1 })).statusCode, 403);
    assert.equal((await post(a, `/api/rounds/${roundId}/task`, speakerCookie, { expectedVersion: 2 })).statusCode, 409);
    const recording = await post(a, `/api/rounds/${roundId}/task`, speakerCookie, { expectedVersion: 1 });
    assert.equal(recording.statusCode, 200);
    assert.equal(recording.json().stage, 'SPEAKER_RECORDING');
    const deadline = recording.json().deadlineAt;
    assert.ok(Date.parse(deadline) > Date.now());
    assert.equal((await post(a, `/api/rounds/${roundId}/task`, speakerCookie, { expectedVersion: 1 })).statusCode, 409);
    assert.equal((await b.inject({ method: 'GET', url: `/api/rooms/${state.id}`, headers: { cookie: listenerCookie } })).json().deadlineAt, deadline);
    assert.equal((await post(b, `/api/rounds/${roundId}/restart-recording`, listenerCookie, { expectedVersion: 2, kind: 'speaker' })).statusCode, 403);
    const restarted = await post(a, `/api/rounds/${roundId}/restart-recording`, speakerCookie, { expectedVersion: 2, kind: 'speaker' });
    assert.equal(restarted.statusCode, 200);
    assert.equal(restarted.json().version, 3);
    assert.ok(Date.parse(restarted.json().deadlineAt) >= Date.parse(deadline));
    assert.equal((await post(a, `/api/rounds/${roundId}/restart-recording`, speakerCookie, { expectedVersion: 2, kind: 'speaker' })).statusCode, 409);
    assert.equal((await b.inject({ method: 'GET', url: `/api/rooms/${state.id}`, headers: { cookie: listenerCookie } })).json().deadlineAt, restarted.json().deadlineAt);
    const past = new Date(Date.now() - 31000);
    await pool.query("UPDATE rounds SET deadline_at=$2, snapshot=jsonb_set(snapshot,'{deadlineAt}',to_jsonb($3::text)) WHERE id=$1", [roundId, past, past.toISOString()]);
    await deps.rooms.sweepExpiredRounds(new Date());
    const expired = (await b.inject({ method: 'GET', url: `/api/rooms/${state.id}`, headers: { cookie: listenerCookie } })).json();
    assert.equal(expired.stage, 'CANCELLED');
    assert.equal(expired.terminalReason, 'TIMEOUT');
    assert.equal(expired.status, 'WAITING');
    assert.ok(expired.members.every((member: { ready: boolean }) => !member.ready));
    assert.equal((await post(a, `/api/rooms/${state.id}/leave`, speakerCookie, {})).json().status, 'CLOSED');
    assert.equal((await b.inject({ method: 'GET', url: `/api/rooms/${state.id}`, headers: { cookie: listenerCookie } })).statusCode, 403);
    const closed = await pool.query('SELECT status FROM rooms WHERE id = $1', [state.id]);
    assert.equal(closed.rows[0].status, 'CLOSED');
    const second = await post(b, '/api/rooms', listenerCookie, { mode: 'sync', createKey: crypto.randomUUID() });
    assert.equal(second.statusCode, 201);
    assert.notEqual(second.json().state.id, state.id);
    assert.equal(second.json().state.members.length, 1);
    assert.equal(second.json().state.members[0].ready, false);
    for (let attempt = 0; attempt < 12; attempt++) await post(a, '/api/sessions/anonymous', undefined, {});
    const limited = await post(a, '/api/sessions/anonymous', undefined, {});
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error, 'RATE_LIMITED');
  } finally { await Promise.all([a.close(), b.close()]); await pool.end(); }
});

test('password invitation, observer restriction, concurrent join, and listener reset', async () => {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const deps = { sessions: new PgSessionStore(pool), rooms: new PgRoomStore(pool), publicOrigin: origin, production: false, ready: async () => true };
  const app = await createApp(deps);
  const post = async (path: string, cookie: string | undefined, payload: object) => app.inject({ method: 'POST', url: path, headers: { origin, ...(cookie ? { cookie } : {}) }, payload });
  try {
    const cookies = await Promise.all(['主持', '观察', '复述', '竞争者'].map(async nickname => (await post('/api/sessions/anonymous', undefined, { nickname })).headers['set-cookie'] as string));
    const room = (await post('/api/rooms', cookies[0], { mode: 'sync', createKey: crypto.randomUUID() })).json();
    const id = room.state.id;
    const invite = (await post(`/api/rooms/${id}/invitations`, cookies[0], { role: 'observer', minutes: 5, maxUses: 1, password: 'safe1234' })).json();
    assert.equal((await post('/api/rooms/join', cookies[1], { token: invite.token, password: 'wrong123' })).statusCode, 403);
    assert.equal((await post('/api/rooms/join', cookies[1], { token: invite.token, password: 'safe1234' })).statusCode, 200);
    assert.equal((await post(`/api/rooms/${id}/ready`, cookies[1], { ready: true })).json().you.ready, true);
    const joins = await Promise.all([post('/api/rooms/join', cookies[2], { token: room.inviteToken }), post('/api/rooms/join', cookies[3], { token: room.inviteToken })]);
    assert.deepEqual(joins.map(r => r.statusCode).sort(), [200, 410]);
    const winnerCookie = joins[0].statusCode === 200 ? cookies[2] : cookies[3];
    assert.equal((await post(`/api/rooms/${id}/ready`, cookies[0], { ready: true })).statusCode, 200);
    assert.equal((await post(`/api/rooms/${id}/ready`, winnerCookie, { ready: true })).statusCode, 200);
    assert.equal((await post(`/api/rooms/${id}/start`, cookies[0], {})).statusCode, 200);
    assert.equal((await post(`/api/rooms/${id}/leave`, winnerCookie, {})).json().status, 'LEFT');
    const reset = (await app.inject({ method: 'GET', url: `/api/rooms/${id}`, headers: { cookie: cookies[0] } })).json();
    assert.equal(reset.status, 'WAITING');
    assert.equal(reset.stage, null);
    assert.equal(reset.members.find((m: { role: string }) => m.role === 'speaker').ready, false);
  } finally { await app.close(); await pool.end(); }
});

test('logging out closes a hosted room and cannot resurrect it with the same create key', async () => {
  const pool = new pg.Pool({ connectionString: url });
  const app = await createApp({ sessions: new PgSessionStore(pool), rooms: new PgRoomStore(pool), publicOrigin: origin, production: false, ready: async () => true });
  const post = (path: string, cookie: string | undefined, payload: object) => app.inject({ method: 'POST', url: path, headers: { origin, ...(cookie ? { cookie } : {}) }, payload });
  try {
    const cookie = (await post('/api/sessions/anonymous', undefined, {})).headers['set-cookie'] as string;
    const createKey = crypto.randomUUID();
    const created = (await post('/api/rooms', cookie, { mode: 'solo', createKey })).json();
    await post('/api/sessions/logout', cookie, {});
    const status = (await pool.query('SELECT status FROM rooms WHERE id = $1', [created.state.id])).rows[0].status;
    assert.equal(status, 'CLOSED');
    assert.equal((await post('/api/rooms', cookie, { mode: 'solo', createKey })).statusCode, 401);
  } finally { await app.close(); await pool.end(); }
});

test('expired host session is swept and its room is closed', async () => {
  const pool = new pg.Pool({ connectionString: url });
  const sessions = new PgSessionStore(pool);
  const rooms = new PgRoomStore(pool);
  const app = await createApp({ sessions, rooms, publicOrigin: origin, production: false, ready: async () => true });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/sessions/anonymous', headers: { origin }, payload: {} });
    const cookie = created.headers['set-cookie'] as string;
    const room = await app.inject({ method: 'POST', url: '/api/rooms', headers: { origin, cookie }, payload: { mode: 'solo', createKey: crypto.randomUUID() } });
    await pool.query('UPDATE sessions SET expires_at = now() - interval \'1 second\' WHERE id = $1', [created.json().id]);
    assert.ok(await rooms.sweepExpiredSessions(new Date()) >= 1);
    assert.equal((await pool.query('SELECT status FROM rooms WHERE id = $1', [room.json().state.id])).rows[0].status, 'CLOSED');
  } finally { await app.close(); await pool.end(); }
});
