import type {
  Clock,
  FlowDeps,
  GtdSnapshot,
  IdGen,
  InboxItem,
  Label,
  Project,
  Task,
  WaitingFor,
} from '../src/index';
import { emptySnapshot } from '../src/index';

/** 测试基准"今天"(与 fakeClock 默认同日) */
export const TODAY = '2026-08-08';

export function fakeClock(now = '2026-08-08T12:00:00', today = TODAY): Clock {
  return { now: () => now, today: () => today };
}

export function seqIdGen(prefix = 'id'): IdGen {
  let n = 0;
  return { next: () => `${prefix}-${++n}` };
}

export function deps(): FlowDeps {
  return { idGen: seqIdGen(), clock: fakeClock() };
}

let fixtureSeq = 0;
const fid = (): string => `fx-${++fixtureSeq}`;

export function task(over: Partial<Task> = {}): Task {
  return {
    id: fid(),
    title: `task ${fixtureSeq}`,
    estimatedMinutes: 15,
    energy: 'medium',
    priority: 3,
    projectId: null,
    deadline: null,
    status: 'active',
    createdAt: '2026-08-01T00:00:00',
    completedAt: null,
    deletedAt: null,
    description: '',
    scheduledDate: null,
    // D-20 智能默认:有 projectId → 'project',否则 'inbox'
    bucket: over.projectId != null ? 'project' : 'inbox',
    parentTaskId: null,
    sortOrder: 0,
    startTime: null,
    durationMinutes: null,
    externalId: null,
    externalCalendarId: null,
    pushedEventId: null,
    pushedFingerprint: null,
    repeat: null,
    seriesId: null,
    dayOrder: null,
    timeZone: null,
    ...over,
  };
}

export function label(over: Partial<Label> = {}): Label {
  return { id: fid(), name: `label${fixtureSeq}`, color: null, ...over };
}

export function project(over: Partial<Project> = {}): Project {
  return {
    id: fid(),
    outcome: `project ${fixtureSeq}`,
    deadline: null,
    status: 'active',
    createdAt: '2026-08-01T00:00:00',
    completedAt: null,
    deletedAt: null,
    sortOrder: 0,
    ...over,
  };
}

export function waitingFor(over: Partial<WaitingFor> = {}): WaitingFor {
  return {
    id: fid(),
    description: `waiting ${fixtureSeq}`,
    delegatedTo: 'someone',
    projectId: null,
    delegatedAt: '2026-08-01T00:00:00',
    resolved: false,
    resolvedAt: null,
    sourceTaskJson: null,
    ...over,
  };
}

export function inboxItem(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: fid(),
    text: `thought ${fixtureSeq}`,
    createdAt: '2026-08-01T00:00:00',
    position: fixtureSeq,
    ...over,
  };
}

export function snapshot(over: Partial<GtdSnapshot> = {}): GtdSnapshot {
  return { ...emptySnapshot(), ...over };
}
