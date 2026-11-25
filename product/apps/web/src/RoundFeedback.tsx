import { defineComponent } from 'vue';

const groups = [
  ['retellTags', '给复述者贴的标签（表达者评价复述方）', ['遗漏重要信息', '理解不到位', '理解偏了', '杜撰信息', '强加信息', '重点被误解', '语意被误解']],
  ['expressionTags', '表达者给自己的语言贴的标签（自我评价）', ['我表达不清', '我言不达意', '我记不清', '我有点紧张']],
] as const;

export type RoundLabels = { retellTags: string[]; expressionTags: string[] };
export type RoundFeedback = RoundLabels & { note: string; accuratePointIds?: string[] | null };
export type ReviewPoint = { id: string; original: string };
export const emptyLabels = (): RoundLabels => ({ retellTags: [], expressionTags: [] });

type PointProps = { points: ReviewPoint[]; selected: string[]; disabled?: boolean; onChange: (ids: string[]) => void };
export const AccuratePointFields = defineComponent((props: PointProps) => () => (
  <fieldset class="round-labels" disabled={props.disabled}>
    <legend>准确复述的要点（可多选）</legend>
    {props.points.length === 0 ? <p>本轮没有可核对的要点。</p> : props.points.map(point => (
      <label class="point-choice" key={point.id}>
        <input type="checkbox" name="accuratePointIds" value={point.id} checked={props.selected.includes(point.id)}
          onChange={event => props.onChange((event.currentTarget as HTMLInputElement).checked
            ? [...props.selected, point.id] : props.selected.filter(id => id !== point.id))} />
        <span>{point.original}</span>
      </label>
    ))}
  </fieldset>
), { props: ['points', 'selected', 'disabled', 'onChange'] });

type LabelProps = { value: RoundLabels; disabled?: boolean; onChange: (value: RoundLabels) => void };
export const RoundLabelFields = defineComponent((props: LabelProps) => () => <>
  {groups.map(([key, legend, tags]) => {
    return <fieldset class="round-labels" key={key} disabled={props.disabled}>
      <legend>{legend}</legend>
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

export function accuratePointSummary(feedback: RoundFeedback, points: ReviewPoint[]) {
  const ids = feedback.accuratePointIds;
  if (ids == null) return null;
  const selected = points.filter(point => ids.includes(point.id));
  return selected.length ? selected.map(point => point.original).join('；') : '未勾选';
}

export function feedbackSummary(feedback: RoundFeedback, points: ReviewPoint[]) {
  const accurate = accuratePointSummary(feedback, points);
  return <div class="round-feedback-summary">
    {accurate !== null && <p>人工标注的准确复述要点：{accurate}</p>}
    <p>给复述者贴的标签：{feedback.retellTags.join('、') || '无标注'}</p>
    <p>表达者自我评价：{feedback.expressionTags.join('、') || '无标注'}</p>
    {feedback.note && <p>澄清：{feedback.note}</p>}
  </div>;
}
