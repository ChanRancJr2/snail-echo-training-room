import { useEffect, useRef, useState } from 'react';
import { boundedFetch as fetch, newRequestId } from './client.ts';
import { captureAudio } from './capture.ts';

type UploadResult = { audioId: string; status: string; uploadUrl: string | null };
type CommitResult = { audioId: string; status: string; round: { stage: string } };
const uploadMessages: Record<string, string> = {
  UNSUPPORTED_AUDIO: '这次录音的文件无法识别，请删除后重新录音。',
  INVALID_AUDIO: '录音格式或大小不符合要求，请重新录音。',
  UPLOAD_NOT_VERIFIED: '录音没有完整上传，请再次点击确认上传。',
  STALE_AUDIO: '录音已不是本轮最新版本，请删除后重新录音。',
  STALE_VERSION: '本轮状态已变化，请检查当前页面后重试。',
  ROUND_NOT_FOUND: '本轮已结束，请返回训练室开始下一轮。',
  ROOM_NOT_ACTIVE: '本轮已结束，请返回训练室开始下一轮。',
  WRONG_STAGE: '本轮录音阶段已结束，请检查训练室状态。',
  CONSENT_REQUIRED: '请先确认复述录音转写说明。',
  RATE_LIMITED: '上传操作太频繁，请稍后重试。',
};

export function Recorder({ roundId, kind, version, maxSeconds, onBegin, onCommitted, onCaptureChange }: { roundId: string; kind: 'speaker' | 'listener'; version: number; maxSeconds: number; onBegin: () => Promise<number>; onCommitted: () => Promise<void>; onCaptureChange?: (active: boolean) => void }) {
  const capture = useRef<Awaited<ReturnType<typeof captureAudio>> | null>(null);
  const commitVersion = useRef(version);
  const elapsed = useRef(0);
  const resumedAt = useRef<number | null>(null);
  const finishing = useRef(false);
  const uploading = useRef(false);
  const idempotencyKey = useRef<string | null>(null);
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'paused' | 'finishing' | 'ready' | 'uploading'>('idle');
  const [audio, setAudio] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const [listenerConsent, setListenerConsent] = useState(false);
  const recordedMs = () => elapsed.current + (resumedAt.current === null ? 0 : performance.now() - resumedAt.current);
  useEffect(() => {
    if (state !== 'recording') return;
    const tick = () => setSeconds(Math.min(maxSeconds, Math.floor(recordedMs() / 1000)));
    const interval = window.setInterval(tick, 200);
    const end = window.setTimeout(() => void finish(), Math.max(0, maxSeconds * 1000 - recordedMs()));
    return () => { window.clearInterval(interval); window.clearTimeout(end); };
  }, [state, maxSeconds]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      capture.current?.close();
      capture.current = null;
    };
  }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function begin() {
    if (state !== 'idle') return;
    setState('starting');
    onCaptureChange?.(true);
    setError('');
    let context: AudioContext | null = null;
    let media: MediaStream | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持录音，请在系统浏览器中打开邀请链接。');
      try { context = new AudioContext(); void context.resume().catch(() => undefined); } catch { /* Native recording can still run. */ }
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) return;
      const next = await captureAudio(media, context);
      if (!mounted.current) { next.close(); return; }
      capture.current = next;
      if (context?.state === 'suspended') void context.resume().catch(() => undefined);
      commitVersion.current = await onBegin();
      if (!mounted.current) return;
      next.start(); elapsed.current = 0; resumedAt.current = performance.now(); setSeconds(0); setState('recording');
    } catch (cause) {
      capture.current?.close(); capture.current = null;
      if (mounted.current) { onCaptureChange?.(false); setError(cause instanceof DOMException ? '无法使用麦克风，请检查浏览器录音权限。' : cause instanceof Error ? cause.message : '无法录音，请重试。'); setState('idle'); }
    } finally {
      if (!capture.current) {
        media?.getTracks().forEach(track => track.stop());
        if (context && context.state !== 'closed') void context.close().catch(() => undefined);
      }
    }
  }
  function toggle() {
    if (!capture.current || finishing.current) return;
    if (state === 'recording') {
      capture.current.pause(); elapsed.current = recordedMs(); resumedAt.current = null;
      setSeconds(Math.min(maxSeconds, Math.floor(elapsed.current / 1000))); setState('paused');
    } else if (state === 'paused') {
      capture.current.resume(); resumedAt.current = performance.now(); setState('recording');
    }
  }
  async function finish() {
    if (!capture.current || finishing.current) return;
    finishing.current = true;
    const current = capture.current;
    elapsed.current = recordedMs(); resumedAt.current = null;
    setSeconds(Math.min(maxSeconds, Math.floor(elapsed.current / 1000)));
    setState('finishing');
    try {
      const blob = await current.finish(elapsed.current);
      if (mounted.current && capture.current === current) { setAudio(blob); setPreview(URL.createObjectURL(blob)); setState('ready'); }
    } catch (cause) {
      if (mounted.current && capture.current === current) { setError(cause instanceof Error ? cause.message : '录音保存失败，请重录。'); setState('idle'); }
    } finally {
      finishing.current = false;
      if (capture.current === current) { capture.current = null; onCaptureChange?.(false); }
    }
  }
  function remove() {
    capture.current?.close(); capture.current = null;
    elapsed.current = 0; resumedAt.current = null;
    onCaptureChange?.(false);
    setAudio(null); setPreview(null); setSeconds(0); setState('idle'); setError(''); setListenerConsent(false); idempotencyKey.current = null;
  }
  async function upload() {
    if (!audio || uploading.current) return;
    uploading.current = true;
    setState('uploading'); setError('');
    try {
      idempotencyKey.current ??= newRequestId();
      const request = await fetch(`/api/rounds/${roundId}/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, mimeType: audio.type, byteSize: audio.size, idempotencyKey: idempotencyKey.current }) });
      const data = await request.json() as UploadResult & { error?: string };
      if (!request.ok) throw new Error(uploadMessages[data.error ?? ''] ?? '无法申请上传，请重试。');
      if (data.uploadUrl) {
        const put = await fetch(data.uploadUrl, { method: 'PUT', headers: { 'Content-Type': audio.type }, body: audio }, 60000);
        if (!put.ok) throw new Error('录音上传失败，请重试。');
      }
      const commit = await fetch(`/api/rounds/${roundId}/uploads/${data.audioId}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: commitVersion.current, transcribe: kind === 'speaker', consentToTranscribe: kind === 'listener' && listenerConsent }) });
      const result = await commit.json() as CommitResult & { error?: string };
      if (!commit.ok) throw new Error(uploadMessages[result.error ?? ''] ?? '无法确认上传，请重试。');
      await onCommitted();
    } catch (cause) { setError(cause instanceof TypeError || cause instanceof DOMException ? '网络中断或请求超时，录音仍在，请重试上传。' : cause instanceof Error ? cause.message : '上传失败，请重试。'); setState('ready'); }
    finally { uploading.current = false; }
  }
  return <section className="recorder"><h2>{kind === 'speaker' ? '表达录音' : '复述录音'}</h2>
    <p>最长 {maxSeconds} 秒。录音仅在确认上传后发送；可暂停、预听或删除重录。</p>
    <div className="record-time">{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</div>
    {error && <p role="alert" className="error-text">{error}</p>}
    {state === 'idle' && <button className="primary" onClick={() => void begin()}>开始录音</button>}
    {state === 'starting' && <p>正在获取录音权限并同步本轮计时…</p>}
    {(state === 'recording' || state === 'paused') && <><button className="secondary" onClick={toggle}>{state === 'recording' ? '暂停录音' : '继续录音'}</button><button className="primary" onClick={() => void finish()}>结束录音</button></>}
    {state === 'finishing' && <p role="status">正在保存这次录音…</p>}
    {(state === 'recording' || state === 'paused' || state === 'ready') && <button className="secondary" onClick={remove}>删除录音，重新录入</button>}
    {state === 'ready' && <><audio controls src={preview ?? undefined} />{kind === 'speaker' && <div className="transcription-choice">确认上传后会自动转写</div>}{kind === 'listener' && <label className="transcription-consent"><input type="checkbox" checked={listenerConsent} onChange={event => setListenerConsent(event.target.checked)} /> 我知晓复述录音提交后会被转写，用于本轮逐条对照。</label>}<button className="primary" disabled={kind === 'listener' && !listenerConsent} onClick={() => void upload()}>确认上传</button></>}
    {state === 'uploading' && <p>正在上传并确认，请稍候…</p>}
    {kind === 'speaker' && state !== 'ready' && <p>确认上传后自动转写，可在本轮信息点页面查看。</p>}
  </section>;
}
