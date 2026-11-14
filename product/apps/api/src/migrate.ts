import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

try { process.loadEnvFile('.env'); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const directory = new URL('../migrations/', import.meta.url);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  await client.query('SELECT pg_advisory_lock(71234102)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir(directory)).filter(file => /^\d+_.*\.sql$/.test(file)).sort()) {
    if ((await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name])).rowCount) continue;
    let sql = await readFile(new URL(name, directory), 'utf8');
    sql = sql.replace(/^BEGIN;\s*/i, '').replace(/\s*COMMIT;\s*$/i, '');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      process.stdout.write(`Database migration ${name} completed\n`);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock(71234102)');
  client.release();
  await pool.end();
}
