import type { Pool } from 'pg';
import type { Session, SessionStore } from './sessions.ts';

type SessionRow = { id: string; nickname: string; expires_at: Date; named: boolean };

function toSession(row: SessionRow | undefined): Session | null {
  return row ? { id: row.id, nickname: row.nickname, expiresAt: row.expires_at, named: row.named } : null;
}

export class PgSessionStore implements SessionStore {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async insert(input: Session & { tokenHash: string }): Promise<void> {
    await this.pool.query(
      'INSERT INTO sessions (id, nickname, token_hash, expires_at, named) VALUES ($1, $2, $3, $4, $5)',
      [input.id, input.nickname, input.tokenHash, input.expiresAt, input.named],
    );
  }

  async findByTokenHash(tokenHash: string): Promise<Session | null> {
    const result = await this.pool.query<SessionRow>(
      'SELECT id, nickname, expires_at, named FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL',
      [tokenHash],
    );
    return toSession(result.rows[0]);
  }

  async nameGuest(tokenHash: string, nickname: string, now: Date, expiresAt: Date): Promise<Session | null> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE sessions SET nickname = $2, named = TRUE, expires_at = $4
       WHERE token_hash = $1 AND NOT named AND expires_at > $3 AND revoked_at IS NULL
       RETURNING id, nickname, expires_at, named`,
      [tokenHash, nickname, now, expiresAt],
    );
    return toSession(result.rows[0]);
  }

  async revoke(tokenHash: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash]);
  }
}
