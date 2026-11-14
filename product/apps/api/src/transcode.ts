import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function toMp3(input: Buffer, ffmpegPath: string, timeoutMs = 30_000): Promise<Buffer> {
  if (!ffmpegPath) throw new Error('FFMPEG_PATH_REQUIRED');
  if (!input.length || input.length > 15_000_000) throw new Error('INVALID_AUDIO_SIZE');
  const directory = await mkdtemp(join(tmpdir(), 'echo-audio-'));
  try {
    const source = join(directory, 'source');
    const output = join(directory, 'normalized.mp3');
    await writeFile(source, input);
    await new Promise<void>((resolve, reject) => {
      const process = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-threads', '1', '-i', source,
        '-t', '305', '-map', '0:a:0', '-vn', '-threads', '1', '-ac', '1', '-ar', '16000', '-b:a', '64k', output], { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { process.kill(); reject(new Error('AUDIO_CONVERSION_TIMEOUT')); }, timeoutMs);
      process.once('error', error => { clearTimeout(timer); reject(error); });
      process.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('AUDIO_CONVERSION_FAILED')); });
    });
    const mp3 = await readFile(output);
    if (!mp3.length || mp3.length > 30_000_000) throw new Error('INVALID_TRANSCODED_AUDIO');
    return mp3;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
