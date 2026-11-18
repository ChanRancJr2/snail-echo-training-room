import { computed, defineComponent, ref } from 'vue';
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

type HistoryProps = { records: RecordSummary[]; status: string; onBack: () => void; onDeleted: () => Promise<void> };

export const History = defineComponent((props: HistoryProps) => {
  const mode = ref('sync');
  const query = ref('');
  const selectedDetail = ref<RecordSummary | null>(null);
  const pendingDeletion = ref<DeleteIntent | null>(null);
  const deleting = ref(false);
  const deletionMessage = ref('');
  const filteredRecords = computed(() => {
    const search = query.value.trim();
    return props.records.filter(record => record.mode === mode.value && [record.topic, ...record.tags].some(value => value.includes(search)));
  });
  const trendRecords = computed(() => filteredRecords.value.slice(0, 8).reverse());

  async function deletion(scope: DeleteIntent['scope'], targetId: string | null, execute = false) {
    if (deleting.value) return;
    deleting.value = true;
    deletionMessage.value = '';
    try {
      const response = await fetch(`/api/history/${execute ? 'delete' : 'deletion-preview'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, targetId, ...(execute ? { count: pendingDeletion.value?.count, confirm: true } : {}) }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? '涉及轮次已变化，请重新确认。' : '无法删除，请核对权限后重试。');
      if (execute) {
        pendingDeletion.value = null;
        selectedDetail.value = null;
        await props.onDeleted();
        deletionMessage.value = '已移除所选记录，录音对象将由后台清理。';
      } else {
        const { count, rooms } = await response.json();
        if (count || rooms) pendingDeletion.value = { scope, targetId, count, rooms };
        else deletionMessage.value = '没有可删除的记录。';
      }
    } catch (cause) {
      pendingDeletion.value = null;
      deletionMessage.value = cause instanceof Error ? cause.message : '网络中断，请重试。';
    } finally {
      deleting.value = false;
    }
  }

  return () => {
    const { status, onBack } = props;
    const intent = pendingDeletion.value;
    const detail = selectedDetail.value;
    const busy = deleting.value;
    const message = deletionMessage.value;
    const filtered = filteredRecords.value;
    const trend = trendRecords.value;

    if (intent) return <section><h1 class="flow-title">确认删除</h1><div class="card">
      <p>{intent.scope === 'round' ? '删除这一轮' : intent.scope === 'room' ? '删除整个训练室' : '删除我创建的全部训练数据'} · {intent.count} 轮{intent.rooms ? ` · ${intent.rooms} 个训练室` : ''}</p>
      <p>相关录音、转写、标注和报告将被删除。删除后无法从训练室恢复。</p>
      <button class="danger" disabled={busy} onClick={() => void deletion(intent.scope, intent.targetId, true)}>确认永久删除</button>
      <button class="secondary" disabled={busy} onClick={() => { pendingDeletion.value = null; }}>取消</button>
    </div></section>;
    if (detail) return <section>
      <button class="text-button" onClick={() => { selectedDetail.value = null; }}>← 返回复盘</button><h1 class="flow-title">本轮报告</h1>
      <div class="card"><ComparisonView key={detail.id} roundId={detail.id} stage="ARCHIVED" version={1} role="speaker" solo={false} onChanged={async () => {}} /></div>
      {message && <p role="status">{message}</p>}
      {detail.canDelete && <><button class="danger" disabled={busy} onClick={() => void deletion('round', detail.id)}>删除本轮</button>
        <button class="danger" disabled={busy} onClick={() => void deletion('room', detail.roomId)}>删除整个训练室</button></>}
    </section>;
    return <section>
      <button class="text-button" onClick={onBack}>← 返回</button><h1 class="flow-title">复盘记录</h1>
      {message && <p role="status">{message}</p>}
      {status ? <p role="status">{status}</p> : <>
        <div class="option-grid" aria-label="复盘练法">{modes.map(([key, label]) => <button key={key} aria-pressed={mode.value === key} class={mode.value === key ? 'chosen' : ''} onClick={() => { mode.value = key; }}>{label}</button>)}</div>
        <label class="search-field">搜索主题或误解标签<input type="search" maxlength={80} value={query.value} onInput={event => { query.value = (event.currentTarget as HTMLInputElement).value; }} /></label>
        {!!trend.length && <div class="card"><h2>复述完整率</h2><ol class="history-trend" aria-label="最近八轮，从旧到新">
          {trend.map(record => <li key={record.id}><span>{new Date(record.finishedAt).toLocaleDateString()}</span><meter aria-label={`${record.topic}复述完整率`} min={0} max={100} value={ratio(record)} /><strong>{ratio(record)}%</strong>
            <small>误解类标签 · {record.tags.join('、') || '无'}</small></li>)}
        </ol></div>}
        {filtered.length ? filtered.map(record => <div class="card" key={record.id}>
          <strong>{record.topic}</strong><p>{new Date(record.finishedAt).toLocaleString()} · 完整 {record.complete}/{record.total} · 准确 {record.accurate}/{record.total}</p>
          <button class="secondary" onClick={() => { selectedDetail.value = record; }}>查看报告</button>
        </div>) : <p>这个练法暂无符合条件的记录。</p>}
        <button class="danger" disabled={busy} onClick={() => void deletion('all', null)}>删除我创建的全部训练数据</button>
      </>}
    </section>;
  };
}, { name: 'History', props: ['records', 'status', 'onBack', 'onDeleted'] });
