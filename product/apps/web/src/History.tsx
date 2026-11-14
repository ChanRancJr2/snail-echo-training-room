import { useState } from 'react';
import { ComparisonView } from './ComparisonView.tsx';
import { modes } from './flow.ts';
import { boundedFetch as fetch } from './client.ts';

export interface RecordSummary {
  id: string;
  roomId: string;
  canDelete: boolean;
  topic: string;
  mode: string;
  finishedAt: string;
  total: number;
  complete: number;
  accurate: number;
  tags: string[];
}

const ratio = (record: RecordSummary) => record.total ? Math.round(record.complete / record.total * 100) : 0;

type DeleteIntent = { scope: 'round' | 'room' | 'all'; targetId: string | null; count: number; rooms: number };

export function History({ records, status, onBack, onDeleted }: { records: RecordSummary[]; status: string; onBack: () => void; onDeleted: () => Promise<void> }) {
  const [mode, setMode] = useState('sync');
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<RecordSummary | null>(null);
  const [intent, setIntent] = useState<DeleteIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const filtered = records.filter(record => record.mode === mode && [record.topic, ...record.tags].some(value => value.includes(query.trim())));
  const trend = filtered.slice(0, 8).reverse();
  async function deletion(scope: DeleteIntent['scope'], targetId: string | null, execute = false) {
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/history/${execute ? 'delete' : 'deletion-preview'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, targetId, ...(execute ? { count: intent?.count, confirm: true } : {}) }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? '涉及轮次已变化，请重新确认。' : '无法删除，请核对权限后重试。');
      if (execute) { setIntent(null); setDetail(null); await onDeleted(); setMessage('已移除所选记录，录音对象将由后台清理。'); }
      else {
        const { count, rooms } = await response.json();
        if (count || rooms) setIntent({ scope, targetId, count, rooms });
        else setMessage('没有可删除的记录。');
      }
    } catch (cause) { setIntent(null); setMessage(cause instanceof Error ? cause.message : '网络中断，请重试。'); }
    finally { setBusy(false); }
  }
  if (intent) return <section><h1 className="flow-title">确认删除</h1><div className="card">
    <p>{intent.scope === 'round' ? '删除这一轮' : intent.scope === 'room' ? '删除整个训练室' : '删除我创建的全部训练数据'} · {intent.count} 轮{intent.rooms ? ` · ${intent.rooms} 个训练室` : ''}</p>
    <p>相关录音、转写、标注和报告将被删除。删除后无法从训练室恢复。</p>
    <button className="danger" disabled={busy} onClick={() => void deletion(intent.scope, intent.targetId, true)}>确认永久删除</button>
    <button className="secondary" disabled={busy} onClick={() => setIntent(null)}>取消</button>
  </div></section>;
  if (detail) return <section>
    <button className="text-button" onClick={() => setDetail(null)}>← 返回复盘</button><h1 className="flow-title">本轮报告</h1>
    <div className="card"><ComparisonView key={detail.id} roundId={detail.id} stage="ARCHIVED" version={1} role="speaker" solo={false} onChanged={async () => {}} /></div>
    {message && <p role="status">{message}</p>}
    {detail.canDelete && <><button className="danger" disabled={busy} onClick={() => void deletion('round', detail.id)}>删除本轮</button>
      <button className="danger" disabled={busy} onClick={() => void deletion('room', detail.roomId)}>删除整个训练室</button></>}
  </section>;
  return <section>
    <button className="text-button" onClick={onBack}>← 返回</button><h1 className="flow-title">复盘记录</h1>
    {message && <p role="status">{message}</p>}
    {status ? <p role="status">{status}</p> : <>
      <div className="option-grid" aria-label="复盘练法">{modes.map(([key, label]) => <button key={key} aria-pressed={mode === key} className={mode === key ? 'chosen' : ''} onClick={() => setMode(key)}>{label}</button>)}</div>
      <label className="search-field">搜索主题或误解标签<input type="search" maxLength={80} value={query} onChange={event => setQuery(event.target.value)} /></label>
      {!!trend.length && <div className="card"><h2>复述完整率</h2><ol className="history-trend" aria-label="最近八轮，从旧到新">
        {trend.map(record => <li key={record.id}><span>{new Date(record.finishedAt).toLocaleDateString()}</span><meter aria-label={`${record.topic}复述完整率`} min={0} max={100} value={ratio(record)} /><strong>{ratio(record)}%</strong>
          <small>误解类标签 · {record.tags.join('、') || '无'}</small></li>)}
      </ol></div>}
      {filtered.length ? filtered.map(record => <div className="card" key={record.id}>
        <strong>{record.topic}</strong><p>{new Date(record.finishedAt).toLocaleString()} · 完整 {record.complete}/{record.total} · 准确 {record.accurate}/{record.total}</p>
        <button className="secondary" onClick={() => setDetail(record)}>查看报告</button>
      </div>) : <p>这个练法暂无符合条件的记录。</p>}
      <button className="danger" disabled={busy} onClick={() => void deletion('all', null)}>删除我创建的全部训练数据</button>
    </>}
  </section>;
}
