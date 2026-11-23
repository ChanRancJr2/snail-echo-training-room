import { defineComponent } from 'vue';

const groups = [
  ['复述偏差', ['遗漏重要信息', '理解不到位', '理解偏了', '杜撰信息', '强加信息', '重点被误解']],
  ['表达问题', ['我表达不清', '我言不达意', '语气被误解']],
] as const;

export type RoundLabels = { retellTags: string[]; expressionTags: string[] };
export type RoundFeedback = RoundLabels & { note: string };
export const emptyLabels = (): RoundLabels => ({ retellTags: [], expressionTags: [] });

type LabelProps = { value: RoundLabels; disabled?: boolean; onChange: (value: RoundLabels) => void };
export const RoundLabelFields = defineComponent((props: LabelProps) => () => <>
  {groups.map(([legend, tags], index) => {
    const key = index === 0 ? 'retellTags' : 'expressionTags';
    return <fieldset class="round-labels" key={key} disabled={props.disabled}>
      <legend>{legend}（可多选）</legend>
      {tags.map(tag => <label key={tag}>
        <input type="checkbox" name={key} value={tag} checked={props.value[key].includes(tag)} onChange={event => {
          const checked = (event.currentTarget as HTMLInputElement).checked;
          const current = props.value[key];
          props.onChange({ ...props.value, [key]: checked ? [...current, tag] : current.filter(value => value !== tag) });
        }} /> {tag}
      </label>)}
    </fieldset>;
  })}
</>, { props: ['value', 'disabled', 'onChange'] });

export function feedbackSummary(feedback: RoundFeedback) {
  return <div class="round-feedback-summary">
    <p>复述偏差：{feedback.retellTags.join('、') || '无标注'}</p>
    <p>表达问题：{feedback.expressionTags.join('、') || '无标注'}</p>
    {feedback.note && <p>澄清：{feedback.note}</p>}
  </div>;
}
