import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist/apps/api/migrations', { recursive: true });
await cp('apps/api/migrations', 'dist/apps/api/migrations', { recursive: true });
