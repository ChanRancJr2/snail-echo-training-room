import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { createAnonymousSession, expiredCookie, findSession, hashToken, parseSessionCookie, sessionCookie, type SessionStore } from './sessions.ts';
import { registerRoomRoutes } from './room-routes.ts';
import type { PgRoomStore } from './rooms.ts';
import type { PgRoundStore } from './rounds.ts';
import type { PgUploadStore } from './uploads.ts';
import type { PgPointStore } from './points.ts';
import type { PgComparisonStore } from './comparisons.ts';
import type { PgReviewStore } from './reviews.ts';
import type { PgDeletionStore } from './deletions.ts';

const sessionBody = z.object({ nickname: z.string().trim().max(20).optional() }).strict();

export interface AppDependencies {
  sessions: SessionStore;
  rooms?: PgRoomStore;
  rounds?: PgRoundStore;
  uploads?: PgUploadStore | undefined;
  points?: PgPointStore | undefined;
  comparisons?: PgComparisonStore | undefined;
  reviews?: PgReviewStore | undefined;
  deletions?: PgDeletionStore | undefined;
  ready: () => Promise<boolean>;
  publicOrigin: string;
  production: boolean;
  trustedProxy?: string | undefined;
  mediaOrigin?: string | undefined;
  now?: () => Date;
}

export async function createApp(deps: AppDependencies) {
  const app = Fastify({ logger: { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'] }, bodyLimit: 16 * 1024, trustProxy: deps.trustedProxy ?? false });
  const currentTime = deps.now ?? (() => new Date());
  const media = deps.mediaOrigin ? [new URL(deps.mediaOrigin).origin] : [];
  await app.register(helmet, { contentSecurityPolicy: deps.production ? { directives: {
    connectSrc: ["'self'", ...media], mediaSrc: ["'self'", 'blob:', ...media], objectSrc: ["'none'"],
  } } : false });
  await app.register(rateLimit, { global: false, keyGenerator: async request =>
    (await findSession(deps.sessions, request.headers.cookie, currentTime()))?.id ?? request.ip });

  app.addHook('onRequest', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin !== deps.publicOrigin) {
      reply.code(403).send({ error: 'ORIGIN_DENIED' });
    }
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    if (!await deps.ready()) return reply.code(503).send({ status: 'unavailable' });
    return { status: 'ok' };
  });

  app.post('/api/sessions/anonymous', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const current = await findSession(deps.sessions, request.headers.cookie, currentTime());
    if (current && await deps.rooms?.childHandoff(current.id)) return reply.code(403).send({ error: 'GUARDIAN_REQUIRED' });
    const parsed = sessionBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const { session, token } = await createAnonymousSession(deps.sessions, parsed.data.nickname ?? '访客', currentTime());
    reply.header('Set-Cookie', sessionCookie(token, deps.production));
    return { id: session.id, nickname: session.nickname, expiresAt: session.expiresAt.toISOString() };
  });

  app.get('/api/me', async (request, reply) => {
    const session = await findSession(deps.sessions, request.headers.cookie, currentTime());
    if (!session) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const handoff = await deps.rooms?.childHandoff(session.id);
    reply.header('Cache-Control', 'no-store');
    return { id: session.id, nickname: session.nickname, expiresAt: session.expiresAt.toISOString(), ...(handoff ? { handoffRoomId: handoff.roomId } : {}) };
  });

  app.post('/api/sessions/logout', async (request, reply) => {
    const token = parseSessionCookie(request.headers.cookie);
    if (token) {
      const session = await findSession(deps.sessions, request.headers.cookie, currentTime());
      if (session && await deps.rooms?.childHandoff(session.id)) return reply.code(403).send({ error: 'GUARDIAN_REQUIRED' });
      if (session && deps.rooms) await deps.rooms.leaveAll(session.id);
      await deps.sessions.revoke(hashToken(token));
    }
    reply.header('Set-Cookie', expiredCookie(deps.production));
    return { status: 'ok' };
  });

  if (deps.rooms) registerRoomRoutes(app, deps.rooms, deps.sessions, currentTime, deps.rounds, deps.uploads, deps.points, deps.comparisons, deps.reviews, deps.deletions);

  return app;
}
