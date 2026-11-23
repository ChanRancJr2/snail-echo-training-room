import { defineComponent, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue';
import { boundedFetch as fetch, newRequestId } from './client.ts';
import { captureAudio } from './capture.ts';

type UploadResult = { audioId: string; status: string; uploadUrl: string | null };
type CommitResult = { audioId: string; status: string; round: { stage: string } };
type RecorderState = 'idle' | 'starting' | 'recording' | 'paused' | 'finishing' | 'ready' | 'uploading';

const uploadMessages: Record<string, string> = {
  UNSUPPORTED_AUDIO: '这次录音的文件无法识别，请删除后重新录音。',
  INVALID_AUDIO: '录音格式或大小不符合要求，请重新录音。',
  UPLOAD_NOT_VERIFIED: '录音没有完整上传，请再次点击确认上传。',
  STALE_AUDIO: '录音已不是本轮最新版本，请删除后重新录音。',
  STALE_VERSION: '本轮状态已变化，请检查当前页面后重试。',
  ROUND_NOT_FOUND: '本轮已结束，请返回训练室开始下一轮。',
  ROOM_NOT_ACTIVE: '本轮已结束，请返回训练室开始下一轮。',
  WRONG_STAGE: '本轮录音阶段已结束，请检查训练室状态。',
  CONSENT_REQUIRED: '请重新点击「确认上传并转写」。',
  RATE_LIMITED: '上传操作太频繁，请稍后重试。',
};

export const Recorder = defineComponent({
  props: {
    roundId: { type: String, required: true },
    kind: { type: String as PropType<'speaker' | 'listener'>, required: true },
    version: { type: Number, required: true },
    maxSeconds: { type: Number, required: true },
    onBegin: { type: Function as PropType<() => Promise<number>>, required: true },
    onCommitted: { type: Function as PropType<() => Promise<void>>, required: true },
    onSubmitRecording: Function as PropType<(audio: Blob) => void | Promise<void>>,
    onCaptureChange: Function as PropType<(active: boolean) => void>,
    onRecordingStarted: Function as PropType<() => void>,
  },
  setup(props) {
    let capture: Awaited<ReturnType<typeof captureAudio>> | null = null;
    let commitVersion = props.version;
    let elapsed = 0;
    let resumedAt: number | null = null;
    let idempotencyKey: string | null = null;
    let audio: Blob | null = null;
    let mounted = false;
    const state = ref<RecorderState>('idle');
    const preview = ref<string | null>(null);
    const seconds = ref(0);
    const error = ref('');
    const recordedMs = () => elapsed + (resumedAt === null ? 0 : performance.now() - resumedAt);

    watch([state, () => props.maxSeconds], ([status, maxSeconds], _, onCleanup) => {
      if (status !== 'recording') return;
      const tick = () => { seconds.value = Math.min(maxSeconds, Math.floor(recordedMs() / 1000)); };
      const interval = window.setInterval(tick, 200);
      const end = window.setTimeout(() => void finish(), Math.max(0, maxSeconds * 1000 - recordedMs()));
      onCleanup(() => {
        window.clearInterval(interval);
        window.clearTimeout(end);
      });
    });

    onMounted(() => { mounted = true; });
    onBeforeUnmount(() => {
      mounted = false;
      capture?.close();
      capture = null;
      clearPreview();
    });

    function clearPreview() {
      if (preview.value) URL.revokeObjectURL(preview.value);
      preview.value = null;
    }

    async function begin() {
      if (state.value !== 'idle') return;
      const { onBegin, onCaptureChange } = props;
      state.value = 'starting';
      onCaptureChange?.(true);
      error.value = '';
      let context: AudioContext | null = null;
      let media: MediaStream | undefined;
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持录音，请在系统浏览器中打开邀请链接。');
        try { context = new AudioContext(); void context.resume().catch(() => undefined); } catch { /* Native recording can still run. */ }
        media = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!mounted) return;
        const next = await captureAudio(media, context);
        if (!mounted) { next.close(); return; }
        capture = next;
        if (context?.state === 'suspended') void context.resume().catch(() => undefined);
        commitVersion = await onBegin();
        if (!mounted) return;
        next.start();
        elapsed = 0;
        resumedAt = performance.now();
        seconds.value = 0;
        state.value = 'recording';
        props.onRecordingStarted?.();
      } catch (cause) {
        capture?.close();
        capture = null;
        if (mounted) {
          onCaptureChange?.(false);
          error.value = cause instanceof DOMException ? '无法使用麦克风，请检查浏览器录音权限。' : cause instanceof Error ? cause.message : '无法录音，请重试。';
          state.value = 'idle';
        }
      } finally {
        if (!capture) {
          media?.getTracks().forEach(track => track.stop());
          if (context && context.state !== 'closed') void context.close().catch(() => undefined);
        }
      }
    }

    function toggle() {
      if (!capture) return;
      if (state.value === 'recording') {
        capture.pause();
        elapsed = recordedMs();
        resumedAt = null;
        seconds.value = Math.min(props.maxSeconds, Math.floor(elapsed / 1000));
        state.value = 'paused';
      } else if (state.value === 'paused') {
        capture.resume();
        resumedAt = performance.now();
        state.value = 'recording';
      }
    }

    async function finish() {
      if (!capture || (state.value !== 'recording' && state.value !== 'paused')) return;
      const current = capture;
      const { maxSeconds, onCaptureChange } = props;
      elapsed = recordedMs();
      resumedAt = null;
      seconds.value = Math.min(maxSeconds, Math.floor(elapsed / 1000));
      state.value = 'finishing';
      try {
        const blob = await current.finish(elapsed);
        if (mounted && capture === current) {
          audio = blob;
          preview.value = URL.createObjectURL(blob);
          state.value = 'ready';
        }
      } catch (cause) {
        if (mounted && capture === current) {
          error.value = cause instanceof Error ? cause.message : '录音保存失败，请重录。';
          state.value = 'idle';
        }
      } finally {
        if (capture === current) {
          capture = null;
          onCaptureChange?.(false);
        }
      }
    }

    function remove() {
      capture?.close();
      capture = null;
      elapsed = 0;
      resumedAt = null;
      props.onCaptureChange?.(false);
      audio = null;
      clearPreview();
      seconds.value = 0;
      state.value = 'idle';
      error.value = '';
      idempotencyKey = null;
    }

    async function upload() {
      const recording = audio;
      if (!recording || state.value !== 'ready') return;
      const { roundId, kind, onCommitted, onSubmitRecording } = props;
      const consentToTranscribe = kind === 'listener';
      state.value = 'uploading';
      error.value = '';
      try {
        if (onSubmitRecording) {
          await onSubmitRecording(recording);
          return;
        }
        idempotencyKey ??= newRequestId();
        const request = await fetch(`/api/rounds/${roundId}/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, mimeType: recording.type, byteSize: recording.size, idempotencyKey }) });
        const data = await request.json() as UploadResult & { error?: string };
        if (!request.ok) throw new Error(uploadMessages[data.error ?? ''] ?? '无法申请上传，请重试。');
        if (data.uploadUrl) {
          const put = await fetch(data.uploadUrl, { method: 'PUT', headers: { 'Content-Type': recording.type }, body: recording }, 60000);
          if (!put.ok) throw new Error('录音上传失败，请重试。');
        }
        const commit = await fetch(`/api/rounds/${roundId}/uploads/${data.audioId}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: commitVersion, transcribe: kind === 'speaker', consentToTranscribe }) });
        const result = await commit.json() as CommitResult & { error?: string };
        if (!commit.ok) throw new Error(uploadMessages[result.error ?? ''] ?? '无法确认上传，请重试。');
        await onCommitted();
      } catch (cause) {
        error.value = cause instanceof TypeError || cause instanceof DOMException ? '网络中断或请求超时，录音仍在，请重试上传。' : cause instanceof Error ? cause.message : '上传失败，请重试。';
        state.value = 'ready';
      }
    }

    return () => <section class="recorder"><h2>{props.kind === 'speaker' ? '表达录音' : '复述录音'}</h2>
      <p>最长 {props.maxSeconds} 秒。录音仅在确认上传后发送；可暂停、预听或删除重录。</p>
      <div class="record-time">{String(Math.floor(seconds.value / 60)).padStart(2, '0')}:{String(seconds.value % 60).padStart(2, '0')}</div>
      {error.value && <p role="alert" class="error-text">{error.value}</p>}
      {state.value === 'idle' && <button class="primary" onClick={() => void begin()}>开始录音</button>}
      {state.value === 'starting' && <p>正在获取录音权限并同步本轮计时…</p>}
      {(state.value === 'recording' || state.value === 'paused') && <><button class="secondary" onClick={toggle}>{state.value === 'recording' ? '暂停录音' : '继续录音'}</button><button class="primary" onClick={() => void finish()}>结束录音</button></>}
      {state.value === 'finishing' && <p role="status">正在保存这次录音…</p>}
      {(state.value === 'recording' || state.value === 'paused' || state.value === 'ready') && <button class="secondary" onClick={remove}>删除录音，重新录入</button>}
      {state.value === 'ready' && <>
        <audio controls src={preview.value ?? ''} />
        <button class="primary" onClick={() => void upload()}>确认上传并转写</button>
      </>}
      {state.value === 'uploading' && <p>正在上传并确认，请稍候…</p>}
    </section>;
  },
});
