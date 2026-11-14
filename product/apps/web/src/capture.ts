import { detectAudioMime, maxAudioBytes } from '../../../packages/core/src/audio.ts';
import pcmModule from './pcm-worklet.js?url&no-inline';

const formats = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

export async function captureAudio(stream: MediaStream, context: AudioContext | null) {
  const chunks: Blob[] = [];
  const pcm: ArrayBuffer[] = [];
  let recorder: MediaRecorder | undefined;
  let node: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let nativeFailed = false;
  let nativeStopped = false;
  let resolveNative: (() => void) | undefined;
  let resolvePcm: (() => void) | undefined;
  if (typeof MediaRecorder === 'function') {
    try {
      const mimeType = formats.find(format => MediaRecorder.isTypeSupported?.(format));
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
      recorder.onerror = () => { nativeFailed = true; resolveNative?.(); };
      recorder.onstop = () => { nativeStopped = true; resolveNative?.(); };
    } catch { recorder = undefined; }
  }
  if (context?.audioWorklet && context.sampleRate >= 16000) {
    try {
      await context.audioWorklet.addModule(pcmModule);
      source = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context, 'echo-pcm-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = ({ data }: MessageEvent<ArrayBuffer | 'finished'>) => {
        if (data === 'finished') resolvePcm?.();
        else pcm.push(data);
      };
      // The worklet's output is silence. Connecting it keeps the audio graph running.
      source.connect(node);
      node.connect(context.destination);
    } catch { source?.disconnect(); node?.disconnect(); node = undefined; }
  }
  if (!recorder && !node) throw new Error('当前浏览器无法录音，请尝试在系统浏览器中打开邀请链接。');

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (recorder) {
      recorder.ondataavailable = null; recorder.onerror = null; recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    source?.disconnect();
    node?.disconnect();
    node?.port.close();
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
    stream.getTracks().forEach(track => track.stop());
  };
  return {
    start() {
      try { recorder?.start(); } catch (error) { if (!node) throw error; nativeFailed = true; }
      node?.port.postMessage('record');
    },
    pause() {
      try { if (recorder?.state === 'recording') recorder.pause(); } catch { nativeFailed = true; }
      node?.port.postMessage('pause');
    },
    resume() {
      try { if (recorder?.state === 'paused') recorder.resume(); } catch { nativeFailed = true; }
      node?.port.postMessage('record');
    },
    async finish(elapsedMs: number): Promise<Blob> {
      let watchdog: number | undefined;
      try {
        const native = !recorder || nativeFailed || nativeStopped ? Promise.resolve() : new Promise<void>(resolve => {
          resolveNative = resolve;
          try { if (recorder.state !== 'inactive') recorder.stop(); } catch { nativeFailed = true; resolve(); }
        });
        const fallback = node ? new Promise<void>(resolve => { resolvePcm = resolve; node.port.postMessage('finish'); }) : Promise.resolve();
        await Promise.race([Promise.all([native, fallback]), new Promise<void>(resolve => { watchdog = window.setTimeout(resolve, 2500); })]);
        const recorded = new Blob(chunks);
        if (nativeStopped && !nativeFailed && recorded.size >= 64 && recorded.size <= maxAudioBytes) {
          const mime = detectAudioMime(new Uint8Array(await recorded.slice(0, 16).arrayBuffer()));
          if (mime) return recorded.slice(0, recorded.size, mime);
        }
        const bytes = pcm.reduce((total, part) => total + part.byteLength, 0);
        if (bytes >= Math.max(3200, Math.min(elapsedMs, 300_000) * 32 * 0.8)) return wave(pcm, bytes);
        throw new Error('这次录音没有生成完整音频，请重新录音。');
      } finally { window.clearTimeout(watchdog); close(); }
    },
    close,
  };
}

function wave(parts: ArrayBuffer[], bytes: number): Blob {
  const header = new DataView(new ArrayBuffer(44));
  header.setUint32(0, 0x52494646);
  header.setUint32(4, 36 + bytes, true);
  header.setUint32(8, 0x57415645);
  header.setUint32(12, 0x666d7420);
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, 16000, true);
  header.setUint32(28, 32000, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  header.setUint32(36, 0x64617461);
  header.setUint32(40, bytes, true);
  return new Blob([header.buffer, ...parts], { type: 'audio/wav' });
}
