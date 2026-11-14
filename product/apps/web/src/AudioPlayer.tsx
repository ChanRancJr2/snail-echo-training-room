import { useRef, useState, type RefObject } from 'react';
import { boundedFetch as fetch } from './client.ts';

export function AudioPlayer({ roundId, audioId, audioRef: element, label = '表达者录音', tracksReplay = false, blocked = false }: {
  roundId: string; audioId: string; audioRef: RefObject<HTMLAudioElement | null>; label?: string; tracksReplay?: boolean; blocked?: boolean;
}) {
  const loading = useRef(false);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<'new' | 'playing' | 'paused' | 'heard'>('new');
  const [error, setError] = useState('');
  async function toggle() {
    const audio = element.current;
    if (!audio || loading.current || blocked) return;
    if (state === 'playing') { audio.pause(); setState('paused'); return; }
    if (state === 'paused' && audio.src) {
      try { await audio.play(); setState('playing'); setError(''); }
      catch { audio.removeAttribute('src'); setState('new'); setError('暂时无法播放，请重新点击播放。'); }
      return;
    }
    setError('');
    loading.current = true;
    setPending(true);
    try {
      let response: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { response = await fetch(`/api/rounds/${roundId}/audio/${audioId}/access`); }
        catch { response = null; }
        if (response && ![502, 503, 504].includes(response.status)) break;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
      }
      if (!response?.ok) throw new Error('暂时无法播放，请稍后重试。');
      if (state === 'heard' && tracksReplay) {
        const aid = await fetch(`/api/rounds/${roundId}/listening-aid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'replay' }) });
        if (!aid.ok) throw new Error('暂时无法记录重听，请重试。');
      }
      const result = await response.json() as { url: string };
      if (element.current !== audio) return;
      audio.src = result.url;
      audio.load();
      try { await audio.play(); setState('playing'); }
      catch { setState('paused'); setError('请再点一次「继续播放」。'); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '播放失败'); }
    finally { loading.current = false; setPending(false); }
  }
  return <div className="audio-player"><button className="secondary" disabled={pending || blocked} onClick={() => void toggle()}>{pending ? '正在加载录音…' : state === 'playing' ? '暂停播放' : state === 'paused' ? '继续播放' : state === 'heard' ? '已听过 · 再听一次' : `播放${label}`}</button>
    <audio ref={element} controls={!blocked && !tracksReplay} preload="none" onPlay={() => { if (blocked) element.current?.pause(); else setState('playing'); }} onPause={() => setState(current => current === 'playing' ? 'paused' : current)} onEnded={() => setState('heard')} />
    {error && <p role="alert" className="error-text">{error}</p>}
  </div>;
}
