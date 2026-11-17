import { defineComponent, ref, type PropType, type Ref } from 'vue';
import { boundedFetch as fetch } from './client.ts';

export const AudioPlayer = defineComponent({
  props: {
    roundId: String,
    audioId: String,
    src: String,
    audioRef: { type: Object as PropType<Ref<HTMLAudioElement | null>>, required: true },
    label: { type: String, default: '表达者录音' },
    tracksReplay: Boolean,
    buttonOnly: Boolean,
    blocked: Boolean,
  },
  setup(props, { slots }) {
    const pending = ref(false);
    const state = ref<'new' | 'playing' | 'paused' | 'heard'>('new');
    const error = ref('');

    function setAudioElement(element: unknown) {
      props.audioRef.value = element instanceof HTMLAudioElement ? element : null;
    }

    async function toggle() {
      const { audioRef, blocked, roundId, audioId, src, tracksReplay } = props;
      const audio = audioRef.value;
      if (!audio || pending.value || blocked) return;
      if (state.value === 'playing') { audio.pause(); state.value = 'paused'; return; }
      if (src) {
        if (audio.ended) audio.currentTime = 0;
        error.value = '';
        try { await audio.play(); }
        catch { error.value = '暂时无法播放，请重新点击播放。'; }
        return;
      }
      if (!roundId || !audioId) return;
      if (state.value === 'paused' && audio.src) {
        try { await audio.play(); state.value = 'playing'; error.value = ''; }
        catch { audio.removeAttribute('src'); state.value = 'new'; error.value = '暂时无法播放，请重新点击播放。'; }
        return;
      }
      const replay = state.value === 'heard' && tracksReplay;
      error.value = '';
      pending.value = true;
      try {
        let response: Response | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { response = await fetch(`/api/rounds/${roundId}/audio/${audioId}/access`); }
          catch { response = null; }
          if (response && ![502, 503, 504].includes(response.status)) break;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
        }
        if (!response?.ok) throw new Error('暂时无法播放，请稍后重试。');
        if (replay) {
          const aid = await fetch(`/api/rounds/${roundId}/listening-aid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'replay' }) });
          if (!aid.ok) throw new Error('暂时无法记录重听，请重试。');
        }
        const result = await response.json() as { url: string };
        if (audioRef.value !== audio) return;
        audio.src = result.url;
        audio.load();
        try { await audio.play(); state.value = 'playing'; }
        catch { state.value = 'paused'; error.value = '请再点一次「继续播放」。'; }
      } catch (cause) { error.value = cause instanceof Error ? cause.message : '播放失败'; }
      finally { pending.value = false; }
    }

    return () => {
      const playbackButton = <button type="button" class="secondary" disabled={pending.value || props.blocked} onClick={() => void toggle()}>{pending.value ? '正在加载录音…' : state.value === 'playing' ? '暂停播放' : state.value === 'paused' ? '继续播放' : state.value === 'heard' ? '已听过 · 再听一次' : `播放${props.label}`}</button>;
      return <div class="audio-player" data-recording-label={props.label}>
        {slots.action ? <div class="audio-player-actions">{playbackButton}{slots.action()}</div> : playbackButton}
        <audio ref={setAudioElement} src={props.src} controls={!props.blocked && !props.tracksReplay && !props.buttonOnly} aria-label={props.label} preload="none" onPlay={() => { if (props.blocked) props.audioRef.value?.pause(); else state.value = 'playing'; }} onPause={() => { if (state.value === 'playing') state.value = 'paused'; }} onEnded={() => { state.value = 'heard'; }} />
        {error.value && <p role="alert" class="error-text">{error.value}</p>}
      </div>;
    };
  },
});
