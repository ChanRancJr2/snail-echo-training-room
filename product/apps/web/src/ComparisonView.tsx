import { useEffect, useRef, useState } from 'react';
import { boundedFetch as fetch } from './client.ts';
import { AudioPlayer } from './AudioPlayer.tsx';
import { nextPractice } from './flow.ts';

type Resolution = 'misunderstanding' | 'expression' | 'ai_error';
type Item = { id: string; category: string; original: string; speakerQuote: string | null; listenerQuote: string; complete: boolean; accurate: boolean; tag: string | null; clarification: string | null; resolution: Resolution | null; speakerConfirmed: boolean; listenerConfirmed: boolean; listenerNote: string | null; observerTag: string | null; observerNote: string | null };
type Result = { total: number; complete: number; accurate: number; issues: Item[]; adviceAccepted: boolean; provider?: 'mock' | 'rules'; transcripts?: { speaker: string; listener: string }; report?: { topic: string; focus: string; speaker: string; listener: string; speakerAudioId: string | null; listenerAudioId: string | null; hintLevel: number } };
const sentences = (text: string) => text.match(/[^。！？!?\n]+[。！？!?]?/g)?.map(value => value.trim()).filter(Boolean) ?? [];
const tags = ['遗漏重要信息', '理解不到位', '理解偏了', '杜撰信息', '强加信息', '我表达不清', '我言不达意', '语气被误解', '重点被误解', 'AI 误判'];
const resolutions: [Resolution, string][] = [['misunderstanding', '真误解'], ['expression', '表达问题'], ['ai_error', 'AI 误判']];

export function ComparisonView({ roundId, stage, version, role, solo, labeling = false, onLabeling, onChanged }: { roundId: string; stage: string; version: number; role: 'speaker' | 'listener' | 'observer'; solo: boolean; labeling?: boolean; onLabeling?: () => void; onChanged: () => Promise<void> }) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [observations, setObservations] = useState<Record<string, { tag: string; note: string }>>({});
  const [anonymous, setAnonymous] = useState(false);
  const speakerAudio = useRef<HTMLAudioElement | null>(null);
  const listenerAudio = useRef<HTMLAudioElement | null>(null);
  const [choices, setChoices] = useState<Record<string, { tag: string; resolution: Resolution }>>({});
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/rounds/${roundId}/comparison`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('对照结果暂时无法读取');
      return response.json() as Promise<Result>;
    }).then(value => {
      if (controller.signal.aborted) return;
      setResult(value);
      setLoadedVersion(version);
      setChoices(Object.fromEntries(value.issues.map(item => [item.id, { tag: item.tag ?? '遗漏重要信息', resolution: item.resolution ?? 'misunderstanding' }])));
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取失败'); });
    return () => controller.abort();
  }, [roundId, version, reload]);
  async function send(path: string, body: object) {
    if (busy || loadedVersion !== version) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/rounds/${roundId}/review/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: version, ...body }) });
      if (!response.ok) throw new Error(response.status === 409 ? '对方刚更新了本轮内容，请核对最新状态后重试。' : '操作失败，请稍后重试。');
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
      await onChanged().catch(() => undefined);
    }
    finally { setBusy(false); }
  }
  if (!result || loadedVersion !== version) return <div>{error ? <><p role="alert" className="error-text">{error}</p><button onClick={() => { setError(''); setReload(value => value + 1); }}>重新读取</button></> : <p>正在读取对照结果…</p>}</div>;
  const problems = result.issues.filter(item => !item.complete || !item.accurate);
  const paired = result.transcripts && [sentences(result.transcripts.speaker), sentences(result.transcripts.listener)];
  const allConfirmed = problems.every(item => item.speakerConfirmed && item.listenerConfirmed);
  const isReport = stage === 'ARCHIVED';
  const isComparison = stage === 'SPEAKER_LABELING' && !labeling;
  const editable = labeling && stage === 'SPEAKER_LABELING' || stage === 'MUTUAL_CONFIRM';
  const report = result.report;
  const practice = nextPractice(result.complete, result.total);
  const seats = report ? (anonymous ? ['座位 A', '座位 B'] : [report.speaker, report.listener]) : null;
  if (stage === 'ADVICE') return <section className="comparison-view"><h2>下一次可以这样确认</h2>
    {error && <p role="alert" className="error-text">{error}</p>}
    {problems.length > 0 && <blockquote>“{problems[0]!.original}”，我理解得对吗？</blockquote>}
    <p>{practice}</p>
    {role !== 'speaker' && <p role="status">等待表达者归档本轮。</p>}
    {role === 'speaker' && <button className="secondary" disabled={busy || result.adviceAccepted} onClick={() => void send('adopt', {})}>{result.adviceAccepted ? '已采纳' : '采纳这条建议'}</button>}
  </section>;
  return <section className="comparison-view"><p>{isReport ? '本轮报告已归档。' : '双方逐条确认最终结论。'}</p>
    {result.provider === 'mock' && <p className="notice">演示对照使用预置转写和文字匹配。</p>}
    {result.provider === 'rules' && <p className="notice">对照结果基于转写和字面匹配。</p>}
    {!result.provider && !isReport && <p>AI 提供辅助提示。</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
    {report && seats && <>
      <label className="toggle-row"><input type="checkbox" checked={anonymous} onChange={event => setAnonymous(event.target.checked)} /> 匿名显示座位代号</label>
      <p>{seats[0]} / {seats[1]} · 提示级别 {report.hintLevel}</p>
      {!anonymous && report.focus && <p>预标重点 · {report.focus}</p>}
      {result.adviceAccepted && <p>本轮已采纳下一轮练习建议。</p>}
      <p>{practice}</p>
      {!anonymous && <div className="report-media">
        {report.speakerAudioId && <AudioPlayer roundId={roundId} audioId={report.speakerAudioId} audioRef={speakerAudio} />}
        {report.listenerAudioId && <AudioPlayer roundId={roundId} audioId={report.listenerAudioId} audioRef={listenerAudio} label="复述者录音" />}
      </div>}
      {!anonymous && result.transcripts && <details><summary>查看双方完整转写</summary>
        <h3>表达录音转写</h3><p>{result.transcripts.speaker}</p>
        <h3>复述录音转写</h3><p>{result.transcripts.listener}</p>
      </details>}
    </>}
    {(isComparison || isReport) && <div className="comparison-grid">
      <div><span>完整度</span><strong>{result.complete} / {result.total}</strong></div>
      <div><span>准确度</span><strong>{result.accurate} / {result.total}</strong></div>
      <div><span>偏差类型</span><strong>{new Set(problems.map(item => item.tag).filter(Boolean)).size} 类</strong><p>{[...new Set(problems.flatMap(item => item.tag ? [item.tag] : []))].join('、') || '暂无标签'}</p></div>
      <div><span>可澄清点</span><strong>{problems.filter(item => item.clarification).length} 处</strong></div>
    </div>}
    <h3>{problems.length ? '有问题的要点 · 逐条对照' : paired ? '全文逐句对照' : '全部信息点对照'}</h3>
    {!anonymous && !problems.length && paired && <ol>{Array.from({ length: Math.max(paired[0]!.length, paired[1]!.length) }, (_, index) => <li key={index}>
      <p>表达者：{paired[0]![index] ?? '—'}</p><p>复述者：{paired[1]![index] ?? '—'}</p>
    </li>)}</ol>}
    {!anonymous && (problems.length ? problems : paired ? [] : result.issues).map((item, index) => <article className="comparison-item" key={item.id}>
      <h4>{index + 1}. {item.category}：{item.original}</h4>
      <p>建议标签：{item.tag ?? '待确认'}</p>
      <p>表达者确认的要点：{item.original}</p>
      <p>表达转写原句：{item.speakerQuote || '未找到对应原句'}</p>
      <p>复述转写原句：{item.listenerQuote || '未找到对应句子'}</p>
      {item.clarification && <p>可澄清：{item.clarification}</p>}
      {item.listenerNote && <p>复述者澄清：{item.listenerNote}</p>}
      {item.observerTag && <p>观察者建议 · {item.observerTag}{item.observerNote ? ` · ${item.observerNote}` : ''}</p>}
      {role === 'observer' && (stage === 'SPEAKER_LABELING' || stage === 'MUTUAL_CONFIRM') && <div className="review-confirm">
        <label>建议标签<select value={observations[item.id]?.tag ?? item.observerTag ?? tags[0]} onChange={event => setObservations(current => ({ ...current, [item.id]: { tag: event.target.value, note: current[item.id]?.note ?? item.observerNote ?? '' } }))}>
          {tags.map(tag => <option key={tag}>{tag}</option>)}
        </select></label>
        <textarea aria-label={`第 ${index + 1} 条观察建议`} maxLength={500} value={observations[item.id]?.note ?? item.observerNote ?? ''}
          onChange={event => setObservations(current => ({ ...current, [item.id]: { tag: current[item.id]?.tag ?? item.observerTag ?? tags[0]!, note: event.target.value } }))} />
        <button className="secondary" disabled={busy} onClick={() => void send('observe', { issueId: item.id, tag: item.observerTag ?? tags[0], note: item.observerNote ?? '', ...observations[item.id] })}>提交观察建议</button>
      </div>}
      {isReport && item.resolution && <p>已确认结论：{resolutions.find(([value]) => value === item.resolution)?.[1]}</p>}
      {stage === 'MUTUAL_CONFIRM' && item.resolution && <p>待双方确认的结论：{resolutions.find(([value]) => value === item.resolution)?.[1]}</p>}
      {(!item.complete || !item.accurate) && editable && <>
        {role === 'speaker' && <div className="review-fields"><label>标签<select aria-label={`${item.category}标签`} value={choices[item.id]?.tag ?? item.tag ?? tags[0]} onChange={event => setChoices(current => ({ ...current, [item.id]: { tag: event.target.value, resolution: current[item.id]?.resolution ?? 'misunderstanding' } }))}>{tags.map(tag => <option key={tag}>{tag}</option>)}</select></label>
          <label>结论<select aria-label={`${item.category}结论`} value={choices[item.id]?.resolution ?? item.resolution ?? 'misunderstanding'} onChange={event => setChoices(current => ({ ...current, [item.id]: { tag: current[item.id]?.tag ?? item.tag ?? tags[0]!, resolution: event.target.value as Resolution } }))}>{resolutions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>}
        {stage === 'MUTUAL_CONFIRM' && <div className="review-confirm"><span>表达者：{item.speakerConfirmed ? '已确认' : '待确认'} · 复述者：{item.listenerConfirmed ? '已确认' : '待确认'}</span>
          {role === 'listener' && <><textarea aria-label={`第 ${index + 1} 条澄清`} maxLength={500}
            value={notes[item.id] ?? item.listenerNote ?? ''} onChange={event => setNotes(current => ({ ...current, [item.id]: event.target.value }))} />
            <button className="secondary" disabled={busy || !notes[item.id]?.trim() || notes[item.id]?.trim() === item.listenerNote}
              onClick={() => void send('clarify', { issueId: item.id, note: notes[item.id] })}>提交澄清</button></>}
          {role !== 'observer' && <button className="secondary" disabled={busy || (role === 'speaker' ? item.speakerConfirmed : item.listenerConfirmed)} onClick={() => void send('confirm', { issueId: item.id })}>确认这一条</button>}
          {role === 'speaker' && <button className="text-button" disabled={busy} onClick={() => void send('revise', { issueId: item.id, ...choices[item.id] })}>修改标签或结论</button>}
        </div>}
      </>}
    </article>)}
    {isComparison && role === 'speaker' && <button className="primary" onClick={onLabeling}>请表达者逐条标注</button>}
    {isComparison && role === 'listener' && <p role="status">等待表达者提交标注。</p>}
    {labeling && stage === 'SPEAKER_LABELING' && role === 'speaker' && <button className="primary" disabled={busy} onClick={() => void send('label', { labels: problems.map(item => ({ issueId: item.id, ...choices[item.id] })) })}>提交标注，邀请双方确认</button>}
    {stage === 'MUTUAL_CONFIRM' && solo && <button className="secondary" disabled={busy} onClick={() => void send('switch-seat', { seat: role === 'speaker' ? 'listener' : 'speaker' })}>切换到{role === 'speaker' ? '复述者' : '表达者'}座位</button>}
    {stage === 'MUTUAL_CONFIRM' && role === 'speaker' && <button className="primary" disabled={busy || !allConfirmed} onClick={() => void send('submit', {})}>表达者提交，查看改写建议</button>}
    {isReport && <a className="report-download" download="回声训练室-轮次报告.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(
      ['回声训练室 · 本轮报告', ...(seats ?? []), `完整度 ${result.complete}/${result.total}`, `准确度 ${result.accurate}/${result.total}`,
        ...problems.map(item => anonymous ? item.tag ?? '差异' : `${item.tag ?? '差异'}：${item.original}；复述：${item.listenerQuote || '未找到对应句子'}`)].join('\n'))}`}>导出本轮报告（TXT）</a>}
    {stage === 'MUTUAL_CONFIRM' && <p className="notice">{solo ? '请切换座位分别确认。' : '每条都要由表达者和复述者各自确认。'}修改标签或结论会清除该条旧确认。</p>}
  </section>;
}
