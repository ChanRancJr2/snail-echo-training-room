import type { PoolClient } from 'pg';
import { RoomError } from './rooms.ts';

// Room lifecycle mutations also lock the room before locking its rounds.
export async function lockActiveRoundRoom(db: PoolClient, roundId: string): Promise<void> {
  const room = (await db.query<{ status: string }>(
    'SELECT room.status FROM rooms room JOIN rounds r ON r.room_id = room.id WHERE r.id = $1 FOR UPDATE OF room',
    [roundId],
  )).rows[0];
  if (!room) throw new RoomError('ROUND_NOT_FOUND', 404);
  if (room.status !== 'ACTIVE') throw new RoomError('ROOM_NOT_ACTIVE', 409);
}
