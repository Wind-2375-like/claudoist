import type { Id, IsoDate, IsoTime, Timestamp } from './common';

export type TaskStatus = 'active' | 'done' | 'deleted';

/**
 * 容器(D-20,2026-08-09 定案):task 永远在一个可见容器里。
 * 'project' ⟺ projectId 非空;someday/reference 不参与 Today/engage。
 */
export type TaskBucket = 'inbox' | 'project' | 'someday' | 'reference';

/** 行动(CLI:Action)。字段语义见 INVARIANTS §2.3。 */
export interface Task {
  id: Id;
  title: string;
  /** 必填恰好一个 context(INV-24.2) */
  contextId: Id;
  estimatedMinutes: number;
  /** 写入侧限 Energy;读取侧宽容未知字符串按 medium 参与比较(INV-02) */
  energy: string;
  /** 1=最高 5=最低(INV-01/D-29);越界输入回退默认 3 */
  priority: number;
  projectId: Id | null;
  /** 创建时若项目有 deadline 则静默复制(INV-10) */
  deadline: IsoDate | null;
  status: TaskStatus;
  createdAt: Timestamp;
  completedAt: Timestamp | null;
  deletedAt: Timestamp | null;
  /** 桌面扩展(INVARIANTS §2.3):补充说明 */
  description: string;
  /** 桌面扩展(D-19):计划哪天做;不参与任何 CLI 不变量计算 */
  scheduledDate: IsoDate | null;
  /** 容器(D-20) */
  bucket: TaskBucket;
  /** 子任务(D-21/INV-25):非空 = 是该任务的子任务;链深 ≤5 层;子树 bucket/projectId 与根一致 */
  parentTaskId: Id | null;
  /** 手动排序(D-24/INV-27):同级组(同 bucket+projectId+parentTaskId)内按 sortOrder 升序、createdAt 兜底 */
  sortOrder: number;
  /**
   * 日历统一(D-23/M6a):当天开始时刻(HH:MM);null = 全天/无时间。
   * 带时间的任务即日历 block(取代 CalendarItem 实体);须与 scheduledDate 搭配才有意义。
   */
  startTime: IsoTime | null;
  /** 日历 block 时长(分钟,≥1);null = 用 estimatedMinutes 兜底(D-23/M6a) */
  durationMinutes: number | null;
  /**
   * 时区(D-27/INV-31,M6d):`null` = **浮动时间**(跨时区不变,Todoist 的 Floating time,
   * 也是本仓一贯的 naive 时刻语义,INV-03);否则为 IANA 时区名(如 `America/New_York`),
   * 表示该时刻钉在这个时区上、跨时区时墙上时间随之换算。
   */
  timeZone: string | null;
  /**
   * 外部日历镜像(D-25/INV-29,M6c-3a):非空 = 本任务由外部日历事件镜像而来。
   * 形如 `google:<账号邮箱>:<日历id>:<事件id>`,全局唯一,用于同步时 upsert。
   * **时间与标题由外部拥有**(本地改不了);状态/优先级/标签/评论/子任务本地自治,
   * 且**永不回写外部**。
   */
  externalId: string | null;
  /** 镜像来源日历 id(着色 / 随该日历显隐);externalId 为空时必为 null */
  externalCalendarId: Id | null;
  /**
   * 推送到专用 `Claudoist` 日历后的事件 id(D-26/INV-30,M6c-3b)。
   * 只对**本地任务**(externalId 为空)有意义;镜像任务永不回推。
   */
  pushedEventId: string | null;
  /** 上次推送出去的内容指纹(标题|日期|时刻|时长|完成);相同则跳过 API 调用 */
  pushedFingerprint: string | null;
}

/** 子任务嵌套上限(INV-25;根任务算第 1 层)。 */
export const MAX_SUBTASK_DEPTH = 5;

export const TASK_DEFAULTS = {
  estimatedMinutes: 15,
  energy: 'medium',
  priority: 3,
  description: '',
} as const;
