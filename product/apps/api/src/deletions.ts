import type { Pool, PoolClient } from 'pg';
import { RoomError } from './rooms.ts';

export type DeleteScope = 'round' | 'room' | 'all';

const ownedRounds = `SELECT r.id, r.room_id FROM rounds r JOIN rooms t ON t.id=r.room_id WHERE
  (($2='round' AND r.id=$3) OR ($2='room' AND t.id=$3) OR $2='all') AND
  t.created_by=$1`;
const ownedRooms = `SELECT id FROM rooms WHERE created_by=$1 AND ($2='all' OR ($2='room' AND id=$3)) AND topic <> ''`;

export class PgDeletionStore {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async preview(sessionId: string, scope: DeleteScope, target: string | null) {
    return this.count(this.pool, [sessionId, scope, target]);
  }

  private async count(db: Pool | PoolClient, args: [string, DeleteScope, string | null]) {
    const { rounds, rooms } = (await db.query<{ rounds: string[]; rooms: string[] }>(`SELECT
      ARRAY(SELECT id FROM (${ownedRounds}) candidate ORDER BY id) AS rounds,
      ARRAY(SELECT id FROM (${ownedRooms}) candidate ORDER BY id) AS rooms`, args)).rows[0]!;
    return { roundIds: rounds, roomIds: rooms };
  }

  async remove(sessionId: string, scope: DeleteScope, target: string | null, expectedCount: number) {
    const db = await this.pool.connect();
    const args: [string, DeleteScope, string | null] = [sessionId, scope, target];
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(71234103)');
      await db.query(`SELECT id FROM rooms WHERE id IN (SELECT room_id FROM (${ownedRounds}) candidate UNION ${ownedRooms}) ORDER BY id FOR UPDATE`, args);
      const { roundIds, roomIds } = await this.count(db, args);
      if (roundIds.length !== expectedCount) throw new RoomError('DELETION_SCOPE_CHANGED', 409);
      if (!roundIds.length && !roomIds.length) throw new RoomError('NOTHING_TO_DELETE', 404);
      const roundRooms = (await db.query<{ room_id: string }>('SELECT DISTINCT room_id FROM rounds WHERE id=ANY($1::uuid[])', [roundIds])).rows.map(row => row.room_id);
      const resetRooms = (await db.query<{ room_id: string }>(`SELECT DISTINCT room_id FROM rounds WHERE id=ANY($1::uuid[])
        AND stage NOT IN ('ARCHIVED','CANCELLED')`, [roundIds])).rows.map(row => row.room_id);
      // The delay covers outstanding upload signatures so a late PUT cannot recreate a deleted object.
      await db.query(`INSERT INTO audio_deletion_queue (object_key, available_at)
        SELECT object_key, now()+interval '6 minutes' FROM audio_assets WHERE round_id=ANY($1::uuid[])
        UNION SELECT 'rounds/'||round_id||'/temporary/'||id||'.mp3', now()+interval '6 minutes' FROM audio_assets WHERE round_id=ANY($1::uuid[])
        ON CONFLICT (object_key) DO NOTHING`, [roundIds]);
      await db.query('DELETE FROM confirmations WHERE item_id IN (SELECT id FROM comparison_items WHERE round_id=ANY($1::uuid[]))', [roundIds]);
      await db.query('DELETE FROM comparison_items WHERE round_id=ANY($1::uuid[])', [roundIds]);
      await db.query('DELETE FROM key_points WHERE round_id=ANY($1::uuid[])', [roundIds]);
      await db.query('DELETE FROM transcripts WHERE audio_id IN (SELECT id FROM audio_assets WHERE round_id=ANY($1::uuid[]))', [roundIds]);
      await db.query('DELETE FROM audio_assets WHERE round_id=ANY($1::uuid[])', [roundIds]);
      await db.query('UPDATE guardian_seats SET completed_round_id=NULL WHERE completed_round_id=ANY($1::uuid[])', [roundIds]);
      await db.query('UPDATE guardian_seats SET locked_round_id=NULL WHERE locked_round_id=ANY($1::uuid[])', [roundIds]);
      await db.query('DELETE FROM rounds WHERE id=ANY($1::uuid[])', [roundIds]);
      await db.query(`UPDATE rooms SET status='WAITING', version=version+1 WHERE id=ANY($1::uuid[]) AND status='ACTIVE'`, [resetRooms]);
      await db.query('UPDATE room_members SET ready=false WHERE room_id=ANY($1::uuid[]) AND active', [resetRooms]);
      await db.query('UPDATE rooms SET version=version+1 WHERE id=ANY($1::uuid[])', [roundRooms]);
      await db.query(`UPDATE rooms SET status='CLOSED', closed_at=now(), topic='', version=version+1 WHERE id=ANY($1::uuid[])`, [roomIds]);
      await db.query('UPDATE room_members SET active=false, ready=false, left_at=now() WHERE room_id=ANY($1::uuid[]) AND active', [roomIds]);
      await db.query('DELETE FROM invitations WHERE room_id=ANY($1::uuid[]) AND id NOT IN (SELECT joined_invitation_id FROM room_members WHERE joined_invitation_id IS NOT NULL)', [roomIds]);
      await db.query('UPDATE invitations SET revoked_at=now(), password_hash=NULL WHERE room_id=ANY($1::uuid[])', [roomIds]);
      await db.query('DELETE FROM guardian_seats WHERE room_id=ANY($1::uuid[])', [roomIds]);
      await db.query('COMMIT');
      return { deletedRounds: roundIds.length };
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }

  async purgeAudio(removeObject: (key: string) => Promise<void>) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const rows = (await db.query<{ object_key: string }>(`SELECT object_key FROM audio_deletion_queue
        WHERE available_at <= now() ORDER BY available_at LIMIT 25 FOR UPDATE SKIP LOCKED`)).rows;
      for (const { object_key: key } of rows) {
        try { await removeObject(key); }
        catch {
          await db.query(`UPDATE audio_deletion_queue SET attempts=attempts+1, available_at=now()+interval '5 minutes' WHERE object_key=$1`, [key]);
          continue;
        }
        await db.query('DELETE FROM audio_deletion_queue WHERE object_key=$1', [key]);
      }
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
}
