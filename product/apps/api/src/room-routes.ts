import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { findSession, type SessionStore } from './sessions.ts';
import { inviteErrorMessage, PgRoomStore, RoomError } from './rooms.ts';
import { PgRoundStore, roundErrorResponse } from './rounds.ts';
import type { PgUploadStore } from './uploads.ts';
import type { PgPointStore } from './points.ts';
import type { PgComparisonStore } from './comparisons.ts';
import type { PgReviewStore } from './reviews.ts';
import type { PgDeletionStore } from './deletions.ts';

const mode = z.enum(['sync', 'solo', 'teen', 'async']);
const uuid = z.uuid();
const teen = z.object({ nickname: z.string().trim().min(1).max(12), role: z.enum(['speaker', 'listener']), pin: z.string().regex(/^\d{6}$/), consent: z.literal(true) }).strict();
const createBody = z.object({ mode, createKey: z.string().min(8).max(100), durationSeconds: z.union([z.literal(30), z.literal(60), z.literal(120), z.literal(300)]).default(30), retellStyle: z.enum(['auditory', 'keywords']).default('auditory'), topic: z.string().trim().min(1).max(80).default('家庭日常'), teen: teen.optional() }).strict()
  .refine(body => (body.mode === 'teen') === Boolean(body.teen));
const inviteBody = z.object({ role: z.enum(['listener', 'observer']), minutes: z.number().int().min(5).max(10080), maxUses: z.number().int().min(1).max(10), password: z.string().min(6).max(100).nullable().default(null) }).strict();
const password = z.string().max(100).nullable().default(null);
const joinBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password }).strict();
const readyBody = z.object({ ready: z.boolean() }).strict();

export function registerRoomRoutes(app: FastifyInstance, rooms: PgRoomStore, sessions: SessionStore, now: () => Date, rounds?: PgRoundStore, uploads?: PgUploadStore, points?: PgPointStore, comparisons?: PgComparisonStore, reviews?: PgReviewStore, deletions?: PgDeletionStore) {
  app.setErrorHandler((error, _request, reply) => {
    const roundError = roundErrorResponse(error);
    if (roundError) return reply.code(roundError.httpStatus).send({ error: roundError.code });
    if (error instanceof RoomError) {
      const invitation = ['INVITE_NOT_FOUND', 'INVITATION_EXPIRED'].includes(error.code);
      return reply.code(error.httpStatus).send({ error: error.code, ...(invitation ? { message: inviteErrorMessage } : {}) });
    }
    if (typeof error === 'object' && error && 'statusCode' in error && error.statusCode === 429) {
      return reply.code(429).send({ error: 'RATE_LIMITED', retryAfter: reply.getHeader('retry-after') ?? 60 });
    }
    app.log.error(error);
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });
  const authenticated = async (cookie: string | undefined) => {
    const session = await findSession(sessions, cookie, now());
    if (!session) throw new RoomError('UNAUTHENTICATED', 401);
    return session;
  };
  app.addHook('preHandler', async (request, reply) => {
    const path = request.routeOptions.url;
    // Session bootstrap lets the child restore their current seat. Its handler
    // independently blocks creating a new named session during handoff.
    if (!path?.startsWith('/api/') || path === '/api/me' || path === '/api/sessions/anonymous') return;
    const session = await findSession(sessions, request.headers.cookie, now());
    if (!session) return;
    const handoff = await rooms.childHandoff(session.id);
    if (!handoff) return;
    const params = request.params as { roomId?: string; roundId?: string } | undefined;
    if (params?.roomId === handoff.roomId && ['/api/rooms/:roomId', '/api/rooms/:roomId/guardian/unlock'].includes(path)) return;
    if (params?.roundId === handoff.roundId) {
      const shared = ['/api/rounds/:roundId/restart-recording', '/api/rounds/:roundId/uploads', '/api/rounds/:roundId/uploads/:audioId/commit'];
      const allowed = handoff.role === 'speaker'
        ? [...shared, '/api/rounds/:roundId/task', '/api/rounds/:roundId/speaker-transcript', '/api/rounds/:roundId/points/confirm']
        : [...shared, '/api/rounds/:roundId/audio/:audioId/access', '/api/rounds/:roundId/points', '/api/rounds/:roundId/listening-aid'];
      if (allowed.includes(path) && (handoff.role === 'speaker' ? ['TASK', 'SPEAKER_RECORDING', 'KEYPOINT_CONFIRM'].includes(handoff.stage) : handoff.stage === 'LISTENER_RETELL')) return;
    }
    return reply.code(403).send({ error: 'GUARDIAN_REQUIRED' });
  });
  app.get('/api/history', async (request, reply) => {
    const session = await authenticated(request.headers.cookie);
    reply.header('Cache-Control', 'no-store');
    return rooms.history(session.id);
  });
  if (deletions) {
    const target = z.object({ scope: z.enum(['round', 'room', 'all']), targetId: uuid.nullable() });
    const validTarget = (body: z.infer<typeof target>) => (body.targetId === null) === (body.scope === 'all');
    app.post('/api/history/deletion-preview', async (request, reply) => {
      const body = target.strict().refine(validTarget).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
      const session = await authenticated(request.headers.cookie);
      const { roundIds, roomIds } = await deletions.preview(session.id, body.data.scope, body.data.targetId);
      return { count: roundIds.length, rooms: roomIds.length };
    });
    app.post('/api/history/delete', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
      const body = target.extend({ count: z.number().int().nonnegative(), confirm: z.literal(true) }).strict().refine(validTarget).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
      const session = await authenticated(request.headers.cookie);
      return deletions.remove(session.id, body.data.scope, body.data.targetId, body.data.count);
    });
  }
  app.post('/api/rooms', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    const created = await rooms.create(session.id, parsed.data.mode, parsed.data.createKey, parsed.data);
    return reply.code(created.inviteToken ? 201 : 200).send(created);
  });
  app.get('/api/rooms/:roomId', async (request, reply) => {
    const parsed = uuid.safeParse((request.params as { roomId: string }).roomId);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    reply.header('Cache-Control', 'no-store');
    return rooms.state(parsed.data, session.id);
  });
  app.post('/api/rooms/:roomId/guardian/handoff', async (request, reply) => {
    const roomId = uuid.safeParse((request.params as { roomId: string }).roomId);
    if (!roomId.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    return rooms.enterChild(roomId.data, session.id);
  });
  app.post('/api/rooms/:roomId/guardian/unlock', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const roomId = uuid.safeParse((request.params as { roomId: string }).roomId);
    const body = z.object({ pin: z.string().regex(/^\d{6}$/) }).strict().safeParse(request.body);
    if (!roomId.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    return rooms.unlockChild(roomId.data, session.id, body.data.pin);
  });
  app.post('/api/rooms/:roomId/invitations', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const roomId = uuid.safeParse((request.params as { roomId: string }).roomId);
    const body = inviteBody.safeParse(request.body);
    if (!roomId.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    const invitation = await rooms.invite(roomId.data, session.id, body.data.role, body.data.minutes, body.data.maxUses, body.data.password);
    return reply.code(201).send({ ...invitation, role: body.data.role, minutes: body.data.minutes, maxUses: body.data.maxUses });
  });
  app.post('/api/rooms/join', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = joinBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT', message: inviteErrorMessage });
    const session = await authenticated(request.headers.cookie);
    return rooms.join(session.id, parsed.data.token, parsed.data.password);
  });
  app.post('/api/rooms/:roomId/ready', async (request, reply) => {
    const roomId = uuid.safeParse((request.params as { roomId: string }).roomId);
    const body = readyBody.safeParse(request.body);
    if (!roomId.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    return rooms.ready(roomId.data, session.id, body.data.ready);
  });
  app.post('/api/rooms/:roomId/start', async (request, reply) => {
    const roomId = uuid.safeParse((request.params as { roomId: string }).roomId);
    if (!roomId.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    return rooms.start(roomId.data, session.id);
  });
  app.post('/api/rooms/:roomId/next-round', async (request, reply) => {
    const roomId = uuid.safeParse((request.params as { roomId: string }).roomId);
    const body = z.object({ roundId: uuid, expectedVersion: z.number().int().positive() }).strict().safeParse(request.body);
    if (!roomId.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    return rooms.prepareNext(roomId.data, body.data.roundId, session.id, body.data.expectedVersion);
  });
  app.post('/api/rooms/:roomId/swap-seats', async (request, reply) => {
    const id = uuid.safeParse((request.params as { roomId: string }).roomId);
    const body = z.object({ expectedVersion: z.number().int().positive() }).strict().safeParse(request.body);
    if (!id.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    return rooms.swapSeats(id.data, session.id, body.data.expectedVersion);
  });
  app.post('/api/rooms/:roomId/leave', async (request, reply) => {
    const roomId = uuid.safeParse((request.params as { roomId: string }).roomId);
    if (!roomId.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    return rooms.leave(roomId.data, session.id);
  });
  if (rounds) app.post('/api/rounds/:roundId/task', async (request, reply) => {
    const roundId = uuid.safeParse((request.params as { roundId: string }).roundId);
    const body = z.object({ expectedVersion: z.number().int().positive(), focus: z.string().trim().max(80).default('') }).strict().safeParse(request.body);
    if (!roundId.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    return rounds.apply(roundId.data, session.id, body.data.expectedVersion, { type: 'task-set' }, now(), body.data.focus);
  });
  if (rounds) app.post('/api/rounds/:roundId/listening-aid', async (request, reply) => {
    const roundId = uuid.safeParse((request.params as { roundId: string }).roundId);
    const body = z.object({ kind: z.enum(['replay', 'keywords']) }).strict().safeParse(request.body);
    if (!roundId.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    await rounds.useListeningAid(roundId.data, session.id, body.data.kind);
    return { status: 'ok' };
  });
  if (rounds) app.post('/api/rounds/:roundId/open-message', async (request, reply) => {
    const roundId = uuid.safeParse((request.params as { roundId: string }).roundId);
    const body = z.object({ expectedVersion: z.number().int().positive() }).strict().safeParse(request.body);
    if (!roundId.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    return rounds.apply(roundId.data, session.id, body.data.expectedVersion, { type: 'async-opened' }, now());
  });
  if (rounds) app.post('/api/rounds/:roundId/restart-recording', async (request, reply) => {
    const roundId = uuid.safeParse((request.params as { roundId: string }).roundId);
    const body = z.object({ expectedVersion: z.number().int().positive(), kind: z.enum(['speaker', 'listener']) }).strict().safeParse(request.body);
    if (!roundId.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    return rounds.apply(roundId.data, session.id, body.data.expectedVersion, { type: 'recording-restarted', kind: body.data.kind }, now());
  });
  if (uploads) {
    app.get('/api/rounds/:roundId/audio/:audioId/access', async (request, reply) => {
      const params = request.params as { roundId: string; audioId: string };
      const roundId = uuid.safeParse(params.roundId);
      const audioId = uuid.safeParse(params.audioId);
      if (!roundId.success || !audioId.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
      const session = await authenticated(request.headers.cookie);
      reply.header('Cache-Control', 'no-store');
      return uploads.access(roundId.data, audioId.data, session.id);
    });
    app.post('/api/rounds/:roundId/uploads', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
      const roundId = uuid.safeParse((request.params as { roundId: string }).roundId);
      const body = z.object({ kind: z.enum(['speaker', 'listener']), mimeType: z.string().max(100), byteSize: z.number().int().positive(), idempotencyKey: z.string().min(8).max(100) }).strict().safeParse(request.body);
      if (!roundId.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
      const session = await authenticated(request.headers.cookie);
      return uploads.request(roundId.data, session.id, body.data.kind, body.data.mimeType, body.data.byteSize, body.data.idempotencyKey);
    });
    app.post('/api/rounds/:roundId/uploads/:audioId/commit', async (request, reply) => {
      const params = request.params as { roundId: string; audioId: string };
      const roundId = uuid.safeParse(params.roundId);
      const audioId = uuid.safeParse(params.audioId);
      const body = z.object({ expectedVersion: z.number().int().positive(), transcribe: z.boolean().default(false), consentToTranscribe: z.boolean().default(false) }).strict().safeParse(request.body);
      if (!roundId.success || !audioId.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
      const session = await authenticated(request.headers.cookie);
      return uploads.commit(roundId.data, session.id, audioId.data, body.data.expectedVersion, body.data.transcribe, body.data.consentToTranscribe);
    });
  }
  if (points) {
    app.get('/api/rounds/:roundId/speaker-transcript', async (request, reply) => {
      const roundId = uuid.safeParse((request.params as { roundId: string }).roundId);
      if (!roundId.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
      const session = await authenticated(request.headers.cookie);
      reply.header('Cache-Control', 'no-store');
      return points.speakerTranscript(roundId.data, session.id);
    });
    app.post('/api/rounds/:roundId/points/confirm', async (request, reply) => {
      const roundId = uuid.safeParse((request.params as { roundId: string }).roundId);
      const body = z.object({ expectedVersion: z.number().int().positive(), points: z.array(z.object({ category: z.enum(['人物', '事件', '需求', '情绪', '因果', '重点', '时间']), text: z.string().trim().min(1).max(200) }).strict()).min(1).max(12) }).strict().safeParse(request.body);
      if (!roundId.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
      const session = await authenticated(request.headers.cookie);
      return points.confirm(roundId.data, session.id, body.data.expectedVersion, body.data.points);
    });
    app.get('/api/rounds/:roundId/points', async (request, reply) => {
      const roundId = uuid.safeParse((request.params as { roundId: string }).roundId);
      if (!roundId.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
      const session = await authenticated(request.headers.cookie);
      reply.header('Cache-Control', 'no-store');
      return points.list(roundId.data, session.id);
    });
  }
  if (comparisons) app.get('/api/rounds/:roundId/comparison', async (request, reply) => {
    const roundId = uuid.safeParse((request.params as { roundId: string }).roundId);
    if (!roundId.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const session = await authenticated(request.headers.cookie);
    reply.header('Cache-Control', 'no-store');
    return comparisons.view(roundId.data, session.id);
  });
  if (reviews) {
    const label = z.enum(['遗漏重要信息', '理解不到位', '理解偏了', '杜撰信息', '强加信息', '我表达不清', '我言不达意', '语气被误解', '重点被误解', 'AI 误判']);
    const resolution = z.enum(['misunderstanding', 'expression', 'ai_error']);
    const version = z.number().int().positive();
    const command = async (request: FastifyRequest, reply: FastifyReply, schema: z.ZodTypeAny, make: (body: any) => Parameters<PgReviewStore['apply']>[3]) => {
      const roundId = uuid.safeParse((request.params as { roundId: string }).roundId);
      const body = schema.safeParse(request.body);
      if (!roundId.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
      const session = await authenticated(request.headers.cookie);
      return reviews.apply(roundId.data, session.id, (body.data as { expectedVersion: number }).expectedVersion, make(body.data));
    };
    app.post('/api/rounds/:roundId/review/label', async (request, reply) => command(request, reply,
      z.object({ expectedVersion: version, labels: z.array(z.object({ issueId: uuid, tag: label, resolution }).strict()).max(12) }).strict(),
      body => ({ type: 'speaker-labeled', labels: body.labels })));
    app.post('/api/rounds/:roundId/review/confirm', async (request, reply) => command(request, reply,
      z.object({ expectedVersion: version, issueId: uuid }).strict(), body => ({ type: 'issue-confirmed', issueId: body.issueId })));
    app.post('/api/rounds/:roundId/review/clarify', async (request, reply) => command(request, reply,
      z.object({ expectedVersion: version, issueId: uuid, note: z.string().trim().min(1).max(500) }).strict(),
      body => ({ type: 'listener-clarified', issueId: body.issueId, note: body.note })));
    app.post('/api/rounds/:roundId/review/observe', async (request, reply) => command(request, reply,
      z.object({ expectedVersion: version, issueId: uuid, tag: label, note: z.string().trim().max(500) }).strict(),
      body => ({ type: 'observer-annotated', issueId: body.issueId, tag: body.tag, note: body.note })));
    app.post('/api/rounds/:roundId/review/revise', async (request, reply) => command(request, reply,
      z.object({ expectedVersion: version, issueId: uuid, tag: label, resolution }).strict(),
      body => ({ type: 'issue-revised', issueId: body.issueId, tag: body.tag, resolution: body.resolution })));
    app.post('/api/rounds/:roundId/review/submit', async (request, reply) => command(request, reply,
      z.object({ expectedVersion: version }).strict(), () => ({ type: 'confirmations-submitted' })));
    app.post('/api/rounds/:roundId/review/adopt', async (request, reply) => command(request, reply,
      z.object({ expectedVersion: version }).strict(), () => ({ type: 'advice-accepted' })));
    app.post('/api/rounds/:roundId/review/switch-seat', async (request, reply) => command(request, reply,
      z.object({ expectedVersion: version, seat: z.enum(['speaker', 'listener']) }).strict(),
      body => ({ type: 'seat-switched', seat: body.seat })));
  }
}
