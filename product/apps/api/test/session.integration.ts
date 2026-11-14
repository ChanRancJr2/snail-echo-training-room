import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { Redis } from 'ioredis';
import { createApp } from '../src/app.ts';
import { PgSessionStore } from '../src/session-store-pg.ts';

const dbUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!dbUrl || !redisUrl) throw new Error('DATABASE_URL and REDIS_URL are required for integration tests');

test('two API instances share revocable sessions through PostgreSQL and check Redis readiness', async () => {
  const pool = new pg.Pool({ connectionString: dbUrl });
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  const deps = { sessions: new PgSessionStore(pool), publicOrigin: 'http://localhost:5173', production: false, ready: async () => {
    const [db, cache] = await Promise.all([pool.query('SELECT 1'), redis.ping()]);
    return db.rowCount === 1 && cache === 'PONG';
  } };
  const first = await createApp(deps);
  const second = await createApp(deps);
  try {
    assert.equal((await first.inject({ method: 'GET', url: '/health/ready' })).statusCode, 200);
    const created = await first.inject({ method: 'POST', url: '/api/sessions/anonymous', headers: { origin: deps.publicOrigin }, payload: { nickname: '跨实例测试' } });
    assert.equal(created.statusCode, 200);
    const cookie = created.headers['set-cookie'];
    assert.equal(typeof cookie, 'string');
    const otherInstance = await second.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    assert.equal(otherInstance.statusCode, 200);
    assert.equal(otherInstance.json().id, created.json().id);
    await second.inject({ method: 'POST', url: '/api/sessions/logout', headers: { cookie, origin: deps.publicOrigin } });
    assert.equal((await first.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode, 401);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await Promise.all([redis.quit(), pool.end()]);
  }
});
