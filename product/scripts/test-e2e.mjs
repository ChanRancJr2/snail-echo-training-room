import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const database = 'postgres://echo:dev_only_change_me@127.0.0.1:15432/echo';
const redis = 'redis://127.0.0.1:16379';
const port = process.env.ECHO_E2E_PORT ?? '3100';
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('ECHO_E2E_PORT must be between 1024 and 65535');
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: 'development', PORT: port, WEB_ROOT: 'dist/web', PUBLIC_ORIGIN: origin, ECHO_PRODUCT_ORIGIN: origin, DATABASE_URL: database, REDIS_URL: redis,
  S3_ENDPOINT: 'http://127.0.0.1:18333', S3_REGION: 'us-east-1', S3_BUCKET: 'echo-private', S3_ACCESS_KEY: 'dev_echo_access', S3_SECRET_KEY: 'dev_echo_secret_only',
  ENCRYPTION_MASTER_KEY: randomBytes(32).toString('base64'), AI_MODE: 'mock' };
const children = [];
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env, stdio: 'inherit', ...options });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
const launch = (args) => {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let recent = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { recent = (recent + chunk.toString()).slice(-8000); });
  child.recentOutput = () => recent;
  children.push(child);
  return child;
};
const waitFor = async (url, child) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited while waiting for ${url}`);
    try { if ((await fetch(url)).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not become ready: ${url}`);
};

try {
  await run(process.platform === 'win32' ? 'docker.exe' : 'docker', ['compose', '-f', 'compose.dev.yml', 'up', '-d', '--wait']);
  await run(process.execPath, ['--experimental-strip-types', 'apps/api/src/migrate.ts'], { shell: false });
  await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'apps/web/vite.config.ts']);
  const api = launch(['--experimental-strip-types', 'apps/api/src/main.ts']);
  const comparisonWorker = launch(['--experimental-strip-types', 'apps/api/src/worker.ts']);
  try {
    await waitFor(`${origin}/health/ready`, api);
    await run(process.execPath, ['tests/room.browser.mjs']);
    await run(process.execPath, ['tests/modes.browser.mjs']);
    await run(process.execPath, ['tests/solo-practice.browser.mjs']);
  }
  catch (error) { process.stderr.write(`API exit=${api.exitCode} signal=${api.signalCode}: ${api.recentOutput()}\nWORKER exit=${comparisonWorker.exitCode} signal=${comparisonWorker.signalCode}: ${comparisonWorker.recentOutput()}\n`); throw error; }
} finally {
  for (const child of children) child.kill();
}
