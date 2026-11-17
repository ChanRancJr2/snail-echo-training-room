import { defineComponent, ref } from 'vue';
import { boundedFetch as fetch } from './client.ts';

export const KeywordHints = defineComponent({
  props: {
    roundId: { type: String, required: true },
    observer: Boolean,
  },
  setup(props) {
    const points = ref<{ id: string; category: string; text: string }[] | null>(null);
    const busy = ref(false);
    const error = ref(false);

    async function reveal() {
      const { roundId } = props;
      busy.value = true;
      error.value = false;
      try {
        if (!props.observer) {
          const used = await fetch(`/api/rounds/${roundId}/listening-aid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'keywords' }) });
          if (!used.ok) throw new Error();
        }
        const response = await fetch(`/api/rounds/${roundId}/points`);
        if (!response.ok) throw new Error();
        points.value = await response.json();
      } catch { error.value = true; }
      finally { busy.value = false; }
    }

    return () => points.value ? <ul class="keyword-hints">{points.value.map(point => <li key={point.id}>{point.category} · {point.text}</li>)}</ul>
      : <><button class="secondary" disabled={busy.value} onClick={() => void reveal()}>查看关键词提示</button>{error.value && <p role="alert">暂时无法读取关键词，请重试。</p>}</>;
  },
});
