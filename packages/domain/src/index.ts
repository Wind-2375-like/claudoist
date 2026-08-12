/**
 * @gtd/domain — 纯 TypeScript 领域核心(零框架依赖)。
 * 规则权威:docs/INVARIANTS.md;架构:docs/DESIGN.md §3。
 */

export * from './entities/common';
export * from './entities/task';
export * from './entities/project';
export * from './entities/waitingFor';
export * from './entities/inboxItem';
export * from './entities/listItem';
export * from './entities/label';
export * from './entities/filter';
export * from './entities/reminder';
export * from './entities/taskComment';

export * from './ports/clock';
export * from './ports/idGen';
export * from './ports/gtdStore';

export * from './rules/calendarGrid';
export * from './rules/dates';
export * from './rules/externalMirror';
export * from './rules/energy';
export * from './rules/filterQuery';
export * from './rules/priority';
export * from './rules/projectDeletion';
export * from './rules/projectHealth';
export * from './rules/projectTree';
export * from './rules/projectStats';
export * from './rules/subtasks';
export * from './rules/taskView';
export * from './rules/deadlineInheritance';
export * from './rules/engageRanking';
export * from './rules/followUpTemplate';

export * from './flows/framework';

export * from './usecases/types';
export * from './usecases/capture';
export * from './usecases/externalSync';
export * from './usecases/pushSync';
export * from './usecases/tasks';
export * from './usecases/projects';
export * from './usecases/waiting';
export * from './usecases/lists';
export * from './usecases/labels';
export * from './usecases/reminders';
export * from './usecases/filters';
export * from './usecases/search';
export * from './usecases/status';
export * from './usecases/comments';
export * from './usecases/clarifyDirect';

export * from './testing/storeContract';
