import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface Session {
  id: string;
  nickname: string;
  expiresAt: Date;
  named: boolean;
}

export interface SessionStore {
  insert(input: Session & { tokenHash: string }): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  nameGuest(tokenHash: string, nickname: string, now: Date, expiresAt: Date): Promise<Session | null>;
  revoke(tokenHash: string): Promise<void>;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function parseSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  const pair = header.split(';').map(part => part.trim()).find(part => part.startsWith('echo_session='));
  const value = pair?.slice('echo_session='.length) ?? '';
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export async function createAnonymousSession(store: SessionStore, nickname: string | undefined, now: Date): Promise<{ session: Session; token: string }> {
  const token = randomBytes(32).toString('base64url');
  const named = nickname !== undefined;
  const session = { id: randomUUID(), nickname: nickname ?? '访客', expiresAt: sessionExpiry(now, named), named };
  await store.insert({ ...session, tokenHash: hashToken(token) });
  return { session, token };
}

export function sessionExpiry(now: Date, named: boolean): Date {
  const hours = named ? 30 * 24 : 12;
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

export async function findSession(store: SessionStore, cookie: string | undefined, now: Date): Promise<Session | null> {
  const token = parseSessionCookie(cookie);
  if (!token) return null;
  const session = await store.findByTokenHash(hashToken(token));
  return session && session.expiresAt.getTime() > now.getTime() ? session : null;
}

export function sessionCookie(token: string, secure: boolean, expiresAt: Date, now: Date): string {
  const maxAge = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
  return `echo_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function expiredCookie(secure: boolean): string {
  return `echo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}
