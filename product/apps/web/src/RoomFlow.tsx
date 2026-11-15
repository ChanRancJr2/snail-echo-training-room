import { useEffect, useRef, useState } from 'react';
import { boundedFetch as fetch, newRequestId } from './client.ts';
import { Recorder } from './Recorder.tsx';
import { AudioPlayer } from './AudioPlayer.tsx';
import { PointEditor } from './PointEditor.tsx';
import { ComparisonView } from './ComparisonView.tsx';
import { KeywordHints } from './KeywordHints.tsx';
import { modes, nextPractice, roundStep } from './flow.ts';
import { isSameDevice, type Mode, type Stage } from '../../../packages/core/src/round.ts';

type Room = { id: string; version: number; mode: Mode; status: string; durationSeconds: number; retellStyle: string; topic: string; roundId: string | null; stage: Stage | null; terminalReason?: string | null; roundVersion: number | null; activeSeat: 'speaker' | 'listener' | null; deadlineAt: string | null; speakerAudioId: string | null; listenerAudioId: string | null; previousPractice: { complete: number; total: number } | null; teen: { nickname: string; role: 'speaker' | 'listener'; locked: boolean; completed: boolean } | null; you: { role: 'speaker' | 'listener' | 'observer'; ready: boolean; owner?: boolean }; members: { id: string; nickname: string; role: string; ready: boolean }[] };
const names = { speaker: '表达者', listener: '复述者', observer: '观察者' };
const messages: Record<string, string> = {
  RATE_LIMITED: '操作太频繁，请稍后再试。',
  ORIGIN_DENIED: '请通过训练室的正式 HTTPS 地址打开。',
  STALE_VERSION: '房间状态已更新，请确认后重试。',
  INVITATION_EXPIRED: '邀请已使用或过期，请让表达者重新生成。',
  INVITATION_PASSWORD: '邀请密码不正确。',
  INVITE_NOT_FOUND: '邀请链接无效，请让表达者重新分享。',
  ROOM_NOT_JOINABLE: '本轮已开始，暂时无法加入。',
  ROOM_CLOSED: '训练室已关闭。',
  PLAYERS_NOT_READY: '请等表达者和复述者都准备好。',
  NOT_ROOM_MEMBER: '你已离开或训练室已关闭。',
  UNAUTHENTICATED: '会话已过期，请刷新页面。',
  GUARDIAN_PIN_INVALID: '监护人退出码不正确。',
  GUARDIAN_REQUIRED: '请由监护人输入退出码后继续。',
};
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
async function call<T>(path: string, body?: object): Promise<T> {
  const options: RequestInit = { credentials: 'same-origin', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) };
  const retryable = body === undefined || path === '/api/rooms' || path === '/api/rooms/join' || path.endsWith('/ready') || path.endsWith('/next-round');
  let response: Response | null = null;
  for (let attempt = 0; attempt < (retryable ? 3 : 1); attempt++) {
    try { response = await fetch(path, options); }
    catch { response = null; }
    if (response && ![502, 503, 504].includes(response.status)) break;
    if (retryable && attempt < 2) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
  }
  if (!response) throw new Error('网络暂时中断，请稍后重试。');
  if (!response.ok) {
    const code = ((await response.json().catch(() => ({}))) as { error?: string }).error;
    throw new HttpError(response.status, code ? messages[code] ?? '操作失败，请稍后重试。' : `网络请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export function RoomFlow({ mode, onRoomChange }: { mode: string | null; onRoomChange: (active: boolean) => void }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [inviteRole, setInviteRole] = useState<'listener' | 'observer'>('listener');
  const [inviteMinutes, setInviteMinutes] = useState(60);
  const [invitePassword, setInvitePassword] = useState('');
  const [inviteOnce, setInviteOnce] = useState(true);
  const [shareUrl, setShareUrl] = useState('');
  const running = useRef(false);
  const createKey = useRef<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const [error, setError] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState(30);
  const [retellStyle, setRetellStyle] = useState<'auditory' | 'keywords'>('auditory');
  const [topic, setTopic] = useState('家庭日常');
  const [customTopic, setCustomTopic] = useState('');
  const [teenNickname, setTeenNickname] = useState('');
  const [teenRole, setTeenRole] = useState<'speaker' | 'listener'>('listener');
  const [guardianPin, setGuardianPin] = useState('');
  const [guardianConsent, setGuardianConsent] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockPin, setUnlockPin] = useState('');
  const [task, setTask] = useState<{ roundId: string; focus: string } | null>(null);
  const [focus, setFocus] = useState('');
  const [labelingRound, setLabelingRound] = useState<string | null>(null);
  const [handoffRound, setHandoffRound] = useState<string | null>(null);
  const [capturingRound, setCapturingRound] = useState<string | null>(null);
  const [reportDismissed, setReportDismissed] = useState<string | null>(null);
  const refresh = async (id: string, restore = false) => {
    const incoming = await call<Room>(`/api/rooms/${id}`);
    setRoom(current => restore ? incoming : current?.id === id && (
      incoming.version > current.version ||
      (incoming.version === current.version && incoming.roundId === current.roundId && (incoming.roundVersion ?? 0) > (current.roundVersion ?? 0))
    ) ? incoming : current);
    setReconnecting(false);
  };
  useEffect(() => {
    const incoming = new URLSearchParams(location.hash.slice(1)).get('invite');
    if (incoming) { setToken(incoming); return; }
    const id = new URLSearchParams(location.search).get('room');
    if (id) void refresh(id, true).catch(cause => {
      setError(cause instanceof Error ? cause.message : '训练室恢复失败，请刷新重试。');
      if (cause instanceof HttpError && [401, 403, 404].includes(cause.status)) {
        history.replaceState({}, '', location.pathname);
        onRoomChange(false);
      }
    });
  }, []);
  useEffect(() => {
    const readInvitation = () => {
      const incoming = new URLSearchParams(location.hash.slice(1)).get('invite');
      if (incoming && !new URLSearchParams(location.search).has('room')) setToken(incoming);
    };
    window.addEventListener('hashchange', readInvitation);
    return () => window.removeEventListener('hashchange', readInvitation);
  }, []);
  useEffect(() => {
    if (!room) return;
    let live = true;
    let timer: number;
    const poll = async () => { await refresh(room.id).catch(cause => {
      if (!live) return;
      if (cause instanceof HttpError && [401, 403, 404].includes(cause.status)) {
        setRoom(null); setError('训练室已关闭或会话已失效'); history.replaceState({}, '', location.pathname); onRoomChange(false);
      } else setReconnecting(true);
    }); if (live) timer = window.setTimeout(poll, 2000); };
    timer = window.setTimeout(poll, 2000);
    return () => { live = false; clearTimeout(timer); };
  }, [room?.id, room?.status]);
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { running.current = false; setBusy(false); }
  }
  const create = () => void run(async () => {
    if (!mode) return;
    createKey.current ??= newRequestId();
    const result = await call<{ state: Room; inviteToken: string | null }>('/api/rooms', { mode, createKey: createKey.current, durationSeconds, retellStyle, topic: topic === '自定义填写' ? customTopic.trim() : topic,
      ...(mode === 'teen' ? { teen: { nickname: teenNickname.trim(), pin: guardianPin, role: teenRole, consent: guardianConsent } } : {}) });
    createKey.current = null;
    setGuardianPin('');
    setRoom(result.state); setInvite(result.inviteToken); setShareUrl(''); onRoomChange(true); history.replaceState({}, '', `?room=${result.state.id}`);
  });
  const join = () => void run(async () => {
    const state = await call<Room>('/api/rooms/join', { token, password: password || null });
    setRoom(state); setToken(null); onRoomChange(true); history.replaceState({}, '', `?room=${state.id}`);
  });
  const ready = () => void run(async () => { if (room) setRoom(await call<Room>(`/api/rooms/${room.id}/ready`, { ready: !room.you.ready })); });
  const start = () => void run(async () => { if (room) setRoom(await call<Room>(`/api/rooms/${room.id}/start`, {})); });
  const prepareNext = () => void run(async () => {
    if (!room?.roundId || !room.roundVersion) return;
    setRoom(await call<Room>(`/api/rooms/${room.id}/next-round`, { roundId: room.roundId, expectedVersion: room.roundVersion }));
  });
  const sameDevice = Boolean(room && isSameDevice(room.mode));
  const roundRole = sameDevice ? room?.activeSeat ?? room?.you.role : room?.you.role;
  const beginRecording = async (kind: 'speaker' | 'listener') => {
    if (!room?.roundId || !room.roundVersion) throw new Error('轮次状态尚未恢复');
    const firstRecording = kind === 'speaker' && room.stage === 'TASK';
    if (kind === 'listener') player.current?.pause();
    try {
      const result = await call<{ version: number; stage: Stage; deadlineAt: string }>(`/api/rounds/${room.roundId}/${firstRecording ? 'task' : 'restart-recording'}`,
        firstRecording ? { expectedVersion: room.roundVersion, focus: task?.roundId === room.roundId ? task.focus : '' } : { expectedVersion: room.roundVersion, kind });
      setRoom(current => current?.roundId === room.roundId && (current.roundVersion ?? 0) < result.version
        ? { ...current, roundVersion: result.version, stage: result.stage, deadlineAt: result.deadlineAt } : current);
      void refresh(room.id).catch(() => setReconnecting(true));
      return result.version;
    } catch (cause) {
      void refresh(room.id).catch(() => setReconnecting(true));
      throw cause;
    }
  };
  const leave = () => void run(async () => { if (room) { await call(`/api/rooms/${room.id}/leave`, {}); setRoom(null); setInvite(null); setShareUrl(''); setInviteRole('listener'); history.replaceState({}, '', location.pathname); onRoomChange(false); } });
  const makeInvite = (role: 'listener' | 'observer') => void run(async () => {
    if (!room) return;
    const { token } = await call<{ token: string }>(`/api/rooms/${room.id}/invitations`, { role, minutes: inviteMinutes, maxUses: inviteOnce ? 1 : 10, password: invitePassword || null });
    setInvite(token);
    setShareUrl(`${location.origin}/#invite=${token}`);
  });
  const share = () => void run(async () => {
    if (!invite) return;
    const url = `${location.origin}${location.pathname}#invite=${invite}`;
    setShareUrl(url);
    try { if (navigator.share) await navigator.share({ title: '回声训练室邀请', url }); else await navigator.clipboard?.writeText(url); }
    catch { /* The selectable link remains available. */ }
  });
  const recording = Boolean(room?.roundId && task?.roundId === room.roundId);
  const labeling = Boolean(room?.roundId && labelingRound === room.roundId);
  const step = room?.stage && roundStep(room.stage, { recording, labeling });
  const needsHandoff = room?.mode === 'solo' && room.stage === 'LISTENER_RETELL' && handoffRound !== room.roundId;
  const canListen = room && room.stage !== 'ASYNC_PENDING' && ['LISTENER_RETELL', 'COMPARING', 'SPEAKER_LABELING', 'MUTUAL_CONFIRM', 'ADVICE'].includes(room.stage ?? '');
  const teen = room?.teen;
  const childTurn = teen && (teen.role === 'speaker' ? ['TASK','SPEAKER_RECORDING','KEYPOINT_CONFIRM'].includes(room?.stage ?? '') : room?.stage === 'LISTENER_RETELL');
  const needsChild = teen && childTurn && !teen.locked && !teen.completed;
  const mustReturn = teen?.locked && !childTurn;
  const waiting = room?.status === 'WAITING' && (room.stage !== 'ARCHIVED' || reportDismissed === room.roundId);
  const pendingInvite = room?.mode === 'async' && room.stage === 'ASYNC_PENDING' && !room.members.some(member => member.role === 'listener');
  const ownsRoom = room?.you.owner ?? room?.you.role === 'speaker';
  const guardianPanel = room && teen?.locked && (unlockOpen || mustReturn) && <div className="card">
    <h2>{mustReturn ? '请把手机交还监护人' : '监护人验证'}</h2>
    <label>监护人退出码<input type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={unlockPin} onChange={event => setUnlockPin(event.target.value)} /></label>
    <button className="primary" disabled={busy || !/^\d{6}$/.test(unlockPin)} onClick={() => void run(async () => {
      setRoom(await call<Room>(`/api/rooms/${room.id}/guardian/unlock`, { pin: unlockPin })); setUnlockOpen(false); setUnlockPin('');
    })}>监护人已接回手机</button>
    {!mustReturn && <button className="text-button" onClick={() => { setUnlockOpen(false); setUnlockPin(''); }}>继续练习</button>}
  </div>;
  return <section className="room-flow">
    {error && <div role="alert" className="notice error">{error}</div>}
    {room && reconnecting && <div role="status" className="notice">网络暂时中断，正在恢复训练室状态…</div>}
    {token && !room && <div className="card"><h2>加入训练室</h2><p>邀请决定你的座位。若有密码，请先填写。</p><input aria-label="邀请密码" type="password" value={password} onChange={event => setPassword(event.target.value)} /><button className="primary" disabled={busy} onClick={join}>加入</button></div>}
    {!token && !room && mode && <div className="card"><h1 className="flow-title">{modes.find(([key]) => key === mode)?.[1]}</h1><p>选择本轮主题、发言时长和复述方式。</p>
      <strong>本轮主题</strong><div className="option-grid">{['家庭日常', '大学生活', '疾病与需求', '工作需求', '自定义填写'].map(value => <button key={value} className={topic === value ? 'chosen' : ''} onClick={() => setTopic(value)}>{value}</button>)}</div>
      {topic === '自定义填写' && <input aria-label="自定义主题" maxLength={80} placeholder="填写本轮主题" value={customTopic} onChange={event => setCustomTopic(event.target.value)} />}
      <strong>每人发言时长</strong><div className="option-grid">{[[30, '30 秒'], [60, '1 分钟'], [120, '2 分钟'], [300, '5 分钟']].map(([value, label]) => <button key={value} className={durationSeconds === value ? 'chosen' : ''} onClick={() => setDurationSeconds(Number(value))}>{label}</button>)}</div>
      <strong>复述方式</strong><div className="option-grid">{[['auditory', '纯听觉'], ['keywords', '关键词辅助']].map(([value, label]) => <button key={value} className={retellStyle === value ? 'chosen' : ''} onClick={() => setRetellStyle(value as 'auditory' | 'keywords')}>{label}</button>)}</div>
      {mode === 'teen' && <section><h2>青少年临时身份</h2><label>孩子昵称<input maxLength={12} value={teenNickname} onChange={event => setTeenNickname(event.target.value)} /></label>
        <p>孩子本轮身份</p><div className="option-grid">{(['speaker','listener'] as const).map(role => <button key={role} className={teenRole === role ? 'chosen' : ''} onClick={() => setTeenRole(role)}>{names[role]}</button>)}</div>
        <label>设置 6 位监护人退出码<input type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={guardianPin} onChange={event => setGuardianPin(event.target.value)} /></label>
        <label className="toggle-row"><input type="checkbox" checked={guardianConsent} onChange={event => setGuardianConsent(event.target.checked)} /> 我是监护人，同意本次训练、录音和转写。</label>
      </section>}
      <button className="primary" disabled={busy || (mode === 'teen' && (!guardianConsent || !teenNickname.trim() || !/^\d{6}$/.test(guardianPin))) || (topic === '自定义填写' && !customTopic.trim())} onClick={create}>创建训练室</button></div>}
    {room && waiting && !guardianPanel && <div className="card"><h2>准备好，慢慢开始</h2><p>你的座位：{names[room.you.role]} · {room.topic} · {room.durationSeconds} 秒 · {room.retellStyle === 'keywords' ? '关键词辅助' : '纯听觉'}</p>
      {(sameDevice ? ['speaker','listener'] as const : ['speaker', 'listener', 'observer'] as const).map(role => {
        const member = room.members.find(item => item.role === role);
        if (sameDevice) return <div className="member" key={role}><span>座位 {role === 'speaker' ? 'A' : 'B'} · {names[role]}</span><b>{teen ? (role === teen.role ? teen.nickname : '监护人') : '你自己'}</b></div>;
        return <div className="member" key={role}><span>{names[role]}{member && ` · ${member.nickname}`}</span><b>{!member ? '待加入' : member.ready ? '已准备' : '未准备'}</b></div>;
      })}
      <button className="primary" disabled={busy} onClick={ready}>{room.you.ready ? '取消准备' : '准备好了'}</button>
      {room.you.role === 'speaker' && <button className="secondary" disabled={busy || !room.you.ready || (room.mode === 'sync' && !room.members.some(m => m.role === 'listener' && m.ready))} onClick={start}>开始本轮</button>}
      {room.stage === 'CANCELLED' && <p className="notice" role="status">{room.terminalReason === 'COMPARISON_FAILED' ? '本轮对照未能完成，请重新准备后开始一轮。' : '本轮已超时，请重新准备后开始一轮。'}</p>}
    </div>}
    {room && !guardianPanel && ownsRoom && !sameDevice && (waiting || pendingInvite) && <section className="card invite-card">
        <h2>邀请搭档</h2>
        <div className="option-grid" aria-label="邀请角色">
          <button className={inviteRole === 'listener' ? 'chosen' : ''} onClick={() => { if (inviteRole !== 'listener') { setInviteRole('listener'); setInvite(null); setShareUrl(''); } }}>复述者</button>
          {room.status === 'WAITING' && <button className={inviteRole === 'observer' ? 'chosen' : ''} onClick={() => { if (inviteRole !== 'observer') { setInviteRole('observer'); setInvite(null); setShareUrl(''); } }}>观察者</button>}
        </div>
        <label>有效期 <select value={inviteMinutes} onChange={event => setInviteMinutes(Number(event.target.value))}>
          <option value={60}>1 小时</option><option value={1440}>24 小时</option><option value={10080}>7 天</option>
        </select></label>
        <label>邀请密码（可选） <input type="password" minLength={6} maxLength={100} value={invitePassword} onChange={event => setInvitePassword(event.target.value)} /></label>
        <label><input type="checkbox" checked={inviteOnce} onChange={event => setInviteOnce(event.target.checked)} /> 仅可使用一次</label>
        <button className="secondary" disabled={busy || (invitePassword.length > 0 && invitePassword.length < 6)} onClick={() => makeInvite(room.status === 'ACTIVE' ? 'listener' : inviteRole)}>生成{room.status === 'ACTIVE' ? '复述者' : names[inviteRole]}邀请</button>
        <button className="secondary" disabled={busy || !invite} onClick={share}>分享该链接</button>
        {shareUrl && <input aria-label="邀请链接" readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} />}
    </section>}
    {guardianPanel}
    {room && needsChild && !guardianPanel && <div className="card"><h2>交棒给孩子</h2><p>{teen.nickname} · {names[teen.role]}</p>
      <button className="primary" disabled={busy} onClick={() => void run(async () => setRoom(await call<Room>(`/api/rooms/${room.id}/guardian/handoff`, {})))}>确认交棒给 {teen.nickname}</button>
    </div>}
    {room && !guardianPanel && !needsChild && step && room.roundId && room.roundVersion && !(room.stage === 'ARCHIVED' && reportDismissed === room.roundId) && <>
      <div className="stepper" aria-label={`第 ${step.number} 步，共 ${step.count} 步`}>
        <span>第 {step.number} 步 / {step.count} · {step.label}</span>
        <div aria-hidden="true">{Array.from({ length: step.count }, (_, index) => <i key={index} className={index < step.number ? 'filled' : ''} />)}</div>
      </div>
      <h1 className="flow-title">{step.title}</h1>
      <p className="flow-context" data-seat={sameDevice ? roundRole : undefined}>{room.topic} · {names[roundRole ?? room.you.role]}{sameDevice ? ` · 座位 ${roundRole === 'listener' ? 'B' : 'A'}` : ''}</p>
      <div className="card round-content">
        {room.stage === 'TASK' && !recording && (room.you.role === 'speaker' ? <>
          <h2>本轮设置</h2><p>每人 {room.durationSeconds} 秒 · {room.retellStyle === 'keywords' ? '关键词辅助' : '纯听觉'}</p>
          {room.previousPractice && <p className="notice">上轮采纳的建议 · {nextPractice(room.previousPractice.complete, room.previousPractice.total)}</p>}
          <label>预标本轮重点（可选）<input maxLength={80} value={focus} onChange={event => setFocus(event.target.value)} /></label>
          <button className="primary" onClick={() => { setTask({ roundId: room.roundId!, focus: focus.trim() }); setFocus(''); }}>开始表达录音</button>
        </> : <p role="status">等待表达者开始本轮任务。</p>)}
        {((room.stage === 'TASK' && recording) || room.stage === 'SPEAKER_RECORDING') && (room.you.role === 'speaker'
          ? <Recorder key={room.roundId + ':speaker'} roundId={room.roundId} kind="speaker" version={room.roundVersion} maxSeconds={room.durationSeconds} onBegin={() => beginRecording('speaker')} onCommitted={() => refresh(room.id)} />
          : <p role="status">正在等待表达者录音并确认重点。</p>)}
        {room.stage === 'KEYPOINT_CONFIRM' && (room.you.role === 'speaker'
          ? <PointEditor roundId={room.roundId} version={room.roundVersion} onConfirmed={() => refresh(room.id)} />
          : <p role="status">表达者正在确认本轮信息点。</p>)}
        {room.stage === 'ASYNC_PENDING' && (room.you.role === 'listener'
          ? <button className="primary" disabled={busy} onClick={() => void run(async () => { await call(`/api/rounds/${room.roundId}/open-message`, { expectedVersion: room.roundVersion }); await refresh(room.id); })}>打开留言，开始复述</button>
          : <p role="status">留言已送达训练室，等待复述者打开。</p>)}
        {room.stage === 'COMPARING' && <p role="status">正在转写复述录音并生成逐条对照，请稍候。</p>}
        {needsHandoff && <><h2>交棒到座位 B</h2><p>切换到复述者的视角，先听录音，再用自己的话说。</p><button className="primary" onClick={() => setHandoffRound(room.roundId)}>确认交棒</button></>}
        {canListen && !needsHandoff && room.speakerAudioId && (roundRole === 'observer' || (room.stage === 'LISTENER_RETELL' && roundRole === 'listener')) &&
          <AudioPlayer audioRef={player} key={room.roundId} roundId={room.roundId} audioId={room.speakerAudioId} tracksReplay={roundRole === 'listener'} blocked={capturingRound === room.roundId} />}
        {room.stage === 'LISTENER_RETELL' && !needsHandoff && roundRole === 'listener' && <>
          {room.retellStyle === 'keywords' && <KeywordHints key={room.roundId} roundId={room.roundId} />}
          <Recorder key={room.roundId + ':listener'} roundId={room.roundId} kind="listener" version={room.roundVersion} maxSeconds={room.durationSeconds} onBegin={() => beginRecording('listener')} onCommitted={() => refresh(room.id)} onCaptureChange={active => {
            if (active) player.current?.pause();
            setCapturingRound(active ? room.roundId : null);
          }} />
        </>}
        {room.stage === 'LISTENER_RETELL' && roundRole === 'speaker' && <p role="status">等待复述者提交录音。</p>}
        {['SPEAKER_LABELING', 'MUTUAL_CONFIRM', 'ADVICE', 'ARCHIVED'].includes(room.stage ?? '') && <ComparisonView key={room.roundId} roundId={room.roundId} stage={room.stage!} version={room.roundVersion} role={roundRole ?? room.you.role} solo={sameDevice} labeling={labeling} onLabeling={() => setLabelingRound(room.roundId)} onChanged={() => refresh(room.id)} />}
        {room.stage === 'ADVICE' && room.you.role === 'speaker' && <button className="primary" disabled={busy} onClick={prepareNext}>归档本轮并查看报告</button>}
        {room.stage === 'ARCHIVED' && <button className="primary" onClick={() => setReportDismissed(room.roundId)}>返回训练室，准备下一轮</button>}
        {room.stage === 'ARCHIVED' && room.mode === 'sync' && ownsRoom && room.members.some(member => member.role === 'listener') &&
          <button className="secondary" disabled={busy} onClick={() => void run(async () => {
            setRoom(await call<Room>(`/api/rooms/${room.id}/swap-seats`, { expectedVersion: room.version }));
            setInvite(null); setShareUrl(''); setReportDismissed(room.roundId);
          })}>交换表达者与复述者</button>}
      </div>
    </>}
    {room && !guardianPanel && <button className="danger" disabled={busy} onClick={teen?.locked ? () => setUnlockOpen(true) : leave}>{teen?.locked ? '交还监护人' : ownsRoom ? '结束并关闭训练室' : '离开训练室'}</button>}
  </section>;
}
