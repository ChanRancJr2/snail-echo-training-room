import { defineComponent, onBeforeUnmount, onMounted, reactive, shallowRef, watch } from 'vue';
import { boundedFetch as fetch, newRequestId } from './client.ts';
import { Recorder } from './Recorder.tsx';
import { AudioPlayer } from './AudioPlayer.tsx';
import { PointEditor } from './PointEditor.tsx';
import { ComparisonView } from './ComparisonView.tsx';
import { KeywordHints } from './KeywordHints.tsx';
import { trackListenerEngagement } from './listener-engagement.ts';
import { modes, nextPractice, roundStep } from './flow.ts';
import { isSameDevice, type Mode, type Stage } from '../../../packages/core/src/round.ts';

type Seat = 'speaker' | 'listener';
type Teen = { nickname: string; role: Seat; reportRole?: Seat | null; locked?: boolean; completed?: boolean };
type Room = { id: string; version: number; mode: Mode; status: string; durationSeconds: number; retellStyle: string; topic: string; roundId: string | null; stage: Stage | null; terminalReason?: string | null; roundVersion: number | null; activeSeat: Seat | null; deadlineAt: string | null; speakerAudioId: string | null; listenerAudioId: string | null; previousPractice: { complete: number; total: number } | null; reportRole?: 'speaker' | 'listener' | 'observer' | null; teen: Teen | null; you: { role: 'speaker' | 'listener' | 'observer'; ready: boolean; owner?: boolean }; members: { id: string; nickname: string; role: string; ready: boolean }[] };
const javaBackend = import.meta.env.VITE_ECHO_TARGET === 'java';
const waitingForExpression = '正在等待表达者录音并确认重点。';
const names = { speaker: '表达者', listener: '复述者', observer: '观察者' };
const messages: Record<string, string> = {
  RATE_LIMITED: '操作太频繁，请稍后再试。',
  ORIGIN_DENIED: '请通过训练室的正式 HTTPS 地址打开。',
  STALE_VERSION: '房间状态已更新，请确认后重试。',
  INVITATION_EXPIRED: '邀请已使用或过期，请让表达者重新生成。',
  INVITATION_PASSWORD: '此邀请为旧版链接，请让表达者重新生成。',
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

interface RoomFlowProps {
  mode: string | null;
  onRoomChange: (active: boolean) => void;
}

export const RoomFlow = defineComponent((props: RoomFlowProps) => {
  const state = reactive({
    room: null as Room | null, token: null as string | null, invite: null as string | null,
    inviteRole: 'listener' as 'listener' | 'observer', inviteMinutes: 60, inviteOnce: true, shareUrl: '',
    error: '', reconnecting: false, busy: false, durationSeconds: 30,
    retellStyle: 'auditory' as 'auditory' | 'keywords', topic: '家庭日常', customTopic: '',
    teenNickname: '', teenRole: 'listener' as 'speaker' | 'listener', guardianPin: '', guardianConsent: false,
    unlockOpen: false, unlockPin: '', task: null as { roundId: string; focus: string } | null, focus: '',
    labelingRound: null as string | null, handoffRound: null as string | null,
    capturingRound: null as string | null, reportDismissed: null as string | null,
  });
  function update<K extends keyof typeof state>(key: K, value: (typeof state)[K]) {
    state[key] = value;
  }
  const player = shallowRef<HTMLAudioElement | null>(null);
  const observerRetellPlayer = shallowRef<HTMLAudioElement | null>(null);
  let engagement: ReturnType<typeof trackListenerEngagement> | null = null;
  watch(() => {
    const room = state.room;
    return javaBackend && room?.mode === 'sync' && room.you.role === 'listener' &&
      room.stage === 'LISTENER_RETELL' ? room.roundId : null;
  }, (roundId, _, onCleanup) => {
    if (!roundId) return;
    const tracker = trackListenerEngagement(roundId);
    engagement = tracker;
    const detach = watch(player, media => tracker.attach(media), { immediate: true });
    onCleanup(() => {
      detach();
      tracker.close();
      engagement = null;
    });
  }, { flush: 'post' });
  let createKey: string | null = null;
  let live = true;

  const applySnapshot = (incoming: Room, isEntry = false) => {
    const current = state.room;
    if (live && (isEntry || current?.id === incoming.id && (
      incoming.version > current.version ||
      incoming.version === current.version && incoming.roundId === current.roundId &&
        (incoming.roundVersion ?? 0) >= (current.roundVersion ?? 0)
    ))) state.room = incoming;
  };

  const refresh = async (id: string, isEntry = false) => {
    applySnapshot(await call<Room>(`/api/rooms/${id}`), isEntry);
    if (live) state.reconnecting = false;
  };

  const readInvitation = () => {
    const incoming = new URLSearchParams(location.hash.slice(1)).get('invite');
    if (incoming && !state.room && !new URLSearchParams(location.search).has('room')) state.token = incoming;
  };

  onMounted(() => {
    readInvitation();
    window.addEventListener('hashchange', readInvitation);
    const id = new URLSearchParams(location.search).get('room');
    if (id && !state.token) void refresh(id, true).catch(cause => {
      if (!live) return;
      state.error = cause instanceof Error ? cause.message : '训练室恢复失败，请刷新重试。';
      if (cause instanceof HttpError && [401, 403, 404].includes(cause.status)) {
        history.replaceState({}, '', location.pathname);
        props.onRoomChange(false);
      }
    });
  });
  onBeforeUnmount(() => {
    live = false;
    window.removeEventListener('hashchange', readInvitation);
  });

  watch([() => state.room?.id, () => state.room?.status], ([id], _, onCleanup) => {
    if (!id) return;
    let active = true;
    let timer: number;
    const poll = async () => {
      await refresh(id).catch(cause => {
        if (!active) return;
        if (cause instanceof HttpError && [401, 403, 404].includes(cause.status)) {
          state.room = null;
          state.error = '训练室已关闭或会话已失效';
          history.replaceState({}, '', location.pathname);
          props.onRoomChange(false);
        } else state.reconnecting = true;
      });
      if (active) timer = window.setTimeout(poll, 2000);
    };
    timer = window.setTimeout(poll, 2000);
    onCleanup(() => { active = false; clearTimeout(timer); });
  });

  async function run(work: () => Promise<void>) {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    try { await work(); }
    catch (cause) { if (live) state.error = cause instanceof Error ? cause.message : '操作失败'; }
    finally { state.busy = false; }
  }

  const enterRoom = (room: Room) => {
    if (!live) return;
    applySnapshot(room, true);
    history.replaceState({}, '', `?room=${room.id}`);
    props.onRoomChange(true);
  };

  const create = () => void run(async () => {
    const mode = props.mode;
    const { durationSeconds, retellStyle, topic, customTopic, teenNickname, guardianPin, teenRole, guardianConsent } = state;
    if (!mode) return;
    createKey ??= newRequestId();
    const result = await call<{ state: Room; inviteToken: string | null }>('/api/rooms', {
      mode, createKey, durationSeconds, retellStyle, topic: topic === '自定义填写' ? customTopic.trim() : topic,
      ...(mode === 'teen' ? { teen: javaBackend
        ? { nickname: teenNickname.trim() || '孩子', role: teenRole }
        : { nickname: teenNickname.trim(), pin: guardianPin, role: teenRole, consent: guardianConsent } } : {}),
    });
    createKey = null;
    state.guardianPin = '';
    state.invite = result.inviteToken;
    state.shareUrl = javaBackend && mode === 'async' && result.inviteToken ? invitationUrl(result.inviteToken) : '';
    enterRoom(result.state);
  });

  const join = () => void run(async () => {
    const token = state.token;
    if (!token) return;
    const joined = await call<Room>('/api/rooms/join', { token });
    state.token = null;
    enterRoom(joined);
  });
  watch(() => state.token, token => { if (token && !state.room) join(); });

  const ready = () => void run(async () => {
    const room = state.room;
    if (room) applySnapshot(await call<Room>(`/api/rooms/${room.id}/ready`, { ready: !room.you.ready }));
  });
  const start = () => void run(async () => {
    if (state.room) applySnapshot(await call<Room>(`/api/rooms/${state.room.id}/start`, {}));
  });
  const prepareNext = () => void run(async () => {
    const room = state.room;
    if (room?.roundId && room.roundVersion) applySnapshot(await call<Room>(`/api/rooms/${room.id}/next-round`, {
      roundId: room.roundId, expectedVersion: room.roundVersion,
    }));
  });

  async function beginRecording(kind: 'speaker' | 'listener') {
    const { room, task } = state;
    if (!room?.roundId || !room.roundVersion) throw new Error('轮次状态尚未恢复');
    const firstRecording = kind === 'speaker' && room.stage === 'TASK';
    if (kind === 'listener') player.value?.pause();
    try {
      const result = await call<{ version: number; stage: Stage; deadlineAt: string }>(
        `/api/rounds/${room.roundId}/${firstRecording ? 'task' : 'restart-recording'}`, {
          expectedVersion: room.roundVersion,
          ...(firstRecording ? { focus: task?.roundId === room.roundId ? task.focus : '' } : { kind }),
        });
      const current = state.room;
      if (current?.id === room.id && current.roundId === room.roundId && (current.roundVersion ?? 0) < result.version) {
        state.room = { ...current, roundVersion: result.version, stage: result.stage, deadlineAt: result.deadlineAt };
      }
      return result.version;
    } finally {
      void refresh(room.id).catch(() => { if (state.room?.id === room.id) state.reconnecting = true; });
    }
  }

  const leave = () => void run(async () => {
    if (!state.room) return;
    await call(`/api/rooms/${state.room.id}/leave`, {});
    Object.assign(state, { room: null, invite: null, shareUrl: '', inviteRole: 'listener' });
    history.replaceState({}, '', location.pathname);
    props.onRoomChange(false);
  });

  const invitationUrl = (token: string) => `${location.origin}${location.pathname}#invite=${token}`;

  const makeInvite = (role: 'listener' | 'observer') => void run(async () => {
    const { room, inviteMinutes, inviteOnce } = state;
    if (!room) return;
    const { token } = await call<{ token: string }>(`/api/rooms/${room.id}/invitations`, {
      role, minutes: inviteMinutes, maxUses: inviteOnce ? 1 : 10,
    });
    state.invite = token;
    state.shareUrl = invitationUrl(token);
  });

  const share = () => void run(async () => {
    if (!state.invite) return;
    const url = invitationUrl(state.invite);
    state.shareUrl = url;
    try {
      if (navigator.share) await navigator.share({ title: '回声训练室邀请', url });
      else await navigator.clipboard?.writeText(url);
    } catch { /* The selectable link remains available. */ }
  });

  return () => {
    const { mode } = props;
    const { room, token, invite, inviteRole, inviteMinutes, inviteOnce, shareUrl, error,
      reconnecting, busy, durationSeconds, retellStyle, topic, customTopic, teenNickname, teenRole,
      guardianPin, guardianConsent, unlockOpen, unlockPin, task, focus, labelingRound, handoffRound,
      capturingRound, reportDismissed } = state;
    const sameDevice = Boolean(room && isSameDevice(room.mode));
    const compactReview = room?.mode === 'solo' || (javaBackend && room?.mode === 'teen');
    const asyncEntry = javaBackend && room?.mode === 'async';
    const roundRole = room?.reportRole ?? (sameDevice ? room?.activeSeat ?? room?.you.role : room?.you.role);
    const returnLabel = compactReview ? '再练一轮'
      : asyncEntry ? '返回训练室，准备下一轮'
      : room?.reportRole === 'observer' ? '返回训练室，继续做观察者'
      : room?.reportRole === 'speaker' ? '返回训练室，成为复述者'
      : room?.reportRole === 'listener' ? '返回训练室，成为表达者'
      : '返回训练室，准备下一轮';
    const recording = Boolean(room?.roundId && task?.roundId === room.roundId);
    const labeling = Boolean(room?.roundId && labelingRound === room.roundId);
    const step = room?.stage && roundStep(room.stage, { recording, labeling, compactReview });
    const needsHandoff = compactReview && room?.stage === 'LISTENER_RETELL' && handoffRound !== room.roundId;
    const listeningStep = room?.stage === 'LISTENER_RETELL' && !needsHandoff;
    const observing = roundRole === 'observer';
    const observeConfirmation = observing && room?.stage === 'MUTUAL_CONFIRM';
    const observeComparison = observing && room?.stage === 'SPEAKER_LABELING';
    const teen = room?.teen;
    const childTurn = teen && (teen.role === 'speaker' ? ['TASK','SPEAKER_RECORDING','KEYPOINT_CONFIRM'].includes(room?.stage ?? '') : room?.stage === 'LISTENER_RETELL');
    const needsChild = !javaBackend && teen && childTurn && !teen.locked && !teen.completed;
    const mustReturn = !javaBackend && teen?.locked && !childTurn;
    const waiting = room?.status === 'WAITING' && (room.stage !== 'ARCHIVED' || reportDismissed === room.roundId);
    const pendingInvite = room?.mode === 'async' && !room.members.some(member => member.role === 'listener')
      && !asyncEntry && room.stage === 'ASYNC_PENDING';
    const ownsRoom = room?.you.owner ?? room?.you.role === 'speaker';
    const guardianPanel = !javaBackend && room && teen?.locked && (unlockOpen || mustReturn) && <div class="card">
      <h2>{mustReturn ? '请把手机交还监护人' : '监护人验证'}</h2>
      <label>监护人退出码<input type="password" inputmode="numeric" autocomplete="off" maxlength={6} value={unlockPin} onInput={event => update('unlockPin', (event.target as HTMLInputElement | HTMLSelectElement).value)} /></label>
      <button class="primary" disabled={busy || !/^\d{6}$/.test(unlockPin)} onClick={() => void run(async () => {
        applySnapshot(await call<Room>(`/api/rooms/${room.id}/guardian/unlock`, { pin: unlockPin })); update('unlockOpen', false); update('unlockPin', '');
      })}>监护人已接回手机</button>
      {!mustReturn && <button class="text-button" onClick={() => { update('unlockOpen', false); update('unlockPin', ''); }}>继续练习</button>}
    </div>;
    const childRole = room?.stage === 'ARCHIVED' ? teen?.reportRole ?? teen?.role : teen?.role;
    const cancelledMessage = room?.terminalReason === 'COMPARISON_FAILED'
      ? '本轮对照未能完成，请开始新一轮。' : '本轮已超时，请开始新一轮。';
    return <section class="room-flow">
      {error && <div role="alert" class="notice error">{error}</div>}
      {room && reconnecting && <div role="status" class="notice">网络暂时中断，正在恢复训练室状态…</div>}
      {token && !room && (error ? <>
        <button class="secondary" onClick={join}>重新连接邀请</button>
        <button class="text-button" onClick={() => {
          update('error', '');
          update('token', null);
          history.replaceState({}, '', location.pathname);
          props.onRoomChange(false);
        }}>返回首页</button>
      </>
        : <p role="status" class="notice">正在打开训练室…</p>)}
      {!token && !room && mode && <div class="card"><h1 class="flow-title">{modes.find(([key]) => key === mode)?.[1]}</h1><p>选择本轮主题、发言时长和复述方式。</p>
        <strong>本轮主题</strong><div class="option-grid">{['家庭日常', '大学生活', '疾病与需求', '工作需求', '自定义填写'].map(value => <button key={value} class={topic === value ? 'chosen' : ''} onClick={() => update('topic', value)}>{value}</button>)}</div>
        {topic === '自定义填写' && <input aria-label="自定义主题" maxlength={80} placeholder="填写本轮主题" value={customTopic} onInput={event => update('customTopic', (event.target as HTMLInputElement | HTMLSelectElement).value)} />}
        <strong>每人发言时长</strong><div class="option-grid">{[[30, '30 秒'], [60, '1 分钟'], [120, '2 分钟'], [300, '5 分钟']].map(([value, label]) => <button key={value} class={durationSeconds === value ? 'chosen' : ''} onClick={() => update('durationSeconds', Number(value))}>{label}</button>)}</div>
        <strong>复述方式</strong><div class="option-grid">{[['auditory', '纯听觉'], ['keywords', '关键词辅助']].map(([value, label]) => <button key={value} class={retellStyle === value ? 'chosen' : ''} onClick={() => update('retellStyle', value as 'auditory' | 'keywords')}>{label}</button>)}</div>
        {mode === 'teen' && <section><h2>青少年临时身份</h2><label>孩子昵称<input maxlength={12} placeholder={javaBackend ? '选填，默认为孩子' : undefined} value={teenNickname} onInput={event => update('teenNickname', (event.target as HTMLInputElement | HTMLSelectElement).value)} /></label>
          <p>孩子本轮身份</p><div class="option-grid">{(['speaker','listener'] as const).map(role => <button key={role} class={teenRole === role ? 'chosen' : ''} onClick={() => update('teenRole', role)}>{names[role]}</button>)}</div>
          {!javaBackend && <>
            <label>设置 6 位监护人退出码<input type="password" inputmode="numeric" autocomplete="new-password" maxlength={6} value={guardianPin} onInput={event => update('guardianPin', (event.target as HTMLInputElement | HTMLSelectElement).value)} /></label>
            <label class="toggle-row"><input type="checkbox" checked={guardianConsent} onChange={event => update('guardianConsent', (event.target as HTMLInputElement).checked)} /> 我是监护人，同意本次训练、录音和转写。</label>
          </>}
        </section>}
        <button class="primary" disabled={busy || (!javaBackend && mode === 'teen' && (!guardianConsent || !teenNickname.trim() || !/^\d{6}$/.test(guardianPin))) || (topic === '自定义填写' && !customTopic.trim())} onClick={create}>创建训练室</button></div>}
      {room && waiting && asyncEntry && !ownsRoom && <div class="card"><p role="status">{waitingForExpression}</p></div>}
      {room && waiting && !guardianPanel && !asyncEntry && <div class="card"><h2>准备好，慢慢开始</h2><p>你的座位：{names[room.you.role]} · {room.topic} · {room.durationSeconds} 秒 · {room.retellStyle === 'keywords' ? '关键词辅助' : '纯听觉'}</p>
        {(sameDevice ? ['speaker','listener'] as const : ['speaker', 'listener', 'observer'] as const).map(role => {
          const member = room.members.find(item => item.role === role);
          if (sameDevice) return <div class="member" key={role}><span>座位 {role === 'speaker' ? 'A' : 'B'} · {names[role]}</span><b>{teen ? (role === teen.role ? teen.nickname : javaBackend ? '家长' : '监护人') : '你自己'}</b></div>;
          return <div class="member" key={role}><span>{names[role]}{member && ` · ${member.nickname}`}</span><b>{!member ? '待加入' : member.ready ? '已准备' : '未准备'}</b></div>;
        })}
        <button class="primary" disabled={busy} onClick={ready}>{room.you.ready ? '取消准备' : '准备好了'}</button>
        {room.you.role === 'speaker' && <button class="secondary" disabled={busy || !room.you.ready || (room.mode === 'sync' && !room.members.some(m => m.role === 'listener' && m.ready))} onClick={start}>开始本轮</button>}
        {room.stage === 'CANCELLED' && <p class="notice" role="status">{room.terminalReason === 'COMPARISON_FAILED' ? '本轮对照未能完成，请重新准备后开始一轮。' : '本轮已超时，请重新准备后开始一轮。'}</p>}
      </div>}
      {room && !guardianPanel && ownsRoom && !sameDevice && (waiting || pendingInvite) && <section class="card invite-card">
          <h2>{asyncEntry && waiting ? '邀请搭档，开始游戏' : '邀请搭档'}</h2>
          {!asyncEntry && <div class="option-grid" aria-label="邀请角色">
            <button class={inviteRole === 'listener' ? 'chosen' : ''} onClick={() => { if (inviteRole !== 'listener') { update('inviteRole', 'listener'); update('invite', null); update('shareUrl', ''); } }}>复述者</button>
            {room.status === 'WAITING' && <button class={inviteRole === 'observer' ? 'chosen' : ''} onClick={() => { if (inviteRole !== 'observer') { update('inviteRole', 'observer'); update('invite', null); update('shareUrl', ''); } }}>观察者</button>}
          </div>}
          <label>有效期 <select value={inviteMinutes} onChange={event => update('inviteMinutes', Number((event.target as HTMLInputElement | HTMLSelectElement).value))}>
            <option value={60}>1 小时</option><option value={1440}>24 小时</option><option value={10080}>7 天</option>
          </select></label>
          <label><input type="checkbox" checked={inviteOnce} onChange={event => update('inviteOnce', (event.target as HTMLInputElement).checked)} /> 仅可使用一次</label>
          <button class="secondary" disabled={busy} onClick={() => makeInvite(asyncEntry || room.status === 'ACTIVE' ? 'listener' : inviteRole)}>生成{asyncEntry || room.status === 'ACTIVE' ? '复述者' : names[inviteRole]}邀请</button>
          <button class="secondary" disabled={busy || !invite} onClick={share}>分享该链接</button>
          {shareUrl && <input aria-label="邀请链接" readonly value={shareUrl} onFocus={event => (event.currentTarget as HTMLInputElement).select()} />}
          {asyncEntry && waiting && <>
            {room.stage === 'CANCELLED' && <p class="notice" role="status">{cancelledMessage}</p>}
            <button class="primary" disabled={busy} onClick={start}>开始本轮</button>
          </>}
      </section>}
      {guardianPanel}
      {room && teen && needsChild && !guardianPanel && <div class="card"><h2>交棒给孩子</h2><p>{teen.nickname} · {names[teen.role]}</p>
        <button class="primary" disabled={busy} onClick={() => void run(async () => update('room', await call<Room>(`/api/rooms/${room.id}/guardian/handoff`, {})))}>确认交棒给 {teen.nickname}</button>
      </div>}
      {room && !guardianPanel && !needsChild && step && room.roundId && room.roundVersion && !(room.stage === 'ARCHIVED' && reportDismissed === room.roundId) && <>
        <div class="stepper" aria-label={`第 ${step.number} 步，共 ${step.count} 步`}>
          <span>第 {step.number} 步 / {step.count} · {step.label}</span>
          <div aria-hidden="true">{Array.from({ length: step.count }, (_, index) => <i key={index} class={index < step.number ? 'filled' : ''} />)}</div>
        </div>
        <h1 class="flow-title">{step.title}</h1>
        <p class="flow-context" data-seat={sameDevice ? roundRole : undefined}>{room.topic} · {names[roundRole ?? room.you.role]}{sameDevice ? ` · 座位 ${roundRole === 'listener' ? 'B' : 'A'}` : ''}{javaBackend && teen ? ` · ${roundRole === childRole ? teen.nickname : '家长'}` : ''}</p>
        <div class="card round-content">
          {room.stage === 'TASK' && !recording && (room.you.role === 'speaker' ? <>
            <h2>本轮设置</h2><p>每人 {room.durationSeconds} 秒 · {room.retellStyle === 'keywords' ? '关键词辅助' : '纯听觉'}</p>
            {room.previousPractice && <p class="notice">上轮采纳的建议 · {nextPractice(room.previousPractice.complete, room.previousPractice.total)}</p>}
            <label>预标本轮重点（可选）<input maxlength={80} value={focus} onInput={event => update('focus', (event.target as HTMLInputElement | HTMLSelectElement).value)} /></label>
            <button class="primary" onClick={() => { update('task', { roundId: room.roundId!, focus: focus.trim() }); update('focus', ''); }}>开始表达录音</button>
          </> : <p role="status">{asyncEntry ? waitingForExpression : '等待表达者开始本轮任务。'}</p>)}
          {((room.stage === 'TASK' && recording) || room.stage === 'SPEAKER_RECORDING') && (room.you.role === 'speaker'
            ? <Recorder key={room.roundId + ':speaker'} roundId={room.roundId} kind="speaker" version={room.roundVersion} maxSeconds={room.durationSeconds} onBegin={() => beginRecording('speaker')} onCommitted={() => refresh(room.id)} />
            : <p role="status">{waitingForExpression}</p>)}
          {room.stage === 'KEYPOINT_CONFIRM' && (room.you.role === 'speaker'
            ? <PointEditor roundId={room.roundId} version={room.roundVersion} onConfirmed={() => refresh(room.id)} />
            : <p role="status">{asyncEntry ? waitingForExpression : '表达者正在确认本轮信息点。'}</p>)}
          {room.stage === 'ASYNC_PENDING' && (room.you.role === 'listener'
            ? <button class="primary" disabled={busy} onClick={() => void run(async () => { await call(`/api/rounds/${room.roundId}/open-message`, { expectedVersion: room.roundVersion }); await refresh(room.id); })}>打开留言，开始复述</button>
            : <p role="status">留言已送达训练室，等待复述者打开。</p>)}
          {room.stage === 'COMPARING' && <p role="status">正在转写复述录音并生成逐条对照，请稍候。</p>}
          {needsHandoff && <><h2>交棒到座位 B</h2><p>切换到复述者的视角，先听录音，再用自己的话说。</p><button class="primary" onClick={() => update('handoffRound', room.roundId)}>{javaBackend && teen?.role === 'listener' ? `确认交棒给 ${teen.nickname}` : '确认交棒'}</button></>}
          {room.speakerAudioId && (observeConfirmation || (listeningStep && (observing || roundRole === 'listener'))) &&
            <AudioPlayer audioRef={player} key={room.speakerAudioId} roundId={room.roundId} audioId={room.speakerAudioId} tracksReplay={roundRole === 'listener'} buttonOnly={observing && listeningStep} blocked={capturingRound === room.roundId} />}
          {room.listenerAudioId && (observeComparison || observeConfirmation) &&
            <AudioPlayer audioRef={observerRetellPlayer} key={room.listenerAudioId} roundId={room.roundId} audioId={room.listenerAudioId} label="复述者录音" />}
          {listeningStep && room.retellStyle === 'keywords' && (observing || roundRole === 'listener') &&
            <KeywordHints key={room.roundId} roundId={room.roundId} observer={observing} />}
          {listeningStep && roundRole === 'listener' && <>
            <Recorder key={room.roundId + ':listener'} roundId={room.roundId} kind="listener" version={room.roundVersion} maxSeconds={room.durationSeconds} onBegin={() => beginRecording('listener')} onCommitted={() => refresh(room.id)} onRecordingStarted={() => engagement?.record()} onCaptureChange={active => {
              if (active) player.value?.pause();
              update('capturingRound', active ? room.roundId : null);
            }} />
          </>}
          {room.stage === 'LISTENER_RETELL' && roundRole === 'speaker' && <p role="status">等待复述者提交录音。</p>}
          {['SPEAKER_LABELING', 'MUTUAL_CONFIRM', 'ADVICE', 'ARCHIVED'].includes(room.stage ?? '') &&
            (room.stage !== 'ARCHIVED' || roundRole !== 'observer') &&
            <ComparisonView key={room.roundId} roundId={room.roundId} stage={room.stage!} version={room.roundVersion} role={roundRole ?? room.you.role} solo={sameDevice} compactReview={compactReview} atomicReview={javaBackend && compactReview} labeling={labeling} onLabeling={() => update('labelingRound', room.roundId)} onChanged={() => refresh(room.id)} />}
          {room.stage === 'ADVICE' && room.you.role === 'speaker' && <button class="primary" disabled={busy} onClick={prepareNext}>归档本轮并查看报告</button>}
          {room.stage === 'ARCHIVED' && roundRole === 'observer' && <p role="status">本轮已结束。</p>}
          {room.stage === 'ARCHIVED' && <button class="primary" onClick={() => {
            update('reportDismissed', room.roundId);
            update('invite', null);
            update('shareUrl', '');
          }}>{returnLabel}</button>}
          {room.stage === 'ARCHIVED' && !room.reportRole && room.mode === 'sync' && ownsRoom && room.members.some(member => member.role === 'listener') &&
            <button class="secondary" disabled={busy} onClick={() => void run(async () => {
              applySnapshot(await call<Room>(`/api/rooms/${room.id}/swap-seats`, { expectedVersion: room.version }));
              update('invite', null); update('shareUrl', ''); update('reportDismissed', room.roundId);
            })}>交换表达者与复述者</button>}
        </div>
      </>}
      {room && !guardianPanel && <button class="danger" disabled={busy} onClick={!javaBackend && teen?.locked ? () => update('unlockOpen', true) : leave}>{!javaBackend && teen?.locked ? '交还监护人' : ownsRoom ? '结束并关闭训练室' : '离开训练室'}</button>}
    </section>;
  };
}, { name: 'RoomFlow', props: ['mode', 'onRoomChange'] });
