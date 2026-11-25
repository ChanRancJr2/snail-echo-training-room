import { defineComponent, onErrorCaptured, onMounted, onUnmounted, ref } from 'vue';
import { RoomFlow } from './RoomFlow.tsx';
import { SoloPractice } from './SoloPractice.tsx';
import { History, type RecordSummary } from './History.tsx';
import { availableModes } from './flow.ts';
import { boundedFetch as fetch } from './client.ts';

const javaDemo = import.meta.env.VITE_ECHO_TARGET === 'java';
const maxNicknameLength = 20;

interface Session {
  id: string;
  nickname: string;
  expiresAt: string;
  named: boolean;
  handoffRoomId?: string;
}

function roomLocation() {
  return {
    invitation: new URLSearchParams(location.hash.slice(1)).has('invite'),
    room: new URLSearchParams(location.search).has('room'),
  };
}

const TrainingApp = defineComponent(() => {
  const session = ref<Session | null>(null);
  const nickname = ref('');
  const restoring = ref(true);
  const submitting = ref(false);
  const restoreError = ref(false);
  const error = ref('');
  const logoutPending = ref(false);
  const logoutError = ref('');
  const selected = ref<string | null>(null);
  const historyOpen = ref(false);
  const records = ref<RecordSummary[]>([]);
  const historyStatus = ref('');
  const { invitation, room } = roomLocation();
  const inRoom = ref(invitation || room);

  function acceptSession(value: Session) {
    if (!value.named) return;
    if (value.handoffRoomId) {
      history.replaceState({}, '', `?room=${encodeURIComponent(value.handoffRoomId)}`);
      inRoom.value = true;
    }
    session.value = value;
  }

  async function restoreSession() {
    restoring.value = true;
    restoreError.value = false;
    error.value = '';
    try {
      const response = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) return;
      if (!response.ok) throw new Error();
      acceptSession(await response.json() as Session);
    } catch {
      restoreError.value = true;
      error.value = '暂时无法检查登录状态，请检查网络后重试。';
    } finally {
      restoring.value = false;
    }
  }

  async function login(event: SubmitEvent) {
    event.preventDefault();
    if (submitting.value || restoring.value || restoreError.value) return;
    const name = nickname.value.trim();
    if (!name || name.length > maxNicknameLength) {
      error.value = '请输入 1–20 个字符的昵称。';
      return;
    }
    submitting.value = true;
    error.value = '';
    try {
      const response = await fetch('/api/sessions/anonymous', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: name }),
      });
      if (response.status === 400) {
        error.value = '昵称格式不正确，请检查后重试。';
        return;
      }
      if (response.status === 429) {
        error.value = '登录操作太频繁，请稍后再试。';
        return;
      }
      if (!response.ok) throw new Error();
      const value = await response.json() as Session;
      if (!value.named) throw new Error();
      acceptSession(value);
    } catch {
      error.value = '暂时无法登录，请检查网络后重试。';
    } finally {
      submitting.value = false;
    }
  }

  function followInvitation() {
    const { invitation, room } = roomLocation();
    if (invitation && !room) {
      selected.value = null;
      historyOpen.value = false;
      inRoom.value = true;
    }
  }

  async function logout() {
    if (logoutPending.value || !window.confirm('退出后，本次昵称会话将失效。重新输入同一昵称会开启新会话。确定退出吗？')) return;
    logoutPending.value = true;
    logoutError.value = '';
    try {
      const response = await fetch('/api/sessions/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error();
      session.value = null;
      nickname.value = '';
      window.scrollTo(0, 0);
    } catch {
      logoutError.value = '暂时无法退出，请检查网络后重试。';
    } finally {
      logoutPending.value = false;
    }
  }
  onMounted(() => {
    window.addEventListener('hashchange', followInvitation);
    void restoreSession();
  });
  onUnmounted(() => window.removeEventListener('hashchange', followInvitation));

  async function openHistory() {
    historyOpen.value = true;
    historyStatus.value = '正在读取复盘…';
    try {
      const response = await fetch('/api/history');
      if (!response.ok) throw new Error();
      records.value = await response.json() as RecordSummary[];
      historyStatus.value = '';
    } catch {
      historyStatus.value = '复盘暂时无法读取，请返回后重试。';
    }
  }
  function onRoomChange(active: boolean) {
    inRoom.value = active;
    if (!active) selected.value = null;
  }

  return () => {
    const showHome = session.value && !selected.value && !inRoom.value && !historyOpen.value;
    return <div class="shell">
      <header class="top"><span class="mark" aria-hidden="true">↗</span><strong>蜗牛回声训练室</strong><span class="status">V1.2.3</span></header>
      <main>
        {!window.isSecureContext && <p role="alert" class="notice">请通过 HTTPS 打开训练室，才能使用麦克风。</p>}
        {!session.value && <section class="login-screen" aria-labelledby="login-title">
          <h1 id="login-title" class="flow-title">昵称登录</h1>
          <p class="lead">{inRoom.value ? '填写昵称后，继续打开训练室。' : '填写你想在练习中使用的昵称。'}</p>
          {restoring.value ? <p role="status" class="notice">正在检查登录状态…</p>
            : <form class="card login-card" onSubmit={login} aria-busy={submitting.value}>
              <label for="login-nickname">昵称</label>
              <input id="login-nickname" name="nickname" type="text" autocomplete="nickname" maxlength={maxNicknameLength}
                placeholder="请输入昵称" value={nickname.value} disabled={submitting.value || restoreError.value} required
                onInput={event => { nickname.value = (event.target as HTMLInputElement).value; error.value = ''; }} />
              {error.value && <p role="alert" class="error-text">{error.value}</p>}
              {restoreError.value ? <button type="button" class="secondary" onClick={restoreSession}>重新检查登录状态</button>
                : <button type="submit" class="primary" disabled={submitting.value || !nickname.value.trim()}>
                  {submitting.value ? '正在登录…' : inRoom.value ? '登录并进入训练室' : '登录并开始练习'}
                </button>}
            </form>}
        </section>}
        {session.value && <>
          {showHome && <><h1>让“听懂了”，<br /><em>变成真的听懂。</em></h1>
            <p class="lead">先复述，不评价。对照说出去的和听到的差在哪里。</p></>}
          <p class="notice">已登录 · {session.value.nickname}</p>
          {showHome && <><h2>选择练法</h2>
            <div class="modes">{availableModes.map(([key, title, description, devices]) => <button type="button" key={key} onClick={() => {
              selected.value = key;
              window.scrollTo(0, 0);
            }}><span class="mode-heading"><strong>{title}</strong>{devices && <span class="mode-devices">{devices}</span>}</span><small>{description}</small></button>)}</div>
            {!javaDemo && <button class="secondary" onClick={openHistory}>复盘记录</button>}
            {javaDemo && <button type="button" class="text-button" disabled={logoutPending.value} onClick={() => void logout()}>
              {logoutPending.value ? '正在退出…' : '退出登录'}
            </button>}
            {logoutError.value && <p role="alert" class="error-text">{logoutError.value}</p>}</>}
          {historyOpen.value && <History records={records.value} status={historyStatus.value} onBack={() => { historyOpen.value = false; }} onDeleted={openHistory} />}
          {selected.value === 'practice' && !inRoom.value
            ? <SoloPractice onExit={() => {
              selected.value = null;
              window.scrollTo(0, 0);
            }} />
            : <>
              {selected.value && !inRoom.value && <button class="text-button" onClick={() => { selected.value = null; }}>← 返回首页</button>}
              {!historyOpen.value && <RoomFlow mode={selected.value} onRoomChange={onRoomChange} />}
            </>}
        </>}
      </main>
    </div>;
  };
}, { name: 'TrainingApp' });

export const App = defineComponent(() => {
  const failed = ref(false);
  onErrorCaptured(() => {
    failed.value = true;
    return false;
  });
  return () => failed.value
    ? <main role="alert"><p>页面加载出错，会话仍保留。</p><button onClick={() => location.reload()}>重新打开</button></main>
    : <TrainingApp />;
}, { name: 'App' });
