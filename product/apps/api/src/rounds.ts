import type { Pool } from 'pg';
import { applyRoundCommand, DomainError, type Command, type Member, type Round } from '../../../packages/core/src/round.ts';
import { RoomError } from './rooms.ts';
import { lockActiveRoundRoom } from './round-lock.ts';
import type { TextCipher } from './crypto.ts';

export class PgRoundStore {
  private readonly pool: Pool;
  private readonly cipher: TextCipher | undefined;
  constructor(pool: Pool, cipher?: TextCipher) { this.pool = pool; this.cipher = cipher; }

  async apply(roundId: string, sessionId: string, expectedVersion: number, command: Command, now = new Date(), focus = ''): Promise<Round> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await lockActiveRoundRoom(db, roundId);
      const row = (await db.query<{ snapshot: Round; version: string }>("SELECT snapshot, version FROM rounds WHERE id = $1 AND stage NOT IN ('CANCELLED', 'ARCHIVED') FOR UPDATE", [roundId])).rows[0];
      if (!row) throw new RoomError('ROUND_NOT_FOUND', 404);
      const round = row.snapshot;
      if (round.version !== Number(row.version)) throw new Error('Round snapshot version mismatch');
      const members = (await db.query<Member & { session_id: string }>(
        'SELECT id, role, active, session_id FROM room_members WHERE room_id = $1', [round.roomId])).rows;
      const actor = members.find(member => member.session_id === sessionId && member.active);
      if (!actor) throw new RoomError('NOT_ROOM_MEMBER', 403);
      if (round.mode === 'teen') {
        const guardian = (await db.query<{ child_role: string; locked_round_id: string | null }>('SELECT child_role, locked_round_id FROM guardian_seats WHERE room_id=$1 AND session_id=$2', [round.roomId, sessionId])).rows[0];
        const requiredSeat = command.type === 'task-set' ? 'speaker' : command.type === 'recording-restarted' ? command.kind : null;
        if (!guardian || (requiredSeat && ((guardian.child_role === requiredSeat) !== (guardian.locked_round_id === round.id)))) throw new RoomError('GUARDIAN_REQUIRED', 403);
      }
      const settings = (await db.query<{ duration_seconds: number }>('SELECT duration_seconds FROM rooms WHERE id = $1', [round.roomId])).rows[0];
      if (!settings) throw new RoomError('ROOM_NOT_FOUND', 404);
      const next = applyRoundCommand(round, command, { members, actor: { kind: 'member', memberId: actor.id }, expectedVersion, now, speakerSeconds: settings.duration_seconds, listenerSeconds: settings.duration_seconds, asyncWaitSeconds: 7 * 24 * 60 * 60 });
      if (command.type === 'task-set' && focus) {
        if (!this.cipher) throw new RoomError('FOCUS_UNAVAILABLE', 503);
        const sealed = this.cipher.encrypt(focus);
        await db.query('INSERT INTO round_task_focus (round_id, ciphertext, nonce, key_ref) VALUES ($1,$2,$3,$4)',
          [roundId, sealed.ciphertext, sealed.nonce, sealed.keyRef]);
      }
      await db.query('UPDATE rounds SET stage = $2, version = $3, deadline_at = $4, snapshot = $5, finished_at = CASE WHEN $2 = $6 THEN now() ELSE finished_at END WHERE id = $1',
        [roundId, next.stage, next.version, next.deadlineAt, next, 'ARCHIVED']);
      await db.query('UPDATE rooms SET version = version + 1 WHERE id = $1', [round.roomId]);
      await db.query('COMMIT');
      return next;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }

  async useListeningAid(roundId: string, sessionId: string, kind: 'replay' | 'keywords'): Promise<void> {
    const result = await this.pool.query(`INSERT INTO round_listening_aids (round_id, replay_used, keywords_used)
      SELECT r.id, $3 = 'replay', $3 = 'keywords' FROM rounds r JOIN rooms room ON room.id = r.room_id
      JOIN room_members m ON m.id = (r.snapshot->>'listenerId')::uuid
      WHERE r.id = $1 AND m.session_id = $2 AND m.active AND room.status = 'ACTIVE' AND r.stage = 'LISTENER_RETELL'
        AND (r.snapshot->>'speakerId' <> r.snapshot->>'listenerId' OR r.snapshot->>'activeSeat' = 'listener')
        AND ($3 = 'replay' OR room.retell_style = 'keywords')
      ON CONFLICT (round_id) DO UPDATE SET replay_used = round_listening_aids.replay_used OR excluded.replay_used,
        keywords_used = round_listening_aids.keywords_used OR excluded.keywords_used`, [roundId, sessionId, kind]);
    if (!result.rowCount) throw new RoomError('AID_NOT_ACCESSIBLE', 403);
  }
}

export function roundErrorResponse(error: unknown): RoomError | null {
  if (!(error instanceof DomainError)) return null;
  const forbidden = ['NOT_MEMBER', 'FORBIDDEN_ROLE', 'ROLE_MISMATCH', 'SYSTEM_ONLY'];
  return new RoomError(error.code, forbidden.includes(error.code) ? 403 : 409);
}
