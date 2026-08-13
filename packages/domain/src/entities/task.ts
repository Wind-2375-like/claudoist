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
  /**
   * 循环(D-37/INV-36):null = 不循环。**必填不可省** —— 写成 `repeat?:` 的话,
   * 7 处构造完整 Task 字面量的地方漏了它 tsc 不会报,循环会静默丢失。
   */
  repeat: RepeatRule | null;
  /**
   * 循环系列身份:同一系列的每一次共享(完成史分组、"该系列已有一条 active"守卫都靠它)。
   * 关闭 repeat **不清**它 —— 完成史仍按系列归堆(INV-36.9)。
   */
  seriesId: Id | null;
}

export type RepeatUnit = 'day' | 'week' | 'month' | 'year';
/** 从哪天往后推:'scheduled' = 原计划日(逾期会追赶到未来);'completed' = 实际完成日(永不追赶) */
export type RepeatFrom = 'scheduled' | 'completed';

/**
 * 循环规则(D-37/INV-36)。**整体是一个值**:要么 `Task.repeat` 为 null(不循环),要么
 * 六个字段全部有意义 —— 由迁移 v18 的跨列 CHECK 在 schema 层钉死,patch 时必须整体替换,
 * 不能只改其中一个字段(改一半会撞 CHECK 整批回滚,这是刻意选的响亮失败方向)。
 *
 * 存结构化字段而不是 RRULE 串:RRULE 表达不了 "Based on: Completed date",它的 UNTIL
 * 是 UTC DATETIME(与 INV-03 的本地 naive 日期冲突),且解析失败的后果是任务**静默不推进**
 * —— 承诺不能挂在运行时解析上。
 */
export interface RepeatRule {
  /** Every N;1..999 */
  every: number;
  unit: RepeatUnit;
  from: RepeatFrom;
  /**
   * 星期集合位掩码:bit i = 星期 i,**0=周日 … 6=周六**(与 epoch-day 星期算子同序,
   * 少一次转换 = 少一个静默 off-by-one)。1..127,0 非法。
   * 不变式(INV-36.2):`unit==='week'` ⟺ `weekdays !== null`。
   * 例:每周三 = 0b0001000 = 8;Mon–Fri = 0b0111110 = 62。
   */
  weekdays: number | null;
  /** Ends:null = 永不;否则 = 结束日,**含当日**(inclusive) */
  until: IsoDate | null;
  /**
   * **原始锚点日 —— 月末/闰日不漂移的全部秘密**。推进永远是"从 anchor 加 k 个周期再夹取
   * 月末",绝不是"从上次结果加一个周期"(后者会让锚 1/31 的规则在 2 月之后永久烂在 28 号)。
   * 只在**人**写 scheduledDate 时重置;推进引擎永不碰它(INV-36.3)。
   */
  anchor: IsoDate;
}

/** 子任务嵌套上限(INV-25;根任务算第 1 层)。 */
export const MAX_SUBTASK_DEPTH = 5;

export const TASK_DEFAULTS = {
  estimatedMinutes: 15,
  energy: 'medium',
  priority: 3,
  description: '',
} as const;
