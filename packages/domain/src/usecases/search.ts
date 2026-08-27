import type { InboxItem } from '../entities/inboxItem';
import type { ListItem } from '../entities/listItem';
import type { Project } from '../entities/project';
import type { Task } from '../entities/task';
import type { WaitingFor } from '../entities/waitingFor';
import type { GtdSnapshot } from '../ports/gtdStore';
import type { FlowDeps } from '../flows/framework';
import type { UsecaseResult } from './types';

/** 跨实体搜索(只读;DESIGN §6.3 `search` 工具的领域实现)。 */

export interface SearchAllInput {
  query: string;
}

export interface SearchAllConsequences {
  /** 含 done/deleted(Trash/Completed 也可被搜到) */
  tasks: Task[];
  /** 含 complete */
  projects: Project[];
  inbox: InboxItem[];
  someday: ListItem[];
  reference: ListItem[];
  trash: ListItem[];
  waiting: WaitingFor[];
}

/** 大小写不敏感的包含匹配;命中字段:title/outcome/text/description+delegatedTo。 */
export function searchAll(
  snap: GtdSnapshot,
  _deps: FlowDeps,
  input: SearchAllInput,
): UsecaseResult<SearchAllConsequences> {
  const q = input.query.trim().toLowerCase();
  if (q === '') return { error: '查询不能为空' };
  const hit = (s: string): boolean => s.toLowerCase().includes(q);
  const listOf = (kind: ListItem['kind']): ListItem[] =>
    snap.listItems.filter((i) => i.kind === kind && hit(i.text));
  return {
    commands: [],
    consequences: {
      tasks: snap.tasks.filter((t) => hit(t.title)),
      projects: snap.projects.filter((p) => hit(p.outcome)),
      inbox: snap.inbox.filter((i) => hit(i.text)),
      someday: listOf('someday'),
      reference: listOf('reference'),
      trash: listOf('trash'),
      waiting: snap.waiting.filter((w) => hit(w.description) || hit(w.delegatedTo)),
    },
  };
}
