import { computed, defineComponent, h, nextTick, onBeforeUnmount, ref, type PropType } from 'vue';
import { boundedFetch, newRequestId } from './client.ts';
import { Recorder } from './Recorder.tsx';
import { AudioPlayer } from './AudioPlayer.tsx';
import { MaterialConsentButton } from './MaterialConsentButton.tsx';
import { comparePractice } from './practice-comparison.ts';
import materials from './practice-materials.json' with { type: 'json' };
import './solo-practice.css';

const durations = [[30, '30 秒'], [60, '1 分钟'], [120, '2 分钟'], [300, '5 分钟']] as const;
const steps = ['单人练习', '先听，再用自己的话说', '先看差异', '把误解逐条聊清楚', '收下一条建议', '本轮报告'] as const;
const resolutions = ['真误解', '表达问题', 'AI 误判'] as const;
const javaBackend = import.meta.env.VITE_ECHO_TARGET === 'java';

type Comparison = ReturnType<typeof comparePractice>;
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
    ownerId: String,
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
    const input = ref('');
    const comparedInput = ref('');
    const retellPreviewUrl = ref('');
    let retellRecording: Blob | null = null;
    const retellPreview = ref<HTMLAudioElement | null>(null);
    const reportSpeaker = ref<HTMLAudioElement | null>(null);
    const reportListener = ref<HTMLAudioElement | null>(null);
    const retellPlaying = ref(false);
    const retellError = ref('');
    const result = computed(() => comparePractice(material.value, comparedInput.value || undefined));
    const reviews = ref<Record<string, Review>>({});
    const accepted = ref(false);
    const stored = ref(false);
    const archiving = ref(false);
    const archiveError = ref('');
    let archiveId = '';
    const retellLabel = computed(() => comparedInput.value ? '你输入的复述' : '示例复述');

    function go(next: number) {
      if (step.value === 3) retellPreview.value?.pause();
      if (next === 1) clearRetellPreview();
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
      retellRecording = audio;
      retellPreviewUrl.value = URL.createObjectURL(audio);
      go(3);
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

    function submitReviews(event: SubmitEvent) {
      event.preventDefault();
      if (result.value.issues.every(item => reviewFor(item.id).resolution)) go(5);
    }

    async function archive() {
      if (archiving.value) return;
      archiveId ||= newRequestId();
      const report = {
        date: new Date().toISOString(),
        title: material.value.title,
        topic: material.value.topic,
        duration: duration.value,
        comparison: result.value,
        transcriptSource: comparedInput.value ? 'manual' : 'demo',
        reviews: reviews.value,
        advice: material.value.advice,
        accepted: accepted.value,
      };
      if (javaBackend) {
        archiving.value = true;
        archiveError.value = '';
        try {
          const response = await boundedFetch('/api/practice/reports', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: archiveId, materialId: material.value.id, duration: report.duration, transcriptSource: report.transcriptSource,
              complete: report.comparison.complete, accurate: report.comparison.accurate, total: report.comparison.total, accepted: report.accepted,
            }),
          });
          if (!response.ok) throw new Error('archive_failed');
        } catch {
          archiveError.value = '归档失败，请重试。';
          return;
        } finally {
          archiving.value = false;
        }
      }
      try {
        localStorage.setItem(`echo:solo-report:${props.ownerId ?? 'local'}:${archiveId}`, JSON.stringify(report));
        stored.value = true;
      } catch {
        stored.value = false;
      }
      go(6);
    }

    function start() {
      playback.value = 'new';
      hintsOpen.value = false;
      playError.value = '';
      input.value = '';
      comparedInput.value = '';
      reviews.value = {};
      accepted.value = false;
      stored.value = false;
      archiveId = '';
      archiveError.value = '';
      go(2);
    }

    onBeforeUnmount(() => {
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
            onCommitted={async () => {}} onLocalSubmit={submitRetell} />
        </div>
      </div>;
    }

    function comparison() {
      const { issues, rows } = result.value;
      return <section class="card comparison-view">
        <p class="notice">{comparedInput.value ? '当前结果使用你输入的复述，按关键词对照。' : '当前结果使用预置的示例复述。你也可以输入自己的复述文本进行对照。'}</p>
        {comparisonMetrics(result.value)}
        <h2 class="solo-subheading">{issues.length ? '有问题的要点 · 逐条对照' : '要点逐条对照'}</h2>
        {(issues.length ? issues : rows).map((item, index) => <details class="solo-issue" key={item.id}>
          <summary>{index + 1}. {item.tag || '已对照'} · {item.original}</summary>
          {pairedText(item, retellLabel.value)}
          {item.question && <p>可澄清：{item.question}</p>}
        </details>)}
        <details class="solo-transcript" onToggle={event => {
          if (!(event.currentTarget as HTMLDetailsElement).open) retellPreview.value?.pause();
        }}>
          <summary>用自己的复述文本重新对照</summary>
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
          <form onSubmit={event => { event.preventDefault(); comparedInput.value = input.value.trim(); }}>
            <label for="solo-transcript">复述文本</label>
            <textarea id="solo-transcript" rows={4} maxlength={2500} value={input.value}
              onInput={event => { input.value = (event.currentTarget as HTMLTextAreaElement).value; }} />
            <button type="submit" class="secondary" disabled={comparedInput.value === input.value.trim()}>更新对照</button>
          </form>
        </details>
        <button type="button" class="primary" onClick={() => go(4)}>确认</button>
      </section>;
    }

    function review() {
      const { issues } = result.value;
      return <form class="card" onSubmit={submitReviews}>
        {!issues.length && <p>本轮没有需要确认的差异。</p>}
        {issues.map((item, index) => <article class="solo-issue" key={item.id}>
          <h2>{index + 1}. {item.tag || '待确认'}</h2>
          {pairedText(item, retellLabel.value)}
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
        <button type="submit" class="primary">提交，查看改写建议</button>
      </form>;
    }

    function advice() {
      return <section class="card comparison-view">
        <h2>给复述者的改写建议</h2>
        <blockquote>{material.value.advice}</blockquote>
        <button type="button" class="secondary" disabled={archiving.value || accepted.value} aria-pressed={accepted.value} onClick={() => { accepted.value = true; }}>
          {accepted.value ? '已接纳' : '接纳这条建议'}
        </button>
        {archiveError.value && <p role="alert">{archiveError.value}</p>}
        <button type="button" class="primary" disabled={archiving.value} onClick={() => void archive()}>{archiving.value ? '正在归档…' : accepted.value ? '归档本轮' : '跳过建议，归档本轮'}</button>
      </section>;
    }

    function report() {
      const recording = retellRecording;
      return <section class="card">
        <h2>{material.value.title}</h2>
        <p role="status">{javaBackend ? '本轮练习摘要已归档。' : stored.value ? '本轮已归档到此浏览器。' : '本轮报告已生成。浏览器存储不可用。'}</p>
        <p>{retellLabel.value}对照 · 复述限时 {duration.value} 秒</p>
        <div class="report-media">
          <AudioPlayer src={`/practice-audio/${material.value.id}.mp3`} audioRef={reportSpeaker} label="表达者录音" />
          {retellPreviewUrl.value && h(AudioPlayer, { src: retellPreviewUrl.value, audioRef: reportListener, label: '复述者录音' },
            javaBackend && recording ? {
              action: () => <MaterialConsentButton label="复述者录音" endpoint={`/api/practice/reports/${archiveId}/material-consent`} recording={recording} />,
            } : {})}
        </div>
        {comparisonMetrics(result.value)}
        {result.value.issues.map((item, index) => <details class="solo-issue" key={item.id}>
          <summary>{index + 1}. {item.tag || '差异'} · {reviewFor(item.id).resolution}</summary>
          {pairedText(item, retellLabel.value)}
          {reviewFor(item.id).note.trim() && <p>澄清：{reviewFor(item.id).note.trim()}</p>}
        </details>)}
        <p><strong>{accepted.value ? '已接纳改写建议' : '本轮跳过改写建议'}</strong></p>
        {accepted.value && <p>{material.value.advice}</p>}
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
