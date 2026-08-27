import { watch } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * 外部写入实时刷新(DESIGN §6.7):CLI 等外部进程写同一 DB 时,
 * watch data 目录(覆盖 gtd.sqlite3 / -wal / -shm),300ms 防抖后通知渲染层刷新。
 * main 自己的写入也会触发 —— 只是多一次幂等 refetch,可接受;失败静默(尽力而为)。
 */
export function watchDbForExternalWrites(onChange: () => void): void {
  const dir = join(app.getPath('userData'), 'data');
  let timer: NodeJS.Timeout | null = null;
  try {
    watch(dir, (_event, filename) => {
      if (typeof filename === 'string' && !filename.startsWith('gtd.sqlite3')) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, 300);
    });
  } catch {
    // 目录不存在等边缘情况:放弃监听,不影响 App 本身
  }
}
