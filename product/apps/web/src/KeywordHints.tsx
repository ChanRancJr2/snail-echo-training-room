import { useState } from 'react';
import { boundedFetch as fetch } from './client.ts';

export function KeywordHints({ roundId }: { roundId: string }) {
  const [points, setPoints] = useState<{ id: string; category: string; text: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function reveal() {
    setBusy(true); setError(false);
    try {
      const used = await fetch(`/api/rounds/${roundId}/listening-aid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'keywords' }) });
      if (!used.ok) throw new Error();
      const response = await fetch(`/api/rounds/${roundId}/points`);
      if (!response.ok) throw new Error();
      setPoints(await response.json());
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return points ? <ul className="keyword-hints">{points.map(point => <li key={point.id}>{point.category} · {point.text}</li>)}</ul>
    : <><button className="secondary" disabled={busy} onClick={() => void reveal()}>查看关键词提示</button>{error && <p role="alert">暂时无法读取关键词，请重试。</p>}</>;
}
