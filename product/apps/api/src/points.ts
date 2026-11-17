import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { applyRoundCommand, type Member, type Round } from '../../../packages/core/src/round.ts';
import { TextCipher } from './crypto.ts';
import { RoomError } from './rooms.ts';
import { lockActiveRoundRoom } from './round-lock.ts';

export type PointCategory = '人物' | '事件' | '需求' | '情绪' | '因果' | '重点' | '时间';
export interface PointInput { category: PointCategory; text: string }
export interface PointView extends PointInput { id: string; position: number }

export class PgPointStore {
  private readonly pool: Pool;
  private readonly cipher: TextCipher;
  constructor(pool: Pool, cipher: TextCipher) { this.pool = pool; this.cipher = cipher; }

  async speakerTranscript(roundId: string, sessionId: string): Promise<{ status: 'off' | 'pending' | 'ready'; text?: string; candidates?: PointInput[] }> {
    const row = (await this.pool.query<{
      requested: boolean; ciphertext: Buffer | null; nonce: Buffer | null; key_ref: string | null; candidates_ciphertext: Buffer | null; candidates_nonce: Buffer | null;
    }>(`SELECT a.transcription_requested AS requested, t.ciphertext, t.nonce, t.key_ref, t.candidates_ciphertext, t.candidates_nonce
       FROM rounds r JOIN rooms room ON room.id = r.room_id
       JOIN room_members member ON member.id = (r.snapshot->>'speakerId')::uuid
       JOIN audio_assets a ON a.id = (r.snapshot->>'speakerAudioId')::uuid AND a.state = 'COMMITTED'
       LEFT JOIN transcripts t ON t.audio_id = a.id
       WHERE r.id = $1 AND r.stage = 'KEYPOINT_CONFIRM' AND room.status = 'ACTIVE'
         AND member.session_id = $2 AND member.active`, [roundId, sessionId])).rows[0];
    if (!row) throw new RoomError('TRANSCRIPT_NOT_ACCESSIBLE', 403);
    if (!row.requested) return { status: 'off' };
    if (!row.ciphertext || !row.nonce || !row.key_ref) return { status: 'pending' };
    const candidates = row.candidates_ciphertext && row.candidates_nonce
      ? JSON.parse(this.cipher.decrypt(row.candidates_ciphertext, row.candidates_nonce, row.key_ref)) as PointInput[] : [];
    return { status: 'ready', text: this.cipher.decrypt(row.ciphertext, row.nonce, row.key_ref), candidates };
  }

  async confirm(roundId: string, sessionId: string, expectedVersion: number, points: PointInput[]): Promise<{ round: Round; points: PointView[] }> {
    if (points.length < 1 || points.length > 12) throw new RoomError('POINTS_REQUIRED', 400);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await lockActiveRoundRoom(db, roundId);
      const row = (await db.query<{ snapshot: Round }>("SELECT snapshot FROM rounds WHERE id = $1 AND stage NOT IN ('CANCELLED', 'ARCHIVED') FOR UPDATE", [roundId])).rows[0];
      if (!row) throw new RoomError('ROUND_NOT_FOUND', 404);
      const round = row.snapshot;
      const members = (await db.query<Member & { session_id: string }>('SELECT id, role, active, session_id FROM room_members WHERE room_id = $1', [round.roomId])).rows;
      const actor = members.find(member => member.session_id === sessionId && member.active && member.id === round.speakerId);
      if (!actor) throw new RoomError('FORBIDDEN_ROLE', 403);
      const settings = (await db.query<{ duration_seconds: number }>('SELECT duration_seconds FROM rooms WHERE id = $1', [round.roomId])).rows[0];
      if (!settings) throw new RoomError('ROOM_NOT_FOUND', 404);
      const next = applyRoundCommand(round, { type: 'points-confirmed', pointCount: points.length }, {
        members, actor: { kind: 'member', memberId: actor.id }, expectedVersion, now: new Date(),
        speakerSeconds: settings.duration_seconds, listenerSeconds: settings.duration_seconds, asyncWaitSeconds: 7 * 24 * 60 * 60,
      });
      await db.query('DELETE FROM key_points WHERE round_id = $1', [roundId]);
      const saved: PointView[] = [];
      for (const [position, point] of points.entries()) {
        const id = randomUUID();
        const sealed = this.cipher.encrypt(point.text);
        await db.query(`INSERT INTO key_points (id, round_id, category, position, confirmed_by, content_ciphertext, nonce, key_ref, source)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual')`, [id, roundId, point.category, position, actor.id, sealed.ciphertext, sealed.nonce, sealed.keyRef]);
        saved.push({ id, position, ...point });
      }
      await db.query('UPDATE rounds SET stage = $2, version = $3, deadline_at = $4, snapshot = $5 WHERE id = $1', [roundId, next.stage, next.version, next.deadlineAt, next]);
      await db.query('UPDATE rooms SET version = version + 1 WHERE id = $1', [round.roomId]);
      await db.query('COMMIT');
      return { round: next, points: saved };
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }

  async list(roundId: string, sessionId: string): Promise<PointView[]> {
    const row = (await this.pool.query<{ room_id: string; stage: string; room_status: string; retell_style: string; snapshot: Round }>(
      'SELECT r.room_id, r.stage, r.snapshot, room.retell_style FROM rounds r JOIN rooms room ON room.id = r.room_id WHERE r.id = $1', [roundId])).rows[0];
    if (!row) throw new RoomError('ROUND_NOT_FOUND', 404);
    const member = (await this.pool.query<{ role: string; id: string }>('SELECT id, role FROM room_members WHERE room_id = $1 AND session_id = $2 AND active', [row.room_id, sessionId])).rows[0];
    if (!member) throw new RoomError('NOT_ROOM_MEMBER', 403);
    const observerHints = member.role === 'observer' && row.room_status === 'ACTIVE' && row.stage === 'LISTENER_RETELL' && row.retell_style === 'keywords';
    if ((member.role === 'observer' && !observerHints) || (member.id === row.snapshot.listenerId && row.stage === 'LISTENER_RETELL' && row.retell_style !== 'keywords') ||
      (member.role === 'listener' && (row.retell_style !== 'keywords' || row.stage !== 'LISTENER_RETELL'))) {
      throw new RoomError('POINTS_HIDDEN', 403);
    }
    const result = await this.pool.query<{ id: string; position: number; category: PointCategory; content_ciphertext: Buffer; nonce: Buffer; key_ref: string }>(
      'SELECT id, position, category, content_ciphertext, nonce, key_ref FROM key_points WHERE round_id = $1 ORDER BY position', [roundId]);
    const hints = observerHints || member.id === row.snapshot.listenerId && row.stage === 'LISTENER_RETELL';
    return result.rows.map(point => {
      const text = this.cipher.decrypt(point.content_ciphertext, point.nonce, point.key_ref);
      return { id: point.id, position: point.position, category: point.category, text: hints && text.length > 6 ? `${text.slice(0, 6)}…` : text };
    });
  }
}
