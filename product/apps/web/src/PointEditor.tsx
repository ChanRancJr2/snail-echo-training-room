import { useEffect, useState } from 'react';
import { boundedFetch as fetch } from './client.ts';

const categories = ['人物', '事件', '需求', '情绪', '因果', '重点', '时间'] as const;
type Category = typeof categories[number];
type Point = { category: Category; text: string };

export function PointEditor({ roundId, version, onConfirmed }: { roundId: string; version: number; onConfirmed: () => Promise<void> }) {
  const [category, setCategory] = useState<Category>('重点');
  const [text, setText] = useState('');
  const [points, setPoints] = useState<Point[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [transcript, setTranscript] = useState<{ status: 'off' | 'pending' | 'ready' | 'failed'; text?: string; candidates?: Point[] }>();
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const check = async () => {
      try {
        const response = await fetch(`/api/rounds/${roundId}/speaker-transcript`, { signal: controller.signal });
        if (!response.ok) throw new Error('Transcript unavailable');
        const value = await response.json() as NonNullable<typeof transcript>;
        if (controller.signal.aborted) return;
        setTranscript(value);
        if (value.status === 'ready' && value.candidates?.length) {
          setPoints(current => [...current, ...value.candidates!.filter(candidate => !current.some(point => point.text === candidate.text))].slice(0, 12));
        }
        if (value.status === 'pending') timer = window.setTimeout(check, 2500);
      } catch {
        if (!controller.signal.aborted) timer = window.setTimeout(check, 5000);
      }
    };
    void check();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [roundId]);
  function add() {
    const clean = text.trim();
    if (!clean || points.length >= 12) return;
    setPoints(current => [...current, { category, text: clean }]); setText('');
  }
  async function confirm() {
    if (!points.length || busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/rounds/${roundId}/points/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: version, points }) });
      if (!response.ok) throw new Error('确认失败，请刷新页面并重试。');
      await onConfirmed();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '确认失败'); }
    finally { setBusy(false); }
  }
  return <section className="point-editor"><h2>本轮信息点</h2><p>请核对候选要点，也可以补充或删除。每条尽量只写一个意思。</p>
    {(!transcript || transcript.status === 'pending') && <div className="notice" role="status">录音转写中，可先手动填写重点。</div>}
    {transcript?.status === 'failed' && <div className="notice" role="status">本次未能完成转写，可以手动填写重点后继续。</div>}
    {transcript?.status === 'ready' && <details open><summary>表达录音转写</summary><p>{transcript.text || '未识别到清晰的语音。请手动填写要点。'}</p></details>}
    <div className="point-entry"><select aria-label="信息点类别" value={category} onChange={event => setCategory(event.target.value as Category)}>{categories.map(value => <option key={value}>{value}</option>)}</select><input aria-label="信息点内容" maxLength={200} value={text} onChange={event => setText(event.target.value)} placeholder="例如：午饭要看外婆身体情况" /></div>
    <button className="secondary" disabled={!text.trim() || points.length >= 12} onClick={add}>添加信息点</button>
    {points.map((point, index) => <div className="point-row" key={index}>
      <label>{point.category}<input aria-label={`第 ${index + 1} 条信息点`} maxLength={200} value={point.text} onChange={event => {
        const value = event.target.value;
        setPoints(current => current.map((item, position) => position === index ? { ...item, text: value } : item));
      }} /></label>
      <button className="text-button" onClick={() => setPoints(current => current.filter((_, position) => position !== index))}>删除</button>
    </div>)}
    {error && <p role="alert" className="error-text">{error}</p>}
    <button className="primary" disabled={!points.length || points.some(point => !point.text.trim()) || busy} onClick={() => void confirm()}>确认重点，请搭档复述</button>
  </section>;
}
