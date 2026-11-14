import pg from 'pg';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { readConfig } from './config.ts';
import { TextCipher } from './crypto.ts';
import { PgComparisonStore } from './comparisons.ts';
import { PgRoomStore } from './rooms.ts';
import { PgDeletionStore } from './deletions.ts';
import { S3AudioStorage } from './audio-storage.ts';
import { toMp3 } from './transcode.ts';
import { VolcAiProvider, type ComparedPoint } from './ai-provider.ts';

try { process.loadEnvFile('.env'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const config = readConfig(process.env);
if (!config.ENCRYPTION_MASTER_KEY || !config.S3_ACCESS_KEY || !config.S3_SECRET_KEY) throw new Error('Worker storage and encryption configuration required');
if (config.AI_MODE === 'real' && !process.env.FFMPEG_PATH) throw new Error('FFMPEG_PATH_REQUIRED');
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
const cipher = new TextCipher(config.ENCRYPTION_MASTER_KEY);
const comparisons = new PgComparisonStore(pool, cipher);
const rooms = new PgRoomStore(pool);
const deletions = new PgDeletionStore(pool);
const storage = new S3AudioStorage({ endpoint: config.S3_ENDPOINT, publicEndpoint: config.S3_PUBLIC_ENDPOINT, region: config.S3_REGION, bucket: config.S3_BUCKET,
  accessKey: config.S3_ACCESS_KEY, secretKey: config.S3_SECRET_KEY });
const provider = config.AI_MODE === 'real' ? new VolcAiProvider({ speechKey: config.SPEECH_API_KEY,
  resourceId: config.SPEECH_FILE_RESOURCE_ID, arkKey: config.ARK_API_KEY, modelId: config.ARK_MODEL_ID }) : null;
const producerRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
const workerRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
type AudioJob = { roundId: string; speakerAudioId?: string };
const queue = new Queue<AudioJob>('echo-comparison', { connection: producerRedis,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: false, removeOnFail: false } });
queue.on('error', error => process.stderr.write(`comparison queue error: ${error.name}\n`));

async function transcribeAudio(roundId: string, audioId: string, audioKey: string): Promise<string> {
  if (!provider) return '演示转写：这段文字仅用于本地联调。';
  const normalizedKey = `rounds/${roundId}/temporary/${audioId}.mp3`;
  try {
    const bytes = await storage.read(audioKey);
    const mp3 = await toMp3(bytes, process.env.FFMPEG_PATH ?? '');
    await storage.write(normalizedKey, mp3, 'audio/mpeg');
    return await provider.transcribe(await storage.downloadUrl(normalizedKey, 600));
  } finally { await storage.remove(normalizedKey).catch(() => undefined); }
}

const worker = new Worker<AudioJob>('echo-comparison', async job => {
  if (job.data.speakerAudioId) {
    const { roundId, speakerAudioId } = job.data;
    const key = await comparisons.speakerAudioKey(roundId, speakerAudioId);
    if (key) {
      const transcript = await transcribeAudio(roundId, speakerAudioId, key);
      const candidates = provider ? await provider.extract(transcript).catch(() => []) : [];
      await comparisons.saveSpeakerTranscript(roundId, speakerAudioId, transcript, candidates);
    }
    return;
  }
  const input = await comparisons.input(job.data.roundId);
  if (!input) return;
  let transcript: string;
  let compared: ComparedPoint[];
  if (!provider) {
    transcript = '演示转写：复述者提到了部分信息，具体内容仅用于本地联调。';
    compared = input.points.map((point, index) => ({ id: point.id, complete: index === 0, accurate: index === 0,
      listenerQuote: index === 0 ? '复述者提到了部分信息' : '', tag: index === 0 ? null : '遗漏重要信息', clarification: null }));
  } else {
    transcript = await transcribeAudio(job.data.roundId, input.audioId, input.audioKey);
    compared = await provider.compare(input.points, transcript);
  }
  await comparisons.complete(job.data.roundId, input.audioId, transcript, compared);
}, { connection: workerRedis, concurrency: Number(process.env.COMPARISON_CONCURRENCY ?? 2) });
worker.on('error', error => process.stderr.write(`comparison worker error: ${error.name}\n`));
worker.on('failed', (job, error) => {
  const code = /^[A-Z][A-Z0-9_]{2,60}$/.test(error.message) ? error.message : 'AUDIO_PROCESSING_ERROR';
  process.stderr.write(`comparison job failed id=${job?.id ?? 'unknown'} code=${code}\n`);
  if (job && !job.data.speakerAudioId && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    void rooms.failComparison(job.data.roundId).catch(() => process.stderr.write('comparison failure state update failed\n'));
  }
});

const scan = async () => {
  for (const roundId of await comparisons.pendingRoundIds()) {
    await queue.add('compare', { roundId }, { jobId: roundId });
  }
  for (const { roundId, audioId } of await comparisons.pendingSpeakerTranscripts()) {
    await queue.add('speaker-transcript', { roundId, speakerAudioId: audioId }, { jobId: `speaker-${audioId}` });
  }
};
await scan();
const scanner = setInterval(() => { void scan().catch(error => process.stderr.write(`comparison scan failed: ${error.name}\n`)); }, 2000);
const purger = setInterval(() => { void deletions.purgeAudio(key => storage.remove(key)).catch(() => process.stderr.write('audio purge failed\n')); }, 30_000);
const close = async () => { clearInterval(scanner); clearInterval(purger); await worker.close(); await queue.close(); await Promise.all([producerRedis.quit(), workerRedis.quit(), pool.end()]); };
process.once('SIGTERM', () => { void close().then(() => process.exit(0)); });
process.once('SIGINT', () => { void close().then(() => process.exit(0)); });
