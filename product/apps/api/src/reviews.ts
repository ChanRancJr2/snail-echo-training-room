import type { Pool } from 'pg';
import { applyRoundCommand, isSameDevice, type Command, type Member, type Round } from '../../../packages/core/src/round.ts';
import { RoomError } from './rooms.ts';
import { lockActiveRoundRoom } from './round-lock.ts';
import type { TextCipher } from './crypto.ts';

export class PgReviewStore {
  private readonly pool: Pool;
  private readonly cipher: TextCipher | undefined;
  constructor(pool: Pool, cipher?: TextCipher) { this.pool = pool; this.cipher = cipher; }

  async apply(roundId: string, sessionId: string, expectedVersion: number, command: Command): Promise<Round> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await lockActiveRoundRoom(db, roundId);
      const row = (await db.query<{ snapshot: Round }>("SELECT snapshot FROM rounds WHERE id = $1 AND stage NOT IN ('CANCELLED', 'ARCHIVED') FOR UPDATE", [roundId])).rows[0];
      if (!row) throw new RoomError('ROUND_NOT_FOUND', 404);
      const round = row.snapshot;
      const members = (await db.query<Member & { session_id: string }>('SELECT id, role, active, session_id FROM room_members WHERE room_id = $1', [round.roomId])).rows;
      const actor = members.find(member => member.session_id === sessionId && member.active);
      if (!actor) throw new RoomError('NOT_ROOM_MEMBER', 403);
      const next = applyRoundCommand(round, command, { members, actor: { kind: 'member', memberId: actor.id }, expectedVersion,
        now: new Date(), speakerSeconds: 30, listenerSeconds: 30, asyncWaitSeconds: 604800 });
      if (command.type === 'speaker-labeled') {
        for (const label of command.labels) await db.query('UPDATE comparison_items SET tag = $2, resolution = $3, revision = $5 WHERE id = $1 AND round_id = $4',
          [label.issueId, label.tag, label.resolution, roundId, next.issues.find(issue => issue.id === label.issueId)?.revision]);
      }
      if (command.type === 'issue-revised') {
        const before = round.issues.find(issue => issue.id === command.issueId);
        const after = next.issues.find(issue => issue.id === command.issueId);
        await db.query('UPDATE comparison_items SET tag = $2, resolution = $3, revision = $5 WHERE id = $1 AND round_id = $4',
          [command.issueId, command.tag, command.resolution, roundId, after?.revision]);
        if (after?.revision !== before?.revision) await db.query('DELETE FROM confirmations WHERE item_id = $1', [command.issueId]);
      }
      if (command.type === 'issue-confirmed') {
        const role = isSameDevice(round.mode) ? round.activeSeat : actor.role;
        const revision = next.issues.find(issue => issue.id === command.issueId)?.revision;
        await db.query(`INSERT INTO confirmations (item_id, member_id, role, revision) VALUES ($1,$2,$3,$4)
          ON CONFLICT (item_id, role) DO UPDATE SET member_id = $2, revision = $4, confirmed_at = now()`,
          [command.issueId, actor.id, role, revision]);
      }
      if (command.type === 'listener-clarified') {
        if (!this.cipher) throw new RoomError('CLARIFICATION_UNAVAILABLE', 503);
        const note = this.cipher.encrypt(command.note);
        await db.query('UPDATE comparison_items SET listener_note_ciphertext=$2, listener_note_nonce=$3, listener_note_key_ref=$4, revision=$5 WHERE id=$1 AND round_id=$6',
          [command.issueId, note.ciphertext, note.nonce, note.keyRef, next.issues.find(issue => issue.id === command.issueId)?.revision, roundId]);
        await db.query('DELETE FROM confirmations WHERE item_id=$1', [command.issueId]);
      }
      if (command.type === 'observer-annotated') {
        if (!this.cipher) throw new RoomError('OBSERVATION_UNAVAILABLE', 503);
        const note = this.cipher.encrypt(command.note);
        await db.query(`UPDATE comparison_items SET observer_tag=$2, observer_note_ciphertext=$3, observer_note_nonce=$4, observer_note_key_ref=$5
          WHERE id=$1 AND round_id=$6`, [command.issueId, command.tag, note.ciphertext, note.nonce, note.keyRef, roundId]);
      }
      await db.query('UPDATE rounds SET stage = $2, version = $3, deadline_at = $4, snapshot = $5, finished_at = CASE WHEN $2 = $6 THEN now() ELSE finished_at END WHERE id = $1',
        [roundId, next.stage, next.version, next.deadlineAt, next, 'ARCHIVED']);
      await db.query('UPDATE rooms SET version = version + 1 WHERE id = $1', [round.roomId]);
      await db.query('COMMIT');
      return next;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
}
