export type Mode = 'sync' | 'solo' | 'teen' | 'async';
export const isSameDevice = (mode: Mode) => mode === 'solo' || mode === 'teen';
export type Role = 'speaker' | 'listener' | 'observer';
export type Stage =
  | 'TASK'
  | 'SPEAKER_RECORDING'
  | 'KEYPOINT_CONFIRM'
  | 'ASYNC_PENDING'
  | 'LISTENER_RETELL'
  | 'COMPARING'
  | 'SPEAKER_LABELING'
  | 'MUTUAL_CONFIRM'
  | 'LISTENER_CLARIFICATION'
  | 'ADVICE'
  | 'ARCHIVED'
  | 'CANCELLED';

export interface Member {
  id: string;
  role: Role;
  active: boolean;
}

export interface ComparisonIssue {
  id: string;
  revision: number;
  tag: string | null;
  resolution: 'misunderstanding' | 'expression' | 'ai_error' | null;
  speakerConfirmedRevision: number | null;
  listenerConfirmedRevision: number | null;
}

export interface Round {
  terminalReason?: 'TIMEOUT' | 'COMPARISON_FAILED';
  adviceAccepted?: boolean;
  listenerAdviceAccepted?: boolean;
  id: string;
  roomId: string;
  mode: Mode;
  stage: Stage;
  version: number;
  deadlineAt: string | null;
  speakerId: string;
  listenerId: string;
  activeSeat: 'speaker' | 'listener';
  speakerAudioId: string | null;
  listenerAudioId: string | null;
  confirmedPointCount: number;
  issues: ComparisonIssue[];
}

export type Actor = { kind: 'member'; memberId: string } | { kind: 'system' };
export type Command =
  | { type: 'task-set' }
  | { type: 'recording-restarted'; kind: 'speaker' | 'listener' }
  | { type: 'speaker-submitted'; audioId: string }
  | { type: 'points-confirmed'; pointCount: number }
  | { type: 'async-opened' }
  | { type: 'listener-submitted'; audioId: string }
  | { type: 'comparison-ready'; issueIds: string[] }
  | { type: 'speaker-labeled'; labels: { issueId: string; tag: string; resolution: NonNullable<ComparisonIssue['resolution']> }[] }
  | { type: 'issue-revised'; issueId: string; tag: string; resolution: NonNullable<ComparisonIssue['resolution']> }
  | { type: 'issue-confirmed'; issueId: string }
  | { type: 'listener-clarified'; issueId: string; note: string }
  | { type: 'observer-annotated'; issueId: string; tag: string; note: string }
  | { type: 'seat-switched'; seat: 'speaker' | 'listener' }
  | { type: 'confirmations-submitted' }
  | { type: 'advice-accepted' }
  | { type: 'archived' }
  | { type: 'expired' };

export interface TransitionContext {
  members: readonly Member[];
  actor: Actor;
  expectedVersion: number;
  now: Date;
  speakerSeconds: number;
  listenerSeconds: number;
  asyncWaitSeconds: number;
}

export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function due(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

function memberRole(round: Round, context: TransitionContext): Role {
  if (context.actor.kind !== 'member') return fail('ACTOR_REQUIRED', 'Member identity required');
  const memberId = context.actor.memberId;
  const member = context.members.find(row => row.id === memberId && row.active);
  if (!member) return fail('NOT_MEMBER', 'Active room membership required');
  if (isSameDevice(round.mode) && member.id === round.speakerId && member.id === round.listenerId) return round.activeSeat;
  if (member.role === 'speaker' && member.id !== round.speakerId) return fail('ROLE_MISMATCH', 'Speaker seat mismatch');
  if (member.role === 'listener' && member.id !== round.listenerId) return fail('ROLE_MISMATCH', 'Listener seat mismatch');
  return member.role;
}

function requireRole(round: Round, context: TransitionContext, role: Role): void {
  if (memberRole(round, context) !== role) fail('FORBIDDEN_ROLE', `${role} role required`);
}

function requireStage(round: Round, stage: Stage): void {
  if (round.stage !== stage) fail('WRONG_STAGE', `Expected ${stage}, got ${round.stage}`);
}

function requireSystem(context: TransitionContext): void {
  if (context.actor.kind !== 'system') fail('SYSTEM_ONLY', 'Internal worker required');
}

function issueById(round: Round, issueId: string): ComparisonIssue {
  const issue = round.issues.find(row => row.id === issueId);
  if (!issue) return fail('UNKNOWN_ISSUE', 'Comparison item does not exist');
  return issue;
}

function clearConfirmation(issue: ComparisonIssue, tag: string, resolution: NonNullable<ComparisonIssue['resolution']>): ComparisonIssue {
  if (issue.tag === tag && issue.resolution === resolution) return issue;
  return { ...issue, revision: issue.revision + 1, tag, resolution, speakerConfirmedRevision: null, listenerConfirmedRevision: null };
}

export function newRound(input: Pick<Round, 'id' | 'roomId' | 'mode' | 'speakerId' | 'listenerId'>): Round {
  if (!input.id || !input.roomId || !input.speakerId || !input.listenerId) fail('INVALID_ROUND', 'Required identifiers missing');
  if (!isSameDevice(input.mode) && input.speakerId === input.listenerId) fail('INVALID_ROLES', 'Distinct members required');
  return { ...input, stage: 'TASK', version: 1, deadlineAt: null, activeSeat: 'speaker', speakerAudioId: null, listenerAudioId: null, confirmedPointCount: 0, issues: [] };
}

export function applyRoundCommand(round: Round, command: Command, context: TransitionContext): Round {
  if (round.version !== context.expectedVersion) fail('STALE_VERSION', 'Round state changed; fetch a fresh snapshot');
  if (round.stage === 'ARCHIVED' || round.stage === 'CANCELLED') fail('TERMINAL_ROUND', 'Create a new round');
  if (!Number.isFinite(context.now.getTime())) fail('INVALID_TIME', 'Valid server time required');
  let next: Round;
  switch (command.type) {
    case 'task-set':
      requireStage(round, 'TASK'); requireRole(round, context, 'speaker');
      next = { ...round, stage: 'SPEAKER_RECORDING', deadlineAt: due(context.now, context.speakerSeconds) };
      break;
    case 'recording-restarted': {
      const stage = command.kind === 'speaker' ? 'SPEAKER_RECORDING' : 'LISTENER_RETELL';
      requireStage(round, stage); requireRole(round, context, command.kind);
      if (command.kind === 'speaker' ? round.speakerAudioId : round.listenerAudioId) fail('AUDIO_ALREADY_COMMITTED', 'Committed recording cannot be restarted');
      next = { ...round, deadlineAt: due(context.now, command.kind === 'speaker' ? context.speakerSeconds : context.listenerSeconds) };
      break;
    }
    case 'speaker-submitted':
      requireStage(round, 'SPEAKER_RECORDING'); requireRole(round, context, 'speaker');
      if (!command.audioId) fail('AUDIO_REQUIRED', 'Committed audio required');
      next = { ...round, stage: 'KEYPOINT_CONFIRM', speakerAudioId: command.audioId, deadlineAt: null };
      break;
    case 'points-confirmed':
      requireStage(round, 'KEYPOINT_CONFIRM'); requireRole(round, context, 'speaker');
      if (!Number.isInteger(command.pointCount) || command.pointCount < 1) fail('POINTS_REQUIRED', 'At least one confirmed point required');
      next = { ...round, stage: round.mode === 'async' ? 'ASYNC_PENDING' : 'LISTENER_RETELL', activeSeat: isSameDevice(round.mode) ? 'listener' : round.activeSeat, confirmedPointCount: command.pointCount, deadlineAt: due(context.now, round.mode === 'async' ? context.asyncWaitSeconds : context.listenerSeconds) };
      break;
    case 'async-opened':
      requireStage(round, 'ASYNC_PENDING'); requireRole(round, context, 'listener');
      next = { ...round, stage: 'LISTENER_RETELL', deadlineAt: due(context.now, context.listenerSeconds) };
      break;
    case 'listener-submitted':
      requireStage(round, 'LISTENER_RETELL'); requireRole(round, context, 'listener');
      if (!command.audioId) fail('AUDIO_REQUIRED', 'Committed audio required');
      next = { ...round, stage: 'COMPARING', listenerAudioId: command.audioId, deadlineAt: due(context.now, 300) };
      break;
    case 'comparison-ready': {
      requireStage(round, 'COMPARING'); requireSystem(context);
      if (new Set(command.issueIds).size !== command.issueIds.length || command.issueIds.some(id => !id)) fail('INVALID_ISSUES', 'Issue IDs must be unique');
      next = { ...round, stage: 'SPEAKER_LABELING', deadlineAt: null, activeSeat: isSameDevice(round.mode) ? 'speaker' : round.activeSeat, issues: command.issueIds.map(id => ({ id, revision: 1, tag: null, resolution: null, speakerConfirmedRevision: null, listenerConfirmedRevision: null })) };
      break;
    }
    case 'speaker-labeled': {
      requireStage(round, 'SPEAKER_LABELING'); requireRole(round, context, 'speaker');
      if (command.labels.length !== round.issues.length || new Set(command.labels.map(row => row.issueId)).size !== round.issues.length) fail('LABELS_REQUIRED', 'Every issue needs one label');
      next = { ...round, stage: 'MUTUAL_CONFIRM', issues: round.issues.map(issue => {
        const label = command.labels.find(row => row.issueId === issue.id);
        if (!label || !label.tag) return fail('LABELS_REQUIRED', 'Every issue needs one label');
        return clearConfirmation(issue, label.tag, label.resolution);
      }) };
      break;
    }
    case 'issue-revised': {
      requireStage(round, 'MUTUAL_CONFIRM'); requireRole(round, context, 'speaker');
      if (!command.tag) fail('LABELS_REQUIRED', 'Label required');
      issueById(round, command.issueId);
      next = { ...round, issues: round.issues.map(issue => issue.id === command.issueId ? clearConfirmation(issue, command.tag, command.resolution) : issue) };
      break;
    }
    case 'issue-confirmed': {
      requireStage(round, 'MUTUAL_CONFIRM');
      const role = memberRole(round, context);
      if (role === 'observer') fail('FORBIDDEN_ROLE', 'Observer cannot confirm');
      const issue = issueById(round, command.issueId);
      if (!issue.tag || !issue.resolution) fail('UNLABELED_ISSUE', 'Issue must be labeled first');
      next = { ...round, issues: round.issues.map(row => row.id !== issue.id ? row : role === 'speaker' ? { ...row, speakerConfirmedRevision: row.revision } : { ...row, listenerConfirmedRevision: row.revision }) };
      break;
    }
    case 'listener-clarified': {
      requireStage(round, 'MUTUAL_CONFIRM');
      requireRole(round, context, 'listener');
      const issue = issueById(round, command.issueId);
      if (!issue.tag || !issue.resolution) fail('UNLABELED_ISSUE', 'Issue must be labeled first');
      // Text is stored encrypted by the repository, not in the round snapshot.
      next = { ...round, issues: round.issues.map(row => row.id === issue.id
        ? { ...row, revision: row.revision + 1, speakerConfirmedRevision: null, listenerConfirmedRevision: null } : row) };
      break;
    }
    case 'observer-annotated':
      if (round.stage !== 'SPEAKER_LABELING' && round.stage !== 'MUTUAL_CONFIRM') fail('WRONG_STAGE', 'Review must be open');
      requireRole(round, context, 'observer');
      issueById(round, command.issueId);
      next = round;
      break;
    case 'seat-switched':
      requireStage(round, 'MUTUAL_CONFIRM');
      if (!isSameDevice(round.mode) || context.actor.kind !== 'member' || context.actor.memberId !== round.speakerId) fail('FORBIDDEN_ROLE', 'Only the same-device participant may switch seats');
      if (!context.members.some(row => row.id === round.speakerId && row.active)) fail('NOT_MEMBER', 'Active room membership required');
      next = { ...round, activeSeat: command.seat };
      break;
    case 'confirmations-submitted':
      requireStage(round, 'MUTUAL_CONFIRM'); requireRole(round, context, 'speaker');
      if (round.issues.some(issue => issue.speakerConfirmedRevision !== issue.revision || issue.listenerConfirmedRevision !== issue.revision)) fail('UNCONFIRMED_ISSUES', 'Both roles must confirm every issue');
      next = { ...round, stage: 'ADVICE' };
      break;
    case 'advice-accepted': {
      requireStage(round, 'ADVICE');
      const role = memberRole(round, context);
      if (role === 'observer') fail('FORBIDDEN_ROLE', 'Observer cannot accept advice');
      next = role === 'speaker' ? { ...round, adviceAccepted: true } : { ...round, listenerAdviceAccepted: true };
      break;
    }
    case 'archived':
      requireStage(round, 'ADVICE'); requireRole(round, context, 'speaker');
      next = { ...round, stage: 'ARCHIVED', deadlineAt: null };
      break;
    case 'expired':
      requireSystem(context);
      if (!round.deadlineAt || context.now.getTime() < Date.parse(round.deadlineAt)) fail('NOT_DUE', 'Deadline has not passed');
      next = { ...round, stage: 'CANCELLED', deadlineAt: null, terminalReason: round.stage === 'COMPARING' ? 'COMPARISON_FAILED' : 'TIMEOUT' };
      break;
  }
  return { ...next, version: round.version + 1 };
}
