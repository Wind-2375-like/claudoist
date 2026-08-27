import { useState } from 'react';
import type { ProjectListItemVM } from '../../shared/viewModels';

/**
 * 项目新建 / 编辑对话框(D-21)。编辑改 deadline 时按 §5.4 单次调用模型:
 * 先读继承行动计数并一次性征询,确认才带 propagateDeadline。
 */
export function ProjectModal({
  project,
  onClose,
}: {
  /** 缺省 = 新建 */
  project?: ProjectListItemVM;
  onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(project?.name ?? '');
  const [deadline, setDeadline] = useState(project?.deadline ?? '');
  const [error, setError] = useState('');

  const submit = async (): Promise<void> => {
    setError('');
    const outcome = name.trim();
    if (!outcome) {
      setError('项目名不能为空');
      return;
    }
    if (!project) {
      const r = await window.gtd.projectAdd({ outcome, ...(deadline ? { deadline } : {}) });
      if ('error' in r) {
        setError(r.error);
        return;
      }
      onClose();
      return;
    }
    const patch: { outcome?: string; deadline?: string | null } = {};
    if (outcome !== project.name) patch.outcome = outcome;
    const newDeadline = deadline || null;
    let propagate = false;
    if (newDeadline !== project.deadline) {
      patch.deadline = newDeadline;
      // INV-12:一次性征询"同步更新 N 个行动?",绝不静默级联
      const n = await window.gtd.projectInheritCount(project.id);
      if (n > 0) {
        propagate = window.confirm(
          `有 ${n} 个行动的 deadline 与项目旧值相同。同步更新它们的 deadline?\n(取消 = 只改项目自己)`,
        );
      }
    }
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    const r = await window.gtd.projectUpdate({
      id: project.id,
      patch,
      ...(propagate ? { propagateDeadline: true } : {}),
    });
    if ('error' in r) {
      setError(r.error);
      return;
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-28">
      <div className="w-[440px] max-w-[92vw] rounded-xl border border-neutral-200 bg-white p-4 shadow-2xl">
        <h2 className="mb-3 text-sm font-semibold">{project ? '编辑项目' : '新建项目'}</h2>
        <input
          autoFocus
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-blue-400"
          placeholder="项目名(期望成果)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <label className="text-xs text-neutral-500">Deadline</label>
          <input
            placeholder="YYYY-MM-DD"
            className="w-28 rounded border border-neutral-300 px-2 py-1 text-xs outline-none focus:border-blue-400"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
          />
          {deadline && (
            <button
              type="button"
              className="text-xs text-neutral-400"
              onClick={() => setDeadline('')}
            >
              清除
            </button>
          )}
          <span className="text-[11px] text-neutral-400">
            项目 deadline 会流向其中的行动(INV-10)
          </span>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700"
          >
            {project ? '保存' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
