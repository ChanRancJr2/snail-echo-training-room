import type { Mode, Role, Stage } from '../../../packages/core/src/round.ts';

export const modes: readonly [Mode, string, string][] = [
  ['sync', '双人同步练', '两台手机，一人表达，一人复述'],
  ['solo', '双座位自练', '一个人交棒练习倾听与表达'],
  ['teen', '亲子同机练', '家长和孩子轮流使用同一台手机'],
  ['async', '异步留言练', '先留下表达，搭档稍后再复述'],
];

const practiceMode = ['practice', '单人练习', '选择录音主题，听完后用自己的话复述'] as const;
export const availableModes = [practiceMode, modes[3]!, modes[0]!, modes[1]!, modes[2]!];
export const roundTopics = ['家庭日常', '校园生活', '疾病与需求', '工作需求', '兴趣爱好', '自定义填写'] as const;

const steps = [
  ['先定这轮任务', '定任务'], ['先说出你的想法', '表达录音'], ['你真正想说的重点', '确认重点'],
  ['先听，再用自己的话说', '复述者复述'], ['先看差异', '系统对照'], ['请表达者逐条标注', '表达者标注'],
  ['把误解逐条聊清楚', '双方确认'], ['收下一条建议', '改写建议'], ['本轮报告', '归档报告'],
] as const;

const compactReviewSteps = [
  ['先定这轮任务', '定任务'], ['先说出你的想法', '表达录音'], ['你真正想说的重点', '确认重点'],
  ['先听，再用自己的话说', '复述者复述'], ['先看差异', '系统对照'], ['请逐条标注', '表达者标注'],
  ['收下一条建议', '改写建议'], ['本轮报告', '归档报告'],
] as const;

const stepByStage: Record<Stage, number> = {
  TASK: 1, SPEAKER_RECORDING: 2, KEYPOINT_CONFIRM: 3, ASYNC_PENDING: 4, LISTENER_RETELL: 4,
  COMPARING: 5, SPEAKER_LABELING: 5, MUTUAL_CONFIRM: 7, LISTENER_CLARIFICATION: 6, ADVICE: 8, ARCHIVED: 9, CANCELLED: 0,
};

export function roundStep(stage: Stage, { recording = false, labeling = false, compactReview = false,
  wholeReview = false, role = 'speaker' as Role } = {}) {
  const compact = compactReview || wholeReview;
  const activeSteps = compact ? compactReviewSteps : steps;
  let number = stage === 'TASK' && recording ? 2 : stage === 'SPEAKER_LABELING' && labeling ? 6 : stepByStage[stage];
  if (compact && stage === 'MUTUAL_CONFIRM') number = 6;
  if (compact && stage === 'ADVICE') number = 7;
  if (compact && stage === 'ARCHIVED') number = 8;
  if (wholeReview && number === 6) {
    if (role === 'listener') return { number, title: '复述者澄清', label: '复述者澄清', count: activeSteps.length };
    if (role === 'observer') return { number, title: '查看本轮回顾', label: '本轮回顾', count: activeSteps.length };
    return { number, title: '表达者整轮标注', label: '整轮标注', count: activeSteps.length };
  }
  const step = activeSteps[number - 1];
  const title = stage === 'COMPARING' ? '正在生成对照' : stage === 'ASYNC_PENDING' ? '异步留言' : step?.[0];
  return step ? { number, title, label: step[1], count: activeSteps.length } : null;
}

export function nextPractice(complete: number, total: number) {
  const coverage = total ? complete / total : 0;
  if (coverage >= 0.85) return '下一轮可以延长发言，试着加入一处情绪或隐含意图。';
  if (coverage < 0.6) return '下一轮可以缩短发言，只保留一两个要点。';
  return '下一轮保持当前时长，复述后请对方确认关键条件。';
}
