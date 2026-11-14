import assert from 'node:assert/strict';
import test from 'node:test';
import { toMp3 } from '../src/transcode.ts';

test('browser-compatible audio is normalized to an MP3 file for file ASR', { skip: !process.env.FFMPEG_PATH }, async () => {
  const samples = 16000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 10000), 44 + i * 2);
  const mp3 = await toMp3(wav, process.env.FFMPEG_PATH!);
  assert.ok(mp3.length > 1000);
  assert.ok(mp3.subarray(0, 3).toString() === 'ID3' || mp3[0] === 0xff);
  await assert.rejects(toMp3(Buffer.alloc(15_000_001), process.env.FFMPEG_PATH!));
});
