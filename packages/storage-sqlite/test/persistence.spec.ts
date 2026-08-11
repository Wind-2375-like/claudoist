import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyToSnapshot, emptySnapshot, type Command } from '@gtd/domain';
import { openDb } from '../src/db';
import { SqliteGtdStore } from '../src/store';

describe('文件持久化', () => {
  it('WAL 模式生效;关闭重开后快照完好', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claudoist-test-'));
    const path = join(dir, 'gtd.sqlite3');
    try {
      const db1 = openDb(path);
      expect(
        (db1.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
      ).toBe('wal');
      const commands: Command[] = [
        {
          kind: 'createTask',
          task: {
            id: 't1',
            title: '持久化验证',
            estimatedMinutes: 15,
            energy: 'medium',
            priority: 3,
            projectId: null,
            deadline: null,
            status: 'active',
            createdAt: 't',
            completedAt: null,
            deletedAt: null,
            description: '',
            scheduledDate: null,
            bucket: 'inbox',
            parentTaskId: null,
            sortOrder: 0,
            startTime: null,
            durationMinutes: null,
            externalId: null,
            externalCalendarId: null,
            pushedEventId: null,
            pushedFingerprint: null,
            timeZone: null,
          },
        },
      ];
      new SqliteGtdStore(db1).apply(commands, 'user');
      db1.close();

      const db2 = openDb(path);
      const snap = new SqliteGtdStore(db2).snapshot();
      expect(snap).toEqual(applyToSnapshot(emptySnapshot(), commands));
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
