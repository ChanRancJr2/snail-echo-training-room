import { computed, defineComponent, h, nextTick, onBeforeUnmount, ref, type PropType } from 'vue';
import { boundedFetch, newRequestId, type PracticeAdvice } from './client.ts';
import { Recorder } from './Recorder.tsx';
import { AudioPlayer } from './AudioPlayer.tsx';
import { MaterialConsentButton } from './MaterialConsentButton.tsx';
import type { PracticeComparisonItem } from './practice-comparison.ts';
import materials from './practice-materials.json' with { type: 'json' };
import './solo-practice.css';

const durations = [[30, '30 秒'], [60, '1 分钟'], [120, '2 分钟'], [300, '5 分钟']] as const;
const steps = ['单人练习', '先听，再用自己的话说', '先看差异', '把误解逐条聊清楚', '收下一条建议', '本轮报告'] as const;
const resolutions = ['真误解', '表达问题', 'AI 误判'] as const;
const javaBackend = import.meta.env.VITE_ECHO_TARGET === 'java';

type Comparison = { rows: PracticeComparisonItem[]; issues: PracticeComparisonItem[];
  total: number; complete: number; accurate: number };
type Analysis = { status: 'pending' | 'ready' | 'failed'; source: 'asr';
  transcript: string | null; comparison: Comparison | null; provider: string | null; failure: string | null };
type Issue = Comparison['issues'][number];
type Resolution = typeof resolutions[number];
type Review = { resolution: Resolution | ''; note: string };
type Playback = 'new' | 'playing' | 'paused' | 'heard';

function comparisonMetrics(result: Comparison) {
  const tags = [...new Set(result.issues.map(item => item.tag).filter(Boolean))];
  return <div class="comparison-grid">
    <div><span>完整度</span><strong>{result.complete} / {result.total}</strong></div>
    <div><span>准确度</span><strong>{result.accurate} / {result.total}</strong></div>
    <div><span>偏差类型</span><strong>{tags.length} 类</strong>{tags.length > 0 && <p>{tags.join('、')}</p>}</div>
    <div><span>可澄清点</span><strong>{result.issues.filter(item => item.question).length} 处</strong></div>
  </div>;
}

function pairedText(item: Issue, retellLabel: string) {
  return <dl class="solo-pair">
    <dt>录音原句</dt><dd>{item.original}</dd>
    <dt>{retellLabel}</dt><dd>{item.retell || '未找到对应句子'}</dd>
  </dl>;
}

export const SoloPractice = defineComponent({
  name: 'SoloPractice',
  props: {
    onExit: { type: Function as PropType<() => void>, required: true },
  },
  setup(props) {
    const step = ref(1);
    const selected = ref(materials[0]!.id);
    const duration = ref(30);
    const material = computed(() => materials.find(item => item.id === selected.value) ?? materials[0]!);
    const heading = ref<HTMLHeadingElement | null>(null);
    const sample = ref<HTMLAudioElement | null>(null);
    const playback = ref<Playback>('new');
    const playPending = ref(false);
    const playError = ref('');
    const capturing = ref(false);
    const hintsOpen = ref(false);
    const analysis = ref<(Analysis & { id: string }) | null>(null);
    const analysisBusy = ref(false);
    const analysisError = ref('');
    let analysisRequest: AbortController | null = null;
    let attemptId = '';
    const retellPreviewUrl = ref('');
    let retellRecording: Blob | null = null;
    const retellPreview = ref<HTMLAudioElement | null>(null);
    const reportSpeaker = ref<HTMLAudioElement | null>(null);
    const reportListener = ref<HTMLAudioElement | null>(null);
    const retellPlaying = ref(false);
    const retellError = ref('');
    const result = computed(() => analysis.value?.comparison ?? null);
    const reviews = ref<Record<string, Review>>({});
    const accepted = ref(false);
    const archiving = ref(false);
    const archiveError = ref('');
    const coaching = ref<PracticeAdvice | null>(null);
    const reviewError = ref('');
    const reviewBusy = ref(false);
    let coachingRequest: AbortController | null = null;
    const retellLabel = '本轮复述转写';

    function go(next: number) {
      if (step.value === 3) retellPreview.value?.pause();
      if (next <= 2 || next === 6) coachingRequest?.abort();
      if (next <= 2) {
        analysisRequest?.abort();
        analysisRequest = null;
        analysisBusy.value = false;
        clearRetellPreview();
      }
      step.value = next;
      void nextTick(() => {
        window.scrollTo(0, 0);
        heading.value?.focus({ preventScroll: true });
      });
    }

    function captureChanged(active: boolean) {
      capturing.value = active;
      if (active) sample.value?.pause();
    }

    async function togglePlayback() {
      const audio = sample.value;
      if (!audio || playPending.value || capturing.value) return;
      if (playback.value === 'playing') {
        audio.pause();
        return;
      }
      if (playback.value === 'heard') audio.currentTime = 0;
      playError.value = '';
      playPending.value = true;
      try {
        await audio.play();
      } catch {
        if (!capturing.value) playError.value = '暂时无法播放，请再试一次。';
      } finally {
        playPending.value = false;
      }
    }

    function reviewFor(id: string) {
      return reviews.value[id] ?? { resolution: '', note: '' };
    }

    function submitRetell(audio: Blob) {
      clearRetellPreview();
      analysis.value = null;
      analysisError.value = '';
      attemptId = '';
      reviews.value = {};
      retellRecording = audio;
      retellPreviewUrl.value = URL.createObjectURL(audio);
      go(3);
      void analyze();
    }

    function clearRetellPreview() {
      retellPreview.value?.pause();
      reportListener.value?.pause();
      reportSpeaker.value?.pause();
      if (retellPreviewUrl.value) URL.revokeObjectURL(retellPreviewUrl.value);
      retellPreviewUrl.value = '';
      retellRecording = null;
      retellPlaying.value = false;
      retellError.value = '';
    }

    async function toggleRetellPreview() {
      const audio = retellPreview.value;
      if (!audio) return;
      if (!audio.paused) { audio.pause(); return; }
      retellError.value = '';
      try { await audio.play(); }
      catch {
        if (retellPreview.value === audio) retellError.value = '暂时无法播放复述录音，请再试一次。';
      }
    }

    async function analyze() {
      if (analysisBusy.value || !retellRecording) return;
      const request = new AbortController();
      analysisRequest = request;
      analysisBusy.value = true;
      analysisError.value = '';
      attemptId ||= newRequestId().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
      const id = attemptId;
      const path = `/api/practice/analysis/${id}`;
      try {
        const data = new FormData();
        data.append('materialId', material.value.id);
        data.append('duration', String(duration.value));
        data.append('consent', 'true');
        data.append('recording', retellRecording, 'retell');
        const submitted = await boundedFetch(path + '/audio', { method: 'POST', body: data, signal: request.signal }, 35000);
        if (!submitted.ok) {
          if (submitted.status === 429) throw new Error('分析暂时繁忙，请稍后重试。');
          throw new Error('暂时无法开始转写，请重试或重新录音。');
        }
        const deadline = Date.now() + 255000;
        while (!request.signal.aborted && Date.now() < deadline) {
          const response = await boundedFetch(path, { signal: request.signal });
          if (!response.ok) throw new Error('暂时无法读取分析结果，请稍后重试。');
          const job = await response.json() as Analysis;
          if (request.signal.aborted) return;
          if (job.status === 'failed') {
            attemptId = '';
            throw new Error(job.failure === 'NO_SPEECH' ? '未识别到清晰语音，请重新录音。' : '本轮分析未完成，请重试或重新录音。');
          }
          if (job.status === 'ready' && job.source === 'asr' && job.comparison && job.transcript) {
            analysis.value = { ...job, id };
            reviews.value = {};
            return;
          }
          await new Promise(resolve => window.setTimeout(resolve, 2000));
        }
        throw new Error('分析超时，请稍后重试。');
      } catch (error) {
        if (!request.signal.aborted) analysisError.value = error instanceof Error ? error.message : '分析暂时不可用。';
      } finally {
        if (analysisRequest === request) {
          analysisRequest = null;
          analysisBusy.value = false;
        }
      }
    }

    async function submitReviews(event: SubmitEvent) {
      event.preventDefault();
      const finished = analysis.value;
      const issues = result.value?.issues;
      if (!finished || !issues || !issues.every(item => reviewFor(item.id).resolution) || reviewBusy.value) return;
      const codes = { '真误解': 'misunderstanding', '表达问题': 'expression', 'AI 误判': 'ai_error' } as const;
      const choices = issues.map(item => ({ issueId: item.id, resolution: codes[reviewFor(item.id).resolution as Resolution] }));
      const controller = new AbortController();
      coachingRequest = controller;
      reviewBusy.value = true;
      reviewError.value = '';
      const path = `/api/practice/analysis/${finished.id}/advice`;
      try {
        const submitted = await boundedFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ choices }), signal: controller.signal });
        if (!submitted.ok) throw new Error();
        coaching.value = await submitted.json() as PracticeAdvice;
        if (controller.signal.aborted) return;
        go(5);
        const deadline = Date.now() + 125000;
        while (!controller.signal.aborted && coaching.value?.status === 'pending' && Date.now() < deadline) {
          await new Promise(resolve => window.setTimeout(resolve, 2200));
          if (controller.signal.aborted) return;
          const response = await boundedFetch(path, { signal: controller.signal });
          if (!response.ok) throw new Error();
          coaching.value = await response.json() as PracticeAdvice;
        }
        if (coaching.value?.status === 'pending') reviewError.value = '改写建议尚未完成，可以先归档。';
      } catch {
        if (!controller.signal.aborted) reviewError.value = '暂时无法读取改写建议，请稍后重试。';
      } finally {
        if (coachingRequest === controller) {
          coachingRequest = null;
          reviewBusy.value = false;
        }
      }
    }

    async function archive() {
      const finished = analysis.value;
      if (archiving.value || !finished?.comparison) return;
      archiving.value = true;
      archiveError.value = '';
      try {
        const response = await boundedFetch(`/api/practice/analysis/${finished.id}/archive`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accepted: accepted.value }),
        });
        if (!response.ok) throw new Error('archive_failed');
        go(6);
      } catch {
        archiveError.value = '归档失败，请重试。';
      } finally {
        archiving.value = false;
      }
    }

    function start() {
      playback.value = 'new';
      hintsOpen.value = false;
      playError.value = '';
      analysis.value = null;
      analysisError.value = '';
      reviews.value = {};
      accepted.value = false;
      archiveError.value = '';
      coaching.value = null;
      reviewError.value = '';
      go(2);
    }

    onBeforeUnmount(() => {
      analysisRequest?.abort();
      coachingRequest?.abort();
      sample.value?.pause();
      clearRetellPreview();
    });

    function configuration() {
      return <section class="card solo-config" aria-labelledby="solo-topic">
        <h2 id="solo-topic">录音主题</h2>
        <div class="option-grid" role="group" aria-labelledby="solo-topic">
          {materials.map(item => <button type="button" key={item.id} class={{ chosen: item.id === selected.value }}
            aria-pressed={item.id === selected.value} onClick={() => { selected.value = item.id; }}>{item.topic}</button>)}
        </div>
        <h2 id="solo-duration">复述时长</h2>
        <div class="option-grid" role="group" aria-labelledby="solo-duration">
          {durations.map(([seconds, label]) => <button type="button" key={seconds} class={{ chosen: seconds === duration.value }}
            aria-pressed={seconds === duration.value} onClick={() => { duration.value = seconds; }}>{label}</button>)}
        </div>
        <button type="button" class="primary" onClick={start}>开始练习</button>
      </section>;
    }

    function recording() {
      const current = material.value;
      const playbackLabel = { new: '播放录音', playing: '暂停播放', paused: '继续播放', heard: '重新播放' }[playback.value];
      return <div class="round-content">
        <section class="card solo-listen">
          <h2>{current.title}</h2>
          <audio ref={sample} src={`/practice-audio/${current.id}.mp3`} preload="none" hidden
            onPlay={event => {
              if (capturing.value) (event.currentTarget as HTMLAudioElement).pause();
              else playback.value = 'playing';
            }}
            onPause={() => { if (playback.value === 'playing') playback.value = 'paused'; }}
            onEnded={() => { playback.value = 'heard'; }} />
          <button type="button" class="secondary" disabled={capturing.value || playPending.value}
            onClick={() => void togglePlayback()}>{playPending.value ? '正在加载录音…' : playbackLabel}</button>
          {playError.value && <p class="error-text" role="alert">{playError.value}</p>}
          <button type="button" class="text-button" aria-expanded={hintsOpen.value} aria-controls="solo-hints"
            onClick={() => { hintsOpen.value = !hintsOpen.value; }}>提示词</button>
          <ul id="solo-hints" class="solo-hints" hidden={!hintsOpen.value}>{current.keywords.map(keyword => <li key={keyword}>{keyword}</li>)}</ul>
        </section>
        <div class="card">
          <Recorder roundId={`solo-${current.id}`} kind="listener" version={1} maxSeconds={duration.value}
            onCaptureChange={captureChanged} onBegin={async () => { captureChanged(true); return 1; }}
            onCommitted={async () => {}} onSubmitRecording={submitRetell} />
        </div>
      </div>;
    }

    function comparison() {
      const completed = result.value;
      const current = analysis.value;
      return <section class="card comparison-view">
        {!completed && <div class="solo-transcript">
          <p>结果根据素材库的原录音和你本轮的复述录音生成。</p>
          {!analysisBusy.value && <button type="button" class="secondary" onClick={() => void analyze()}>重试分析</button>}
          <button type="button" class="text-button" disabled={analysisBusy.value} onClick={() => go(2)}>重新录音</button>
        </div>}
        {analysisBusy.value && <p role="status">正在分析本轮复述，请稍候…</p>}
        {analysisError.value && <p class="error-text" role="alert">{analysisError.value}</p>}
        {completed && current && <>
          <p class="notice">{current.provider === 'ark' ? '方舟对照了原录音要点与本轮复述转写。'
            : current.provider === 'ark_partial' ? '方舟与关键词规则共同对照了本轮复述。' : '本轮复述已转写，使用关键词规则完成对照。'}</p>
          {comparisonMetrics(completed)}
          <h2 class="solo-subheading">{completed.issues.length ? '有问题的要点 · 逐条对照' : '要点逐条对照'}</h2>
          {(completed.issues.length ? completed.issues : completed.rows).map((item, index) => <details class="solo-issue" key={item.id}>
            <summary>{index + 1}. {item.tag || '已对照'} · {item.original}</summary>
            {pairedText(item, retellLabel)}
            {item.question && <p>可澄清：{item.question}</p>}
          </details>)}
        </>}
        <details class="solo-transcript" onToggle={event => {
          if (!(event.currentTarget as HTMLDetailsElement).open) retellPreview.value?.pause();
        }}>
          <summary>回听本轮复述</summary>
          {retellPreviewUrl.value && <>
            <audio ref={retellPreview} src={retellPreviewUrl.value} preload="none" hidden
              onPlay={event => {
                const audio = event.currentTarget as HTMLAudioElement;
                if (audio.closest('details')?.open) retellPlaying.value = true;
                else audio.pause();
              }}
              onPause={() => { retellPlaying.value = false; }} onEnded={() => { retellPlaying.value = false; }} />
            <button type="button" class="secondary" onClick={() => void toggleRetellPreview()}>
              {retellPlaying.value ? '暂停复述录音' : '听自己的复述'}
            </button>
            {retellError.value && <p class="error-text" role="alert">{retellError.value}</p>}
          </>}
          {current?.transcript && <p>{current.transcript}</p>}
        </details>
        {completed && <button type="button" class="primary" onClick={() => go(4)}>确认</button>}
      </section>;
    }

    function review() {
      if (!result.value) return null;
      const { issues } = result.value;
      return <form class="card" onSubmit={submitReviews}>
        {!issues.length && <p>本轮没有需要确认的差异。</p>}
        {issues.map((item, index) => <article class="solo-issue" key={item.id}>
          <h2>{index + 1}. {item.tag || '待确认'}</h2>
          {pairedText(item, retellLabel)}
          {item.question && <p>{item.question}</p>}
          <label for={`solo-resolution-${index}`}>结论</label>
          <select id={`solo-resolution-${index}`} required value={reviewFor(item.id).resolution} onChange={event => {
            const resolution = (event.currentTarget as HTMLSelectElement).value as Review['resolution'];
            reviews.value[item.id] = { ...reviewFor(item.id), resolution };
          }}>
            <option value="">请选择</option>
            {resolutions.map(resolution => <option key={resolution} value={resolution}>{resolution}</option>)}
          </select>
          <label for={`solo-note-${index}`}>补充澄清（选填）</label>
          <textarea id={`solo-note-${index}`} rows={2} maxlength={500} value={reviewFor(item.id).note} onInput={event => {
            reviews.value[item.id] = { ...reviewFor(item.id), note: (event.currentTarget as HTMLTextAreaElement).value };
          }} />
        </article>)}
        {reviewError.value && <p role="alert">{reviewError.value}</p>}
        <button type="submit" class="primary" disabled={reviewBusy.value}>提交，查看改写建议</button>
      </form>;
    }

    function advice() {
      const suggestion = coaching.value?.suggestions.listener;
      return <section class="card comparison-view">
        <h2>给复述者的改写建议</h2>
        {suggestion ? <blockquote>{suggestion.text}</blockquote> : <p role="status">正在生成改写建议…</p>}
        {suggestion?.provider === 'rules' && <p>本条为规则建议。</p>}
        {reviewError.value && <p role="alert">{reviewError.value}</p>}
        <button type="button" class="secondary" disabled={archiving.value || accepted.value || !suggestion} aria-pressed={accepted.value} onClick={() => { accepted.value = true; }}>
          {accepted.value ? '已接纳' : '接纳这条建议'}
        </button>
        {archiveError.value && <p role="alert">{archiveError.value}</p>}
        <button type="button" class="primary" disabled={archiving.value} onClick={() => void archive()}>{archiving.value ? '正在归档…' : accepted.value ? '归档本轮' : '跳过建议，归档本轮'}</button>
      </section>;
    }

    function report() {
      const comparison = result.value;
      if (!comparison) return null;
      const recording = retellRecording;
      return <section class="card">
        <h2>{material.value.title}</h2>
        <p role="status">本轮练习摘要已归档。</p>
        <p>{retellLabel}对照 · 复述限时 {duration.value} 秒</p>
        <div class="report-media">
          <AudioPlayer src={`/practice-audio/${material.value.id}.mp3`} audioRef={reportSpeaker} label="表达者录音" />
          {retellPreviewUrl.value && h(AudioPlayer, { src: retellPreviewUrl.value, audioRef: reportListener, label: '复述者录音' },
            javaBackend && recording ? {
              action: () => <MaterialConsentButton label="复述者录音" endpoint={`/api/practice/reports/${analysis.value?.id}/material-consent`} recording={recording} />,
            } : {})}
        </div>
        {comparisonMetrics(comparison)}
        {comparison.issues.map((item, index) => <details class="solo-issue" key={item.id}>
          <summary>{index + 1}. {item.tag || '差异'} · {reviewFor(item.id).resolution}</summary>
          {pairedText(item, retellLabel)}
          {reviewFor(item.id).note.trim() && <p>澄清：{reviewFor(item.id).note.trim()}</p>}
        </details>)}
        <p><strong>{accepted.value ? '已接纳改写建议' : '本轮跳过改写建议'}</strong></p>
        {accepted.value && <p>{coaching.value?.suggestions.listener?.text}</p>}
        <button type="button" class="primary" onClick={() => go(1)}>再练一轮</button>
      </section>;
    }

    return () => <section class="solo-practice">
      <button type="button" class="text-button" onClick={() => props.onExit()}>← 返回首页</button>
      <div class="stepper">
        <span>第 {step.value} / {steps.length} 步</span>
        <div aria-hidden="true">{steps.map((title, index) => <i key={title} class={{ filled: index < step.value }} />)}</div>
      </div>
      <h1 class="flow-title" tabindex={-1} ref={heading}>{steps[step.value - 1]}</h1>
      {step.value === 1 && configuration()}
      {step.value === 2 && recording()}
      {step.value === 3 && comparison()}
      {step.value === 4 && review()}
      {step.value === 5 && advice()}
      {step.value === 6 && report()}
      <button type="button" class="danger" onClick={props.onExit}>结束并关闭训练室</button>
    </section>;
  },
});
