import { computed, defineComponent, ref, watch, type PropType } from 'vue';
import { boundedFetch as fetch } from './client.ts';

const categories = ['人物', '事件', '需求', '情绪', '因果', '重点', '时间'] as const;
type Category = typeof categories[number];
type Point = { category: Category; text: string };
type Transcript = { status: 'off' | 'pending' | 'ready' | 'failed' | 'unavailable'; text?: string; candidates?: Point[] };

export const PointEditor = defineComponent({
  props: {
    roundId: { type: String, required: true },
    version: { type: Number, required: true },
    onConfirmed: { type: Function as PropType<() => Promise<void>>, required: true },
  },
  setup(props) {
    const category = ref<Category>('重点');
    const text = ref('');
    const points = ref<Point[]>([]);
    const busy = ref(false);
    const error = ref('');
    const transcript = ref<Transcript>();
    const loading = computed(() => !transcript.value || transcript.value.status === 'pending');

    watch(() => props.roundId, (roundId, _, onCleanup) => {
      points.value = [];
      text.value = '';
      transcript.value = undefined;
      error.value = '';
      const controller = new AbortController();
      let timer: number | undefined;
      let consecutiveFailures = 0;
      onCleanup(() => {
        controller.abort();
        window.clearTimeout(timer);
      });
      const check = async () => {
        try {
          const response = await fetch(`/api/rounds/${roundId}/speaker-transcript`, { signal: controller.signal });
          if (!response.ok) throw new Error('Transcript unavailable');
          const result = await response.json() as Transcript;
          if (controller.signal.aborted) return;
          consecutiveFailures = 0;
          transcript.value = result;
          if (result.status === 'ready' && result.candidates?.length) {
            const candidates = result.candidates.filter(candidate => !points.value.some(point => point.text === candidate.text));
            points.value = [...points.value, ...candidates].slice(0, 12);
          }
          if (result.status === 'pending') timer = window.setTimeout(check, 2500);
        } catch {
          if (controller.signal.aborted) return;
          if (++consecutiveFailures < 3) timer = window.setTimeout(check, 2500);
          else transcript.value = { status: 'unavailable' };
        }
      };
      void check();
    }, { immediate: true });

    function add() {
      const clean = text.value.trim();
      if (!clean || points.value.length >= 12) return;
      points.value.push({ category: category.value, text: clean });
      text.value = '';
    }

    async function confirm() {
      if (loading.value || busy.value) return;
      const { roundId, version, onConfirmed } = props;
      const confirmed = points.value.map(point => ({ ...point, text: point.text.trim() })).filter(point => point.text);
      busy.value = true;
      error.value = '';
      try {
        const response = await fetch(`/api/rounds/${roundId}/points/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: version, points: confirmed }) });
        if (!response.ok) throw new Error('确认失败，请刷新页面并重试。');
        await onConfirmed();
      } catch (cause) { error.value = cause instanceof Error ? cause.message : '确认失败'; }
      finally { busy.value = false; }
    }

    return () => <section class="point-editor"><h2>本轮信息点</h2><p>请核对 AI 提取的要点。你可以修改、删除或手动补充。</p>
      {loading.value && <div class="notice" role="status">正在转写录音并提取要点…</div>}
      {transcript.value?.status === 'failed' && <div class="notice" role="status">本次录音未能转写。可以直接继续，也可以补充要点。</div>}
      {transcript.value?.status === 'unavailable' && <div class="notice" role="status">暂时无法取得要点。可以直接继续，也可以补充要点。</div>}
      {transcript.value?.status === 'ready' && <>
        <details open><summary>表达录音转写</summary><p>{transcript.value.text || '未识别到清晰的语音。'}</p></details>
        {!transcript.value.candidates?.length && <div class="notice" role="status">本次未提取到可确认的要点。可以直接继续，也可以补充要点。</div>}
      </>}
      {points.value.map((point, index) => <div class="point-row" key={index}>
        <label>{point.category}<input aria-label={`第 ${index + 1} 条信息点`} maxlength={200} value={point.text} onInput={event => {
          point.text = (event.currentTarget as HTMLInputElement).value;
        }} /></label>
        <button class="text-button" onClick={() => points.value.splice(index, 1)}>删除</button>
      </div>)}
      <p>手动补充（选填）</p>
      <div class="point-entry"><select aria-label="信息点类别" value={category.value} onChange={event => { category.value = (event.currentTarget as HTMLSelectElement).value as Category; }}>{categories.map(value => <option key={value}>{value}</option>)}</select><input aria-label="信息点内容" maxlength={200} value={text.value} onInput={event => { text.value = (event.currentTarget as HTMLInputElement).value; }} placeholder="例如：午饭要看外婆身体情况" /></div>
      <button class="secondary" disabled={!text.value.trim() || points.value.length >= 12} onClick={add}>添加信息点</button>
      {error.value && <p role="alert" class="error-text">{error.value}</p>}
      <button class="primary" disabled={loading.value || busy.value} onClick={() => void confirm()}>确认重点，请搭档复述</button>
    </section>;
  },
});
