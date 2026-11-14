import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_ORIGIN: z.url(),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  ENCRYPTION_MASTER_KEY: z.string().default(''),
  S3_ENDPOINT: z.url(),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY: z.string().default(''),
  S3_SECRET_KEY: z.string().default(''),
  AI_MODE: z.enum(['mock', 'real']).default('mock'),
  ARK_API_KEY: z.string().default(''),
  ARK_MODEL_ID: z.string().default(''),
  SPEECH_API_KEY: z.string().default(''),
  SPEECH_FILE_RESOURCE_ID: z.string().default(''),
});

export type Config = z.infer<typeof schema>;

export function readConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  const config = parsed.data;
  const missing: string[] = [];
  if (config.NODE_ENV === 'production') {
    if (!config.PUBLIC_ORIGIN.startsWith('https://')) missing.push('PUBLIC_ORIGIN must be HTTPS');
    if (Buffer.from(config.ENCRYPTION_MASTER_KEY, 'base64').length !== 32) missing.push('ENCRYPTION_MASTER_KEY');
    if (!config.S3_ACCESS_KEY) missing.push('S3_ACCESS_KEY');
    if (!config.S3_SECRET_KEY) missing.push('S3_SECRET_KEY');
    if (config.AI_MODE !== 'real') missing.push('AI_MODE must be real');
  }
  if (config.AI_MODE === 'real') {
    for (const name of ['ARK_API_KEY', 'ARK_MODEL_ID', 'SPEECH_API_KEY', 'SPEECH_FILE_RESOURCE_ID'] as const) {
      if (!config[name]) missing.push(name);
    }
  }
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(', ')}`);
  return config;
}
