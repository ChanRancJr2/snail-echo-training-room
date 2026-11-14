import type { Pool } from 'pg';
import type { Session, SessionStore } from './sessions.ts';

export class PgSessionStore implements SessionStore {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async insert(input: Session & { tokenHash: string }): Promise<void> {
    await this.pool.query(
      'INSERT INTO sessions (id, nickname, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [input.id, input.nickname, input.tokenHash, input.expiresAt],
    );
  }

  async findByTokenHash(tokenHash: string): Promise<Session | null> {
    const result = await this.pool.query<{ id: string; nickname: string; expires_at: Date }>(
      'SELECT id, nickname, expires_at FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL',
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? { id: row.id, nickname: row.nickname, expiresAt: row.expires_at } : null;
  }

  async revoke(tokenHash: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash]);
  }
}
