import type { Id } from '../entities/common';
import type { GtdSnapshot } from '../ports/gtdStore';

/**
 * D-21 平面化:项目不再有层级。保留 projectBreadcrumb 名称以稳住调用面 ——
 * 现在它就是项目名(outcome);项目不存在时返回空串。
 */
export function projectBreadcrumb(snap: GtdSnapshot, projectId: Id): string {
  return snap.projects.find((p) => p.id === projectId)?.outcome ?? '';
}
