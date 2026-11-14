import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { applyRoundCommand, isSameDevice, newRound, type Mode, type Role, type Round } from '../../../packages/core/src/round.ts';

export class RoomError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus: number) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
const deny = (code: string, status = 409): never => { throw new RoomError(code, status); };
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export const inviteErrorMessage = '邀请无效或已过期，请让发起人重新生成';
type TeenSettings = { nickname: string; role: 'speaker' | 'listener'; pin: string; consent: true };
type Invitation = { id: string; room_id: string; role: 'listener' | 'observer'; password_hash: string | null; expires_at: Date; max_uses: number; use_count: number; revoked_at: Date | null };
const derive = promisify(scrypt);
const passwordHash = async (password: string) => {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${((await derive(password, salt, 32)) as Buffer).toString('hex')}`;
};
const matchesPassword = async (password: string, encoded: string) => {
  const [salt, hash] = encoded.split(':');
  if (!salt || !hash) return false;
  const candidate = (await derive(password, Buffer.from(salt, 'hex'), 32)) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
};

export interface RoomState {
  id: string;
  mode: Mode;
  status: 'WAITING' | 'ACTIVE' | 'CLOSED';
  durationSeconds: number;
  retellStyle: 'auditory' | 'keywords';
  topic: string;
  version: number;
  roundId: string | null;
  stage: string | null;
  deadlineAt: string | null;
  roundVersion: number | null;
  terminalReason: Round['terminalReason'] | null;
  activeSeat: Round['activeSeat'] | null;
  speakerAudioId: string | null;
  listenerAudioId: string | null;
  previousPractice: { complete: number; total: number } | null;
  teen: { nickname: string; role: 'speaker' | 'listener'; locked: boolean; completed: boolean } | null;
  you: { memberId: string; role: Role; ready: boolean };
  members: { id: string; nickname: string; role: Role; ready: boolean }[];
}

export class PgRoomStore {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  private async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }

  async state(roomId: string, sessionId: string, db: Pool | PoolClient = this.pool): Promise<RoomState> {
    const room = (await db.query<{ id: string; mode: Mode; status: RoomState['status']; version: string; duration_seconds: number; retell_style: 'auditory' | 'keywords'; topic: string }>(
      'SELECT id, mode, status, version, duration_seconds, retell_style, topic FROM rooms WHERE id = $1', [roomId])).rows[0];
    if (!room) return deny('ROOM_NOT_FOUND', 404);
    const rows = (await db.query<{ id: string; session_id: string; nickname: string; role: Role; ready: boolean }>(
      `SELECT m.id, m.session_id, s.nickname, m.role, m.ready FROM room_members m
       JOIN sessions s ON s.id = m.session_id WHERE m.room_id = $1 AND m.active ORDER BY m.joined_at, m.id`, [roomId])).rows;
    const current = rows.find(member => member.session_id === sessionId);
    if (!current) return deny('NOT_ROOM_MEMBER', 403);
    const latest = (await db.query<{ id: string; stage: string; deadline_at: Date | null; version: string; snapshot: Round }>(
      'SELECT id, stage, deadline_at, version, snapshot FROM rounds WHERE room_id = $1 ORDER BY sequence DESC LIMIT 1', [roomId])).rows[0];
    const round = (latest?.stage === 'CANCELLED' && !latest.snapshot.terminalReason) || (latest?.stage === 'ARCHIVED' && ![latest.snapshot.speakerId, latest.snapshot.listenerId].includes(current.id)) ? undefined : latest;
    const teen = room.mode === 'teen' ? (await db.query<NonNullable<RoomState['teen']>>(`SELECT nickname, child_role AS role,
      locked_round_id IS NOT NULL AS locked, COALESCE(completed_round_id = $3, false) AS completed
      FROM guardian_seats WHERE room_id=$1 AND session_id=$2`, [roomId, sessionId, round?.id ?? null])).rows[0] : undefined;
    const previous = round?.stage === 'TASK' && current.role === 'speaker' ? (await db.query<{ complete: number; total: number; adopted: boolean }>(`SELECT
      (latest.snapshot->>'adviceAccepted')::boolean AS adopted, count(ci.id)::int AS total, count(ci.id) FILTER (WHERE ci.complete)::int AS complete
      FROM (SELECT id, snapshot FROM rounds WHERE room_id=$1 AND stage='ARCHIVED' ORDER BY sequence DESC LIMIT 1) latest
      JOIN comparison_items ci ON ci.round_id=latest.id GROUP BY latest.snapshot`, [roomId])).rows[0] : undefined;
    return { id: room.id, mode: room.mode, status: room.status, durationSeconds: room.duration_seconds, retellStyle: room.retell_style, topic: room.topic,
      version: Number(room.version), roundId: round?.id ?? null, stage: round?.stage ?? null,
      deadlineAt: round?.deadline_at?.toISOString() ?? null, roundVersion: round ? Number(round.version) : null,
      activeSeat: round?.snapshot.activeSeat ?? null,
      terminalReason: round?.snapshot.terminalReason ?? null,
      speakerAudioId: round?.stage === 'ARCHIVED' ? null : round?.snapshot.speakerAudioId ?? null,
      listenerAudioId: round?.stage === 'ARCHIVED' ? null : round?.snapshot.listenerAudioId ?? null,
      teen: teen ?? null,
      previousPractice: previous?.adopted ? { complete: previous.complete, total: previous.total } : null,
      you: { memberId: current.id, role: current.role, ready: current.ready },
      members: rows.map(({ id, nickname, role, ready }) => ({ id, nickname, role, ready })) };
  }

  async history(sessionId: string) {
    const result = await this.pool.query<{ id: string; roomId: string; canDelete: boolean; topic: string; mode: string; finishedAt: Date; total: number; complete: number; accurate: number; tags: string[] }>(`
      SELECT r.id, room.id AS "roomId", room.created_by=$1 AS "canDelete", room.topic, room.mode, r.finished_at AS "finishedAt",
        count(ci.id)::int AS total, count(ci.id) FILTER (WHERE ci.complete)::int AS complete,
        count(ci.id) FILTER (WHERE ci.accurate)::int AS accurate,
        COALESCE(array_agg(DISTINCT ci.tag ORDER BY ci.tag) FILTER (WHERE ci.resolution = 'misunderstanding' AND ci.tag IS NOT NULL), '{}') AS tags
      FROM rounds r JOIN rooms room ON room.id=r.room_id
      JOIN room_members member ON member.room_id=r.room_id AND member.session_id=$1
        AND member.id IN ((r.snapshot->>'speakerId')::uuid,(r.snapshot->>'listenerId')::uuid)
      JOIN comparison_items ci ON ci.round_id=r.id
      WHERE r.stage='ARCHIVED'
      GROUP BY r.id, room.id ORDER BY r.finished_at DESC LIMIT 50`, [sessionId]);
    return result.rows;
  }

  async create(sessionId: string, mode: Mode, createKey: string, settings: { durationSeconds: number; retellStyle: 'auditory' | 'keywords'; topic: string; teen?: TeenSettings | undefined } = { durationSeconds: 30, retellStyle: 'auditory', topic: '家庭日常' }): Promise<{ state: RoomState; inviteToken: string | null }> {
    if (mode === 'teen' && !settings.teen) return deny('GUARDIAN_CONSENT_REQUIRED', 400);
    const pinHash = mode === 'teen' && settings.teen ? await passwordHash(settings.teen.pin) : null;
    return this.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionId + createKey]);
      const existing = (await db.query<{ id: string; mode: Mode; status: string }>('SELECT id, mode, status FROM rooms WHERE created_by = $1 AND create_key = $2', [sessionId, createKey])).rows[0];
      if (existing) {
        if (existing.mode !== mode) return deny('CREATE_KEY_REUSED');
        if (existing.status === 'CLOSED') return deny('ROOM_CLOSED');
        return { state: await this.state(existing.id, sessionId, db), inviteToken: null };
      }
      const roomId = randomUUID();
      await db.query('INSERT INTO rooms (id, mode, status, created_by, create_key, duration_seconds, retell_style, topic) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [roomId, mode, 'WAITING', sessionId, createKey, settings.durationSeconds, settings.retellStyle, settings.topic]);
      await db.query('INSERT INTO room_members (id, room_id, session_id, role) VALUES ($1,$2,$3,$4)', [randomUUID(), roomId, sessionId, 'speaker']);
      if (settings.teen && pinHash) await db.query('INSERT INTO guardian_seats (room_id, session_id, nickname, child_role, pin_hash) VALUES ($1,$2,$3,$4,$5)',
        [roomId, sessionId, settings.teen.nickname, settings.teen.role, pinHash]);
      const invitation = !isSameDevice(mode) ? await this.insertInvitation(db, roomId, 'listener', 24 * 60, 1, null) : null;
      return { state: await this.state(roomId, sessionId, db), inviteToken: invitation?.token ?? null };
    });
  }

  async childHandoff(sessionId: string) {
    return (await this.pool.query<{ roomId: string; roundId: string; role: 'speaker' | 'listener'; stage: Round['stage'] }>(`SELECT gs.room_id AS "roomId",
      gs.locked_round_id AS "roundId", gs.child_role AS role, r.stage FROM guardian_seats gs JOIN rounds r ON r.id=gs.locked_round_id
      WHERE gs.session_id=$1`, [sessionId])).rows[0];
  }

  async enterChild(roomId: string, sessionId: string) {
    return this.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`guardian:${sessionId}`]);
      const room = (await db.query<{ status: string }>('SELECT status FROM rooms WHERE id=$1 FOR UPDATE', [roomId])).rows[0];
      const seat = (await db.query<{ child_role: string; locked_round_id: string | null; completed_round_id: string | null }>(`SELECT child_role, locked_round_id, completed_round_id
        FROM guardian_seats WHERE room_id=$1 AND session_id=$2 FOR UPDATE`, [roomId, sessionId])).rows[0];
      const round = (await db.query<{ id: string; snapshot: Round }>('SELECT id, snapshot FROM rounds WHERE room_id=$1 ORDER BY sequence DESC LIMIT 1', [roomId])).rows[0];
      if (!seat || !round || room?.status !== 'ACTIVE') return deny('HANDOFF_UNAVAILABLE', 403);
      const stage = round.snapshot.stage;
      if (seat.completed_round_id === round.id || (seat.child_role === 'speaker' ? !['TASK','SPEAKER_RECORDING','KEYPOINT_CONFIRM'].includes(stage) : stage !== 'LISTENER_RETELL')) return deny('WRONG_STAGE');
      if (!seat.locked_round_id) {
        const other = await db.query('SELECT 1 FROM guardian_seats WHERE session_id=$1 AND locked_round_id IS NOT NULL', [sessionId]);
        if (other.rowCount) return deny('GUARDIAN_REQUIRED', 403);
        await db.query('UPDATE guardian_seats SET locked_round_id=$2 WHERE room_id=$1', [roomId, round.id]);
        await db.query('UPDATE rooms SET version=version+1 WHERE id=$1', [roomId]);
      }
      return this.state(roomId, sessionId, db);
    });
  }

  async unlockChild(roomId: string, sessionId: string, pin: string) {
    const result = await this.transaction(async db => {
      await db.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [roomId]);
      const seat = (await db.query<{ pin_hash: string; locked_round_id: string; child_role: string; failed_attempts: number; retry_after: Date | null; stage: string }>(`SELECT gs.pin_hash,
        gs.locked_round_id, gs.child_role, gs.failed_attempts, gs.retry_after, r.stage FROM guardian_seats gs JOIN rounds r ON r.id=gs.locked_round_id
        WHERE gs.room_id=$1 AND gs.session_id=$2 FOR UPDATE OF gs`, [roomId, sessionId])).rows[0];
      if (!seat) return { code: 'HANDOFF_UNAVAILABLE', status: 403 };
      if (seat.retry_after && seat.retry_after.getTime() > Date.now()) return { code: 'RATE_LIMITED', status: 429 };
      if (!await matchesPassword(pin, seat.pin_hash)) {
        const attempts = seat.retry_after ? 1 : seat.failed_attempts + 1;
        await db.query(`UPDATE guardian_seats SET failed_attempts=$2, retry_after=CASE WHEN $2 >= 5 THEN now()+interval '5 minutes' END WHERE room_id=$1`, [roomId, attempts]);
        return { code: 'GUARDIAN_PIN_INVALID', status: 403 };
      }
      const completed = seat.child_role === 'speaker' ? !['TASK','SPEAKER_RECORDING','KEYPOINT_CONFIRM'].includes(seat.stage) : seat.stage !== 'LISTENER_RETELL';
      await db.query(`UPDATE guardian_seats SET locked_round_id=NULL, completed_round_id=CASE WHEN $2 THEN $3 ELSE completed_round_id END,
        failed_attempts=0, retry_after=NULL WHERE room_id=$1`, [roomId, completed, seat.locked_round_id]);
      await db.query('UPDATE rooms SET version=version+1 WHERE id=$1', [roomId]);
      return { state: await this.state(roomId, sessionId, db) };
    });
    if ('state' in result && result.state) return result.state;
    return deny(result.code!, result.status);
  }

  private async insertInvitation(db: PoolClient, roomId: string, role: 'listener' | 'observer', minutes: number, maxUses: number, password: string | null) {
    const token = secret();
    const hashedPassword = password ? await passwordHash(password) : null;
    await db.query(`INSERT INTO invitations (id, room_id, token_hash, password_hash, expires_at, max_uses, role)
      VALUES ($1,$2,$3,$4,now() + ($5::integer * interval '1 minute'),$6,$7)`,
    [randomUUID(), roomId, tokenHash(token), hashedPassword, minutes, maxUses, role]);
    return { token };
  }

  async invite(roomId: string, sessionId: string, role: 'listener' | 'observer', minutes: number, maxUses: number, password: string | null) {
    return this.transaction(async db => {
      const room = (await db.query<{ status: string; mode: Mode }>('SELECT status, mode FROM rooms WHERE id = $1 FOR UPDATE', [roomId])).rows[0];
      if (!room || room.status === 'CLOSED') return deny('ROOM_CLOSED', 404);
      if (isSameDevice(room.mode)) return deny('INVITE_UNAVAILABLE', 403);
      const speaker = (await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND session_id = $2 AND role = $3 AND active', [roomId, sessionId, 'speaker'])).rowCount;
      if (!speaker) return deny('FORBIDDEN_ROLE', 403);
      if (role === 'observer' && room.status !== 'WAITING') return deny('ROOM_STARTED');
      return this.insertInvitation(db, roomId, role, minutes, maxUses, password);
    });
  }

  async join(sessionId: string, token: string, password: string | null): Promise<RoomState> {
    return this.transaction(async db => {
      const invitation = (await db.query<Pick<Invitation, 'id' | 'room_id'>>(
        'SELECT id, room_id FROM invitations WHERE token_hash = $1', [tokenHash(token)])).rows[0];
      if (!invitation) return deny('INVITE_NOT_FOUND', 404);
      const room = (await db.query<{ status: string; mode: Mode }>('SELECT status, mode FROM rooms WHERE id = $1 FOR UPDATE', [invitation.room_id])).rows[0];
      const locked = (await db.query<Invitation>(
        'SELECT id, room_id, role, password_hash, expires_at, max_uses, use_count, revoked_at FROM invitations WHERE id = $1 FOR UPDATE', [invitation.id])).rows[0];
      if (!locked) return deny('INVITE_NOT_FOUND', 404);
      if (locked.revoked_at || room?.status === 'CLOSED') return deny('INVITATION_EXPIRED', 410);
      const existing = (await db.query<{ joined_invitation_id: string | null; role: Role }>(
        'SELECT joined_invitation_id, role FROM room_members WHERE room_id = $1 AND session_id = $2 AND active', [invitation.room_id, sessionId])).rows[0];
      if (existing?.joined_invitation_id === locked.id || (existing?.joined_invitation_id === null && existing.role === locked.role)) {
        return this.state(invitation.room_id, sessionId, db);
      }
      if (locked.expires_at.getTime() <= Date.now() || locked.use_count >= locked.max_uses) return deny('INVITATION_EXPIRED', 410);
      if (locked.password_hash && (!password || !await matchesPassword(password, locked.password_hash))) {
        return deny('INVITE_NOT_FOUND', 403);
      }
      const asyncRound = room?.mode === 'async' && room.status === 'ACTIVE' && locked.role === 'listener' ? (await db.query<{ id: string; snapshot: Round }>(
        `SELECT id, snapshot FROM rounds WHERE room_id=$1 AND stage IN ('TASK','SPEAKER_RECORDING','KEYPOINT_CONFIRM','ASYNC_PENDING') FOR UPDATE`, [invitation.room_id])).rows[0] : undefined;
      if (existing || !room || (room.status !== 'WAITING' && !asyncRound)) return deny('INVITE_NOT_FOUND', 404);
      const seat = (await db.query('SELECT 1 FROM room_members WHERE room_id = $1 AND role = $2 AND active', [invitation.room_id, locked.role])).rowCount;
      if (seat) return deny('INVITE_NOT_FOUND', 404);
      const memberId = randomUUID();
      await db.query('INSERT INTO room_members (id, room_id, session_id, role, joined_invitation_id) VALUES ($1,$2,$3,$4,$5)', [memberId, invitation.room_id, sessionId, locked.role, locked.id]);
      if (asyncRound) {
        await db.query('UPDATE rounds SET snapshot=$2 WHERE id=$1', [asyncRound.id, { ...asyncRound.snapshot, listenerId: memberId }]);
      }
      await db.query('UPDATE invitations SET use_count = use_count + 1 WHERE id = $1', [locked.id]);
      await db.query('UPDATE rooms SET version = version + 1 WHERE id = $1', [invitation.room_id]);
      return this.state(invitation.room_id, sessionId, db);
    });
  }

  async ready(roomId: string, sessionId: string, ready: boolean): Promise<RoomState> {
    return this.transaction(async db => {
      const room = (await db.query<{ status: string }>('SELECT status FROM rooms WHERE id = $1 FOR UPDATE', [roomId])).rows[0];
      if (!room || room.status !== 'WAITING') return deny('ROOM_NOT_WAITING');
      const updated = await db.query('UPDATE room_members SET ready = $3 WHERE room_id = $1 AND session_id = $2 AND active RETURNING id', [roomId, sessionId, ready]);
      if (!updated.rowCount) return deny('NOT_ACTIVE_PLAYER', 403);
      await db.query('UPDATE rooms SET version = version + 1 WHERE id = $1', [roomId]);
      return this.state(roomId, sessionId, db);
    });
  }

  async start(roomId: string, sessionId: string): Promise<RoomState> {
    return this.transaction(async db => {
      const room = (await db.query<{ status: string; mode: Mode }>('SELECT status, mode FROM rooms WHERE id = $1 FOR UPDATE', [roomId])).rows[0];
      if (!room) return deny('ROOM_NOT_FOUND', 404);
      if (room.status !== 'WAITING') return deny('ROOM_NOT_WAITING');
      const members = (await db.query<{ id: string; role: Role; ready: boolean; session_id: string }>('SELECT id, role, ready, session_id FROM room_members WHERE room_id = $1 AND active', [roomId])).rows;
      if (!members.some(m => m.role === 'speaker' && m.session_id === sessionId)) return deny('FORBIDDEN_ROLE', 403);
      if (!members.some(m => m.role === 'speaker' && m.ready) || (room.mode === 'sync' && !members.some(m => m.role === 'listener' && m.ready))) return deny('PLAYERS_NOT_READY');
      const sequence = Number((await db.query<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM rounds WHERE room_id = $1', [roomId])).rows[0]?.sequence);
      const speakerId = members.find(m => m.role === 'speaker')?.id;
      const listenerId = isSameDevice(room.mode) ? speakerId : members.find(m => m.role === 'listener')?.id ?? (room.mode === 'async' ? randomUUID() : undefined);
      if (!speakerId || !listenerId) return deny('PLAYERS_NOT_READY');
      const round = newRound({ id: randomUUID(), roomId, mode: room.mode, speakerId, listenerId });
      await db.query('INSERT INTO rounds (id, room_id, sequence, stage, snapshot) VALUES ($1,$2,$3,$4,$5)', [round.id, roomId, sequence, round.stage, round]);
      await db.query('UPDATE rooms SET status = $2, version = version + 1 WHERE id = $1', [roomId, 'ACTIVE']);
      return this.state(roomId, sessionId, db);
    });
  }

  async prepareNext(roomId: string, roundId: string, sessionId: string, expectedVersion: number): Promise<RoomState> {
    return this.transaction(async db => {
      const room = (await db.query<{ status: string }>('SELECT status FROM rooms WHERE id = $1 FOR UPDATE', [roomId])).rows[0];
      if (!room || room.status === 'CLOSED') return deny('ROOM_CLOSED', 404);
      const members = (await db.query<{ id: string; role: Role; active: boolean; session_id: string }>(
        'SELECT id, role, active, session_id FROM room_members WHERE room_id = $1 AND active', [roomId])).rows;
      const speaker = members.find(member => member.session_id === sessionId && member.role === 'speaker');
      if (!speaker) return deny('FORBIDDEN_ROLE', 403);
      const latest = (await db.query<{ id: string; stage: string; snapshot: Round }>(
        'SELECT id, stage, snapshot FROM rounds WHERE room_id = $1 ORDER BY sequence DESC LIMIT 1 FOR UPDATE', [roomId])).rows[0];
      if (latest?.id !== roundId) return deny('STALE_VERSION');
      if (room.status === 'WAITING' && latest.stage === 'ARCHIVED') return this.state(roomId, sessionId, db);
      if (room.status !== 'ACTIVE' || latest.stage !== 'ADVICE') return deny('WRONG_STAGE');
      const next = applyRoundCommand(latest.snapshot, { type: 'archived' }, {
        members, actor: { kind: 'member', memberId: speaker.id }, expectedVersion,
        now: new Date(), speakerSeconds: 30, listenerSeconds: 30, asyncWaitSeconds: 604800,
      });
      await db.query("UPDATE rounds SET stage = 'ARCHIVED', version = $2, deadline_at = NULL, snapshot = $3, finished_at = now() WHERE id = $1",
        [roundId, next.version, next]);
      await db.query('UPDATE room_members SET ready = false WHERE room_id = $1 AND active', [roomId]);
      await db.query("UPDATE rooms SET status = 'WAITING', version = version + 1 WHERE id = $1", [roomId]);
      return this.state(roomId, sessionId, db);
    });
  }

  async swapSeats(roomId: string, sessionId: string, expectedVersion: number): Promise<RoomState> {
    return this.transaction(async db => {
      const room = (await db.query<{ status: string; mode: Mode; version: string }>('SELECT status, mode, version FROM rooms WHERE id=$1 FOR UPDATE', [roomId])).rows[0];
      if (!room || room.status !== 'WAITING' || room.mode !== 'sync') return deny('WRONG_STAGE');
      if (Number(room.version) !== expectedVersion) return deny('STALE_VERSION');
      const stage = (await db.query<{ stage: string }>('SELECT stage FROM rounds WHERE room_id=$1 ORDER BY sequence DESC LIMIT 1', [roomId])).rows[0]?.stage;
      if (stage !== 'ARCHIVED') return deny('WRONG_STAGE');
      const seats = (await db.query<{ id: string; role: Role; session_id: string }>(`SELECT id, role, session_id FROM room_members
        WHERE room_id=$1 AND active AND role IN ('speaker','listener') FOR UPDATE`, [roomId])).rows;
      if (!seats.some(member => member.role === 'speaker' && member.session_id === sessionId)) return deny('FORBIDDEN_ROLE', 403);
      if (seats.length !== 2) return deny('PLAYERS_NOT_READY');
      const ids = seats.map(member => member.id);
      await db.query('UPDATE room_members SET active=false WHERE id=ANY($1::uuid[])', [ids]);
      await db.query(`UPDATE room_members SET role=CASE WHEN role='speaker' THEN 'listener' ELSE 'speaker' END, active=true
        WHERE id=ANY($1::uuid[])`, [ids]);
      await db.query('UPDATE room_members SET ready=false WHERE room_id=$1 AND active', [roomId]);
      await db.query('UPDATE invitations SET revoked_at=now() WHERE room_id=$1 AND revoked_at IS NULL', [roomId]);
      await db.query('UPDATE rooms SET version=version+1 WHERE id=$1', [roomId]);
      return this.state(roomId, sessionId, db);
    });
  }

  async leave(roomId: string, sessionId: string): Promise<{ status: 'CLOSED' | 'LEFT' }> {
    return this.transaction(async db => {
      const room = (await db.query<{ status: string }>('SELECT status FROM rooms WHERE id = $1 FOR UPDATE', [roomId])).rows[0];
      if (!room) return deny('ROOM_NOT_FOUND', 404);
      const member = (await db.query<{ role: Role }>('SELECT role FROM room_members WHERE room_id = $1 AND session_id = $2 AND active FOR UPDATE', [roomId, sessionId])).rows[0];
      if (!member) return deny('NOT_ROOM_MEMBER', 403);
      await db.query('UPDATE room_members SET active = false, ready = false, left_at = now() WHERE room_id = $1 AND session_id = $2 AND active', [roomId, sessionId]);
      if (member.role === 'speaker') {
        await db.query(`UPDATE rooms SET status = 'CLOSED', closed_at = now(), version = version + 1 WHERE id = $1`, [roomId]);
        await db.query(`UPDATE rounds SET stage = 'CANCELLED', deadline_at = NULL, finished_at = now(), version = version + 1 WHERE room_id = $1 AND stage NOT IN ('ARCHIVED', 'CANCELLED')`, [roomId]);
        await db.query('UPDATE invitations SET revoked_at = now() WHERE room_id = $1 AND revoked_at IS NULL', [roomId]);
        await db.query('UPDATE room_members SET active = false, ready = false, left_at = now() WHERE room_id = $1 AND active', [roomId]);
        await db.query('UPDATE guardian_seats SET locked_round_id=NULL WHERE room_id=$1', [roomId]);
        return { status: 'CLOSED' };
      }
      if (member.role === 'listener' && room.status === 'ACTIVE') {
        const asyncRound = (await db.query<{ id: string; snapshot: Round }>(`SELECT r.id, r.snapshot FROM rounds r JOIN rooms t ON t.id=r.room_id
          WHERE r.room_id=$1 AND t.mode='async' AND r.stage IN ('TASK','SPEAKER_RECORDING','KEYPOINT_CONFIRM','ASYNC_PENDING') FOR UPDATE OF r`, [roomId])).rows[0];
        if (asyncRound) {
          await db.query('UPDATE rounds SET snapshot=$2 WHERE id=$1', [asyncRound.id, { ...asyncRound.snapshot, listenerId: randomUUID() }]);
          await db.query('UPDATE rooms SET version=version+1 WHERE id=$1', [roomId]);
          return { status: 'LEFT' };
        }
        await db.query(`UPDATE rounds SET stage = 'CANCELLED', deadline_at = NULL, finished_at = now(), version = version + 1 WHERE room_id = $1 AND stage NOT IN ('ARCHIVED', 'CANCELLED')`, [roomId]);
        await db.query(`UPDATE rooms SET status = 'WAITING', version = version + 1 WHERE id = $1`, [roomId]);
        await db.query('UPDATE room_members SET ready = false WHERE room_id = $1 AND active', [roomId]);
      } else await db.query('UPDATE rooms SET version = version + 1 WHERE id = $1', [roomId]);
      return { status: 'LEFT' };
    });
  }

  async leaveAll(sessionId: string): Promise<void> {
    const rooms = await this.pool.query<{ room_id: string }>('SELECT room_id FROM room_members WHERE session_id = $1 AND active ORDER BY room_id', [sessionId]);
    for (const { room_id: roomId } of rooms.rows) {
      try { await this.leave(roomId, sessionId); }
      catch (error) { if (!(error instanceof RoomError && error.code === 'NOT_ROOM_MEMBER')) throw error; }
    }
  }

  async sweepExpiredSessions(now: Date): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT DISTINCT s.id FROM sessions s JOIN room_members m ON m.session_id = s.id
       WHERE m.active AND (s.expires_at <= $1 OR s.revoked_at IS NOT NULL) LIMIT 200`, [now]);
    for (const { id } of result.rows) await this.leaveAll(id);
    return result.rows.length;
  }

  async sweepExpiredRounds(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - 30000);
    const due = await this.pool.query<{ id: string; room_id: string }>(
      "SELECT id, room_id FROM rounds WHERE deadline_at <= $1 AND stage IN ('SPEAKER_RECORDING','LISTENER_RETELL','ASYNC_PENDING','COMPARING') ORDER BY deadline_at LIMIT 50", [cutoff]);
    for (const row of due.rows) await this.expireRound(row.room_id, row.id, now, cutoff);
  }

  async failComparison(roundId: string): Promise<void> {
    const row = (await this.pool.query<{ room_id: string }>("SELECT room_id FROM rounds WHERE id = $1 AND stage = 'COMPARING'", [roundId])).rows[0];
    if (row) await this.expireRound(row.room_id, roundId, new Date(), null);
  }

  private async expireRound(roomId: string, roundId: string, now: Date, cutoff: Date | null): Promise<void> {
    await this.transaction(async db => {
      const room = (await db.query<{ status: string }>('SELECT status FROM rooms WHERE id = $1 FOR UPDATE', [roomId])).rows[0];
      if (room?.status !== 'ACTIVE') return;
      const row = (await db.query<{ snapshot: Round; deadline_at: Date | null }>(
        "SELECT snapshot, deadline_at FROM rounds WHERE id = $1 AND stage IN ('SPEAKER_RECORDING','LISTENER_RETELL','ASYNC_PENDING','COMPARING') FOR UPDATE", [roundId])).rows[0];
      if (!row || (cutoff ? !row.deadline_at || row.deadline_at > cutoff : row.snapshot.stage !== 'COMPARING')) return;
      const round = cutoff ? row.snapshot : { ...row.snapshot, deadlineAt: now.toISOString() };
      const next = applyRoundCommand(round, { type: 'expired' }, {
        actor: { kind: 'system' }, members: [], expectedVersion: round.version, now,
        speakerSeconds: 30, listenerSeconds: 30, asyncWaitSeconds: 604800,
      });
      await db.query("UPDATE rounds SET stage='CANCELLED', deadline_at=NULL, version=$2, snapshot=$3, finished_at=now() WHERE id=$1", [roundId, next.version, next]);
      await db.query('UPDATE room_members SET ready=false WHERE room_id=$1 AND active', [roomId]);
      await db.query("UPDATE rooms SET status='WAITING', version=version+1 WHERE id=$1", [roomId]);
    });
  }
}
