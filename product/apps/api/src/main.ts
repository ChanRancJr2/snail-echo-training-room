import pg from 'pg';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { Redis } from 'ioredis';
import { createApp } from './app.ts';
import { readConfig } from './config.ts';
import { PgSessionStore } from './session-store-pg.ts';
import { PgRoomStore } from './rooms.ts';
import { PgRoundStore } from './rounds.ts';
import { S3AudioStorage } from './audio-storage.ts';
import { PgUploadStore } from './uploads.ts';
import { TextCipher } from './crypto.ts';
import { PgPointStore } from './points.ts';
import { PgComparisonStore } from './comparisons.ts';
import { PgReviewStore } from './reviews.ts';
import { PgDeletionStore } from './deletions.ts';

try { process.loadEnvFile('.env'); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const config = readConfig(process.env);
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 20, idleTimeoutMillis: 30_000 });
const rooms = new PgRoomStore(pool);
const cipher = config.ENCRYPTION_MASTER_KEY ? new TextCipher(config.ENCRYPTION_MASTER_KEY) : null;
const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
await redis.connect();

const app = await createApp({
  sessions: new PgSessionStore(pool),
  rooms,
  rounds: new PgRoundStore(pool, cipher ?? undefined),
  uploads: config.S3_ACCESS_KEY && config.S3_SECRET_KEY ? new PgUploadStore(pool, new S3AudioStorage({ endpoint: config.S3_ENDPOINT, publicEndpoint: config.S3_PUBLIC_ENDPOINT, region: config.S3_REGION, bucket: config.S3_BUCKET, accessKey: config.S3_ACCESS_KEY, secretKey: config.S3_SECRET_KEY })) : undefined,
  points: cipher ? new PgPointStore(pool, cipher) : undefined,
  comparisons: cipher ? new PgComparisonStore(pool, cipher) : undefined,
  reviews: new PgReviewStore(pool, cipher ?? undefined),
  deletions: new PgDeletionStore(pool),
  publicOrigin: config.PUBLIC_ORIGIN,
  production: config.NODE_ENV === 'production',
  trustedProxy: process.env.TRUSTED_PROXY,
  mediaOrigin: config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT,
  ready: async () => {
    try {
      const [db, cache] = await Promise.all([pool.query('SELECT 1'), redis.ping()]);
      return db.rowCount === 1 && cache === 'PONG';
    } catch { return false; }
  },
});

if (process.env.WEB_ROOT) await app.register(fastifyStatic, {
  root: resolve(process.env.WEB_ROOT),
  setHeaders(response, path) {
    response.header('Cache-Control', path.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable');
  },
});

const close = async () => {
  clearInterval(sweeper);
  clearInterval(roundSweeper);
  await app.close();
  await Promise.all([pool.end(), redis.quit()]);
};
const sweeper = setInterval(() => { void rooms.sweepExpiredSessions(new Date()).catch(error => app.log.error({ error }, 'session sweep failed')); }, 60_000);
const roundSweeper = setInterval(() => { void rooms.sweepExpiredRounds(new Date()).catch(error => app.log.error({ error }, 'round sweep failed')); }, 10_000);
process.once('SIGTERM', () => { void close().then(() => process.exit(0)); });
process.once('SIGINT', () => { void close().then(() => process.exit(0)); });
await app.listen({ host: '0.0.0.0', port: config.PORT });
