import { defineComponent, h, reactive, ref, watch, type Ref } from 'vue';
import { boundedFetch as fetch } from './client.ts';
import { AudioPlayer } from './AudioPlayer.tsx';
import { MaterialConsentButton } from './MaterialConsentButton.tsx';
import { nextPractice } from './flow.ts';

type Resolution = 'misunderstanding' | 'expression' | 'ai_error';
type Observation = { tag: string; note: string | null };
type Item = { id: string; category: string; original: string; speakerQuote: string | null; listenerQuote: string; complete: boolean; accurate: boolean; tag: string | null; clarification: string | null; resolution: Resolution | null; speakerConfirmed: boolean; listenerConfirmed: boolean; listenerNote: string | null; listenerNotes?: string[]; observerTag: string | null; observerNote: string | null; observations?: Observation[] };
type Result = { total: number; complete: number; accurate: number; excluded?: number; issues: Item[]; adviceAccepted: boolean; listenerAdviceAccepted?: boolean; provider?: 'mock' | 'rules' | 'ark' | 'ark_partial' | 'rules_fallback'; transcripts?: { speaker: string; listener: string }; report?: { topic: string; focus: string; speaker: string; listener: string; speakerAudioId: string | null; listenerAudioId: string | null; hintLevel: number } };
const sentences = (text: string) => text.match(/[^。！？!?\n]+[。！？!?]?/g)?.map(value => value.trim()).filter(Boolean) ?? [];
const tags = ['遗漏重要信息', '理解不到位', '理解偏了', '杜撰信息', '强加信息', '我表达不清', '我言不达意', '语气被误解', '重点被误解', 'AI 误判'];
const resolutions: [Resolution, string][] = [['misunderstanding', '真误解'], ['expression', '表达问题'], ['ai_error', 'AI 误判']];
const javaBackend = import.meta.env.VITE_ECHO_TARGET === 'java';

type ComparisonProps = { roundId: string; stage: string; version: number; role: 'speaker' | 'listener' | 'observer'; solo: boolean; compactReview?: boolean; atomicReview?: boolean; labeling?: boolean; onLabeling?: () => void; onChanged: () => Promise<void> };
type ReviewRound = { version: number; stage: string; activeSeat: 'speaker' | 'listener'; issues: { id: string }[] };

export const ComparisonView = defineComponent((props: ComparisonProps) => {
  const loadedComparison = ref<{ roundId: string; version: number; result: Result } | null>(null);
  const requestError = ref('');
  const saving = ref(false);
  const reload = ref(0);
  const notes = reactive<Record<string, string>>({});
  const observations = reactive<Record<string, { tag: string; note: string }>>({});
  const isAnonymous = ref(false);
  const speakerAudio = ref<HTMLAudioElement | null>(null);
  const listenerAudio = ref<HTMLAudioElement | null>(null);
  const draftChoices = ref<Record<string, { tag: string; resolution: Resolution }>>({});

  function reportAudio(audioId: string, seat: 'speaker' | 'listener', audioRef: Ref<HTMLAudioElement | null>) {
    const { roundId, role, solo } = props;
    const label = seat === 'speaker' ? '表达者录音' : '复述者录音';
    const canConsent = javaBackend && role !== 'observer' && (solo || role === seat);
    return h(AudioPlayer, { key: audioId, roundId, audioId, audioRef, label }, canConsent ? {
      action: () => <MaterialConsentButton label={label} endpoint={`/api/rounds/${roundId}/audio/${audioId}/material-consent`} />,
    } : {});
  }

  watch([() => props.roundId, () => props.version, reload], ([roundId, version], _, onCleanup) => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    void fetch(`/api/rounds/${roundId}/comparison`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('对照结果暂时无法读取');
      return response.json() as Promise<Result>;
    }).then(result => {
      if (controller.signal.aborted) return;
      loadedComparison.value = { roundId, version, result };
      draftChoices.value = Object.fromEntries(result.issues.map(item => [item.id, { tag: item.tag ?? '遗漏重要信息', resolution: item.resolution ?? 'misunderstanding' }]));
    }).catch(cause => {
      if (!controller.signal.aborted) requestError.value = cause instanceof Error ? cause.message : '读取失败';
    });
  }, { immediate: true });

  async function send(path: string, body: object, onSaved?: () => void) {
    const { roundId, version, onChanged } = props;
    const loaded = loadedComparison.value;
    if (saving.value || loaded?.roundId !== roundId || loaded.version !== version) return;
    saving.value = true;
    requestError.value = '';
    try {
      const response = await fetch(`/api/rounds/${roundId}/review/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: version, ...body }) });
      if (!response.ok) throw new Error(response.status === 409 ? '对方刚更新了本轮内容，请核对最新状态后重试。' : '操作失败，请稍后重试。');
      onSaved?.();
      await onChanged();
    } catch (cause) {
      requestError.value = cause instanceof Error ? cause.message : '操作失败';
      await onChanged().catch(() => undefined);
    } finally {
      saving.value = false;
    }
  }

  async function completeSoloReview(labels?: { issueId: string; tag: string; resolution: Resolution }[]) {
    const { roundId, version, role, onChanged } = props;
    const loaded = loadedComparison.value;
    if (saving.value || loaded?.roundId !== roundId || loaded.version !== version) return;
    saving.value = true;
    requestError.value = '';
    let expectedVersion = version;
    let activeSeat: 'speaker' | 'listener' = role === 'listener' ? 'listener' : 'speaker';
    const post = async (path: string, body: object = {}) => {
      const response = await fetch(`/api/rounds/${roundId}/review/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion, ...body }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? '本轮状态刚刚更新，请再次确认。' : '操作失败，请稍后重试。');
      const next = await response.json() as ReviewRound;
      expectedVersion = next.version;
      activeSeat = next.activeSeat;
      return next;
    };
    try {
      let issueIds = loaded.result.issues.filter(item => !item.complete || !item.accurate).map(item => item.id);
      if (props.stage === 'SPEAKER_LABELING') {
        const next = await post('label', { labels });
        issueIds = next.issues.map(item => item.id);
      }
      if (activeSeat !== 'speaker') await post('switch-seat', { seat: 'speaker' });
      for (const issueId of issueIds) await post('confirm', { issueId });
      await post('switch-seat', { seat: 'listener' });
      for (const issueId of issueIds) await post('confirm', { issueId });
      await post('switch-seat', { seat: 'speaker' });
      await post('submit');
    } catch (cause) {
      requestError.value = cause instanceof Error ? cause.message : '操作失败';
    } finally {
      await onChanged().catch(() => undefined);
      saving.value = false;
    }
  }

  return () => {
    const { roundId, version, stage, role, solo, compactReview = false, atomicReview = false, labeling = false, onLabeling } = props;
    const loaded = loadedComparison.value;
    const error = requestError.value;
    const busy = saving.value;
    const anonymous = isAnonymous.value;
    const choices = draftChoices.value;
    if (loaded?.roundId !== roundId || loaded.version !== version) return <div>{error ? <><p role="alert" class="error-text">{error}</p><button onClick={() => { requestError.value = ''; reload.value += 1; }}>重新读取</button></> : <p>正在读取对照结果…</p>}</div>;
    const { result } = loaded;
    const problems = result.issues.filter(item => !item.complete || !item.accurate);
    const paired = result.transcripts && [sentences(result.transcripts.speaker), sentences(result.transcripts.listener)];
    const allowsDisagreement = result.excluded !== undefined;
    const allConfirmed = problems.every(item => item.speakerConfirmed && (allowsDisagreement || item.listenerConfirmed));
    const isReport = stage === 'ARCHIVED';
    const countedProblems = isReport && allowsDisagreement ? problems.filter(item => item.listenerConfirmed) : problems;
    const isComparison = stage === 'SPEAKER_LABELING' && !labeling;
    const editable = labeling && stage === 'SPEAKER_LABELING' || stage === 'MUTUAL_CONFIRM';
    const report = result.report;
    const practice = result.total > 0 ? nextPractice(result.complete, result.total) : '本轮暂无可计入结果的要点。';
    const seats = report ? (anonymous ? ['座位 A', '座位 B'] : [report.speaker, report.listener]) : null;
    const speakerIssue = problems.find(item => item.resolution === 'expression') ?? problems[0];
    const listenerIssue = problems.find(item => item.resolution === 'misunderstanding') ?? problems[0];
    const ownAdviceAccepted = role === 'speaker' ? result.adviceAccepted : result.listenerAdviceAccepted === true;
    if (stage === 'ADVICE') return <section class="comparison-view">
      {error && <p role="alert" class="error-text">{error}</p>}
      {role !== 'listener' && <><h2>{compactReview ? '本轮建议' : '给表达者的建议'}</h2><blockquote>{speakerIssue
        ? `先交代背景或条件，再把这一点单独说清楚：“${speakerIssue.original}”。`
        : '保持每句话只讲一个主要意思，重要条件单独说明。'}</blockquote></>}
      {role !== 'speaker' && <><h2>给复述者的建议</h2><blockquote>{listenerIssue
        ? `先复述你确定的内容，再向对方核对：“${listenerIssue.original}”，我听得对吗？`
        : '用自己的话复述，复述后确认是否遗漏时间、条件或因果。'}</blockquote></>}
      {role !== 'speaker' && <p role="status">等待表达者归档本轮。</p>}
      {role !== 'observer' && <button class="secondary" disabled={busy || ownAdviceAccepted} onClick={() => void send('adopt', {})}>{ownAdviceAccepted ? '已采纳' : '采纳这条建议'}</button>}
    </section>;
    return <section class="comparison-view"><p>{isReport ? '本轮报告已归档。' : compactReview && stage === 'MUTUAL_CONFIRM' ? '请确认本轮标注。' : '双方逐条确认最终结论。'}</p>
      {result.provider === 'mock' && <p class="notice">演示对照使用预置转写和文字匹配。</p>}
      {result.provider === 'rules' && <p class="notice">对照结果基于转写和字面匹配。</p>}
      {result.provider === 'rules_fallback' && <p class="notice">语义对照暂不可用，以下是字面匹配结果，请双方核对。</p>}
      {result.provider === 'ark_partial' && <p class="notice">部分要点使用字面匹配，请双方核对。</p>}
      {(!result.provider || result.provider === 'ark') && !isReport && <p>AI 提供辅助提示。</p>}
      {error && <p role="alert" class="error-text">{error}</p>}
      {report && seats && <>
        <label class="toggle-row"><input type="checkbox" checked={anonymous} onChange={event => { isAnonymous.value = (event.currentTarget as HTMLInputElement).checked; }} /> 匿名显示座位代号</label>
        <p>{seats[0]} / {seats[1]} · 提示级别 {report.hintLevel}</p>
        {!anonymous && report.focus && <p>预标重点 · {report.focus}</p>}
        {ownAdviceAccepted && <p>你已采纳本轮练习建议。</p>}
        <p>{practice}</p>
        {!anonymous && <div class="report-media">
          {report.speakerAudioId && reportAudio(report.speakerAudioId, 'speaker', speakerAudio)}
          {report.listenerAudioId && reportAudio(report.listenerAudioId, 'listener', listenerAudio)}
        </div>}
        {!anonymous && result.transcripts && <details><summary>查看双方完整转写</summary>
          <h3>表达录音转写</h3><p>{result.transcripts.speaker}</p>
          <h3>复述录音转写</h3><p>{result.transcripts.listener}</p>
        </details>}
      </>}
      {(isComparison || isReport) && <div class="comparison-grid">
        <div><span>完整度</span><strong>{result.complete} / {result.total}</strong></div>
        <div><span>准确度</span><strong>{result.accurate} / {result.total}</strong></div>
        <div><span>偏差类型</span><strong>{new Set(countedProblems.map(item => item.tag).filter(Boolean)).size} 类</strong><p>{[...new Set(countedProblems.flatMap(item => item.tag ? [item.tag] : []))].join('、') || '暂无标签'}</p></div>
        <div><span>可澄清点</span><strong>{countedProblems.filter(item => item.clarification).length} 处</strong></div>
      </div>}
      {isReport && Boolean(result.excluded) && <p class="notice">{result.excluded} 条未达成一致，不计入本轮结果。</p>}
      <h3>{problems.length ? '有问题的要点 · 逐条对照' : paired ? '全文逐句对照' : '全部信息点对照'}</h3>
      {!anonymous && !problems.length && paired && <ol>{Array.from({ length: Math.max(paired[0]!.length, paired[1]!.length) }, (_, index) => <li key={index}>
        <p>表达者：{paired[0]![index] ?? '—'}</p><p>复述者：{paired[1]![index] ?? '—'}</p>
      </li>)}</ol>}
      {!anonymous && (problems.length ? problems : paired ? [] : result.issues).map((item, index) => <article class="comparison-item" key={item.id}>
        <h4>{index + 1}. {item.category}：{item.original}</h4>
        <p>建议标签：{item.tag ?? '待确认'}</p>
        <p>表达者确认的要点：{item.original}</p>
        <p>表达转写原句：{item.speakerQuote || '未找到对应原句'}</p>
        <p>复述转写原句：{item.listenerQuote || '未找到对应句子'}</p>
        {item.clarification && <p>可澄清：{item.clarification}</p>}
        {(item.listenerNotes ?? (item.listenerNote ? [item.listenerNote] : [])).map((note, index) => <p key={index}>复述者澄清：{note}</p>)}
        {(item.observations ?? (item.observerTag ? [{ tag: item.observerTag, note: item.observerNote }] : [])).map(({ tag, note }, index) =>
          <p key={index}>观察者建议 · {tag}{note ? ` · ${note}` : ''}</p>)}
        {role === 'observer' && stage === 'MUTUAL_CONFIRM' && <div class="review-confirm">
          <label>建议标签<select value={observations[item.id]?.tag ?? item.observerTag ?? tags[0]!} onChange={event => {
            observations[item.id] = { tag: (event.currentTarget as HTMLSelectElement).value, note: observations[item.id]?.note ?? item.observerNote ?? '' };
          }}>
            {tags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
          </select></label>
          <textarea aria-label={`第 ${index + 1} 条观察建议`} maxlength={500} value={observations[item.id]?.note ?? ''}
            onInput={event => {
              observations[item.id] = { tag: observations[item.id]?.tag ?? item.observerTag ?? tags[0]!, note: (event.currentTarget as HTMLTextAreaElement).value };
            }} />
          <button class="secondary" disabled={busy || !observations[item.id]?.note.trim()} onClick={() => {
            const draft = observations[item.id];
            if (draft) void send('observe', { issueId: item.id, ...draft },
              () => { observations[item.id] = { ...draft, note: '' }; });
          }}>提交观察建议</button>
        </div>}
        {isReport && item.resolution && <p>{allowsDisagreement && !item.listenerConfirmed ? '未达成一致 · 表达者判断：' : '已确认结论：'}{resolutions.find(([value]) => value === item.resolution)?.[1]}</p>}
        {stage === 'MUTUAL_CONFIRM' && !compactReview && item.resolution && <p>待双方确认的结论：{resolutions.find(([value]) => value === item.resolution)?.[1]}</p>}
        {(!item.complete || !item.accurate) && editable && <>
          {role === 'speaker' && <div class="review-fields"><label>标签<select aria-label={`${item.category}标签`} value={choices[item.id]?.tag ?? item.tag ?? tags[0]!} onChange={event => {
            choices[item.id] = { tag: (event.currentTarget as HTMLSelectElement).value, resolution: choices[item.id]?.resolution ?? 'misunderstanding' };
          }}>{tags.map(tag => <option key={tag} value={tag}>{tag}</option>)}</select></label>
            <label>结论<select aria-label={`${item.category}结论`} value={choices[item.id]?.resolution ?? item.resolution ?? 'misunderstanding'} onChange={event => {
              choices[item.id] = { tag: choices[item.id]?.tag ?? item.tag ?? tags[0]!, resolution: (event.currentTarget as HTMLSelectElement).value as Resolution };
            }}>{resolutions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>}
          {stage === 'MUTUAL_CONFIRM' && !compactReview && <div class="review-confirm"><span>表达者：{item.speakerConfirmed ? '已确认' : '待确认'} · 复述者：{item.listenerConfirmed ? '已确认' : '待确认'}</span>
            {role === 'listener' && <><textarea aria-label={`第 ${index + 1} 条澄清`} maxlength={500}
              value={notes[item.id] ?? ''} onInput={event => { notes[item.id] = (event.currentTarget as HTMLTextAreaElement).value; }} />
              <button class="secondary" disabled={busy || !notes[item.id]?.trim() || notes[item.id]?.trim() === item.listenerNote}
                onClick={() => void send('clarify', { issueId: item.id, note: notes[item.id] },
                  () => { notes[item.id] = ''; })}>提交澄清</button></>}
            {role !== 'observer' && <button class="secondary" disabled={busy || (role === 'speaker' ? item.speakerConfirmed : item.listenerConfirmed)} onClick={() => void send('confirm', { issueId: item.id })}>确认这一条</button>}
            {role === 'speaker' && <button class="text-button" disabled={busy} onClick={() => void send('revise', { issueId: item.id, ...choices[item.id] })}>修改标签或结论</button>}
          </div>}
        </>}
      </article>)}
      {isComparison && role === 'speaker' && <button class="primary" onClick={() => onLabeling?.()}>{compactReview ? '请逐条标注' : '请表达者逐条标注'}</button>}
      {isComparison && role === 'listener' && <p role="status">等待表达者提交标注。</p>}
      {labeling && stage === 'SPEAKER_LABELING' && role === 'speaker' && <button class="primary" disabled={busy} onClick={() => void (compactReview && !atomicReview
        ? completeSoloReview(problems.map(item => ({
          issueId: item.id,
          tag: choices[item.id]?.tag ?? item.tag ?? tags[0]!,
          resolution: choices[item.id]?.resolution ?? item.resolution ?? 'misunderstanding',
        })))
        : send('label', { labels: problems.map(item => ({ issueId: item.id, ...choices[item.id] })) }))}>{compactReview ? '确认' : '提交标注，邀请双方确认'}</button>}
      {stage === 'MUTUAL_CONFIRM' && compactReview && <button class="primary" disabled={busy} onClick={() => void completeSoloReview()}>确认</button>}
      {stage === 'MUTUAL_CONFIRM' && solo && !compactReview && <button class="secondary" disabled={busy} onClick={() => void send('switch-seat', { seat: role === 'speaker' ? 'listener' : 'speaker' })}>切换到{role === 'speaker' ? '复述者' : '表达者'}座位</button>}
      {stage === 'MUTUAL_CONFIRM' && !compactReview && role === 'speaker' && <button class="primary" disabled={busy || !allConfirmed} onClick={() => void send('submit', {})}>表达者提交，查看改写建议</button>}
      {isReport && <a class="report-download" download="回声训练室-轮次报告.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(
        ['回声训练室 · 本轮报告', ...(seats ?? []), `完整度 ${result.complete}/${result.total}`, `准确度 ${result.accurate}/${result.total}`,
          ...(result.excluded ? [`${result.excluded} 条未达成一致，不计入本轮结果。`] : []),
          ...countedProblems.map(item => anonymous ? item.tag ?? '差异' : `${item.tag ?? '差异'}：${item.original}；复述：${item.listenerQuote || '未找到对应句子'}`)].join('\n'))}`}>导出本轮报告（TXT）</a>}
      {stage === 'MUTUAL_CONFIRM' && !compactReview && <p class="notice">{allowsDisagreement ? '表达者逐条确认后可以提交。复述者未确认的条目不计入本轮结果。' : solo ? '请切换座位分别确认。' : '每条都要由表达者和复述者各自确认。'}修改标签或结论会清除该条旧确认。</p>}
    </section>;
  };
}, { name: 'ComparisonView', props: ['roundId', 'stage', 'version', 'role', 'solo', 'compactReview', 'atomicReview', 'labeling', 'onLabeling', 'onChanged'] });
