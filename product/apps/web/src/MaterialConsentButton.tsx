import { defineComponent, ref, watch, type PropType } from 'vue';
import { boundedFetch } from './client.ts';

export const MaterialConsentButton = defineComponent({
  props: {
    endpoint: { type: String, required: true },
    label: { type: String, required: true },
    recording: Object as PropType<Blob>,
  },
  setup(props) {
    const loading = ref(true);
    const sending = ref(false);
    const submitted = ref(false);
    const error = ref('');

    watch(() => props.endpoint, (endpoint, _, onCleanup) => {
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      loading.value = true;
      submitted.value = false;
      error.value = '';
      void boundedFetch(endpoint, { signal: controller.signal, cache: 'no-store' }).then(async response => {
        if (!response.ok) throw new Error('status_unavailable');
        const result = await response.json() as { submitted: boolean };
        if (!controller.signal.aborted) submitted.value ||= result.submitted;
      }).catch(() => {
        // The POST remains available when status lookup temporarily fails.
      }).finally(() => { if (!controller.signal.aborted) loading.value = false; });
    }, { immediate: true });

    async function submit() {
      if (loading.value || sending.value || submitted.value) return;
      const { endpoint, label, recording } = props;
      if (!window.confirm(`确认你是本段${label}的录音者，并同意将其提交，供后续处理并考虑纳入单人练习素材库？`)) return;
      sending.value = true;
      error.value = '';
      try {
        let body: FormData | undefined;
        if (recording) {
          body = new FormData();
          body.append('audio', recording, 'retell');
        }
        const response = await boundedFetch(endpoint, { method: 'POST', ...(body ? { body } : {}) }, 30000);
        if (!response.ok || !(await response.json() as { submitted: boolean }).submitted) throw new Error('submission_failed');
        if (props.endpoint === endpoint) submitted.value = true;
      } catch {
        if (props.endpoint === endpoint) error.value = '录音授权提交失败，请重试。';
      } finally {
        sending.value = false;
      }
    }

    return () => <div class="material-consent">
      <button type="button" class="secondary" disabled={loading.value || sending.value || submitted.value} onClick={() => void submit()}>
        {submitted.value ? '已同意上传' : sending.value ? '正在提交…' : '上传素材库'}
      </button>
      {error.value && <p role="alert" class="error-text">{error.value}</p>}
    </div>;
  },
});
