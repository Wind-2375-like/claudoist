import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ReadToolDeps } from './readTools';
import * as R from './readTools';
import type { WriteToolDeps } from './writeTools';
import * as W from './writeTools';
import { timeContext } from './timeContext';

/**
 * in-process MCP 工具面。M8 只读,M9 起加写工具。
 *
 * 工具名最终形如 `mcp__gtd__list_inbox`。handler 直连 main 的同一个 `GtdStore`,
 * 所以 agent 看到的永远是当前库状态,不存在缓存不一致。
 *
 * **为什么工具切得这么细**:每个工具都是一次 domain 调用的薄包装,读起来像
 * "这次调用用了哪条规则"。反过来,一个万能的 `query_tasks(conditions...)` 会
 * 诱使实现方在这一层重写过滤 —— 那正是 INV-20.6 / INV-32.6 / INV-33.9 三条
 * "单一口径"纪律要防的事(桌面与 CLI 曾各写一遍,结果计数与列表对不上)。
 *
 * **工具定义、权限分级与用户手册同源**:下面的 `SPECS` 同时用来注册工具、
 * 判定权限类别(`kind`/`destructive`),以及渲染 Skills 页里的"工具参考"
 * (`toolManual()`)。三者若各写一份,迟早对不上 —— 而权限那份对不上是安全问题:
 * 少标一个 destructive,`delete_task` 就在 Auto 模式下直通了。
 */

const json = (v: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(v) }],
});

export const GTD_MCP_SERVER_NAME = 'gtd';

export const qualifiedToolName = (n: string): string => `mcp__${GTD_MCP_SERVER_NAME}__${n}`;

/** 短名(`mcp__gtd__x` → `x`);非本服务器的工具原样返回。 */
export const shortToolName = (n: string): string => n.replace(/^mcp__gtd__/, '');

export interface ToolDeps extends ReadToolDeps {
  /** 缺省 = 只读会话:写工具根本不注册 */
  write?: WriteToolDeps;
}

interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  /** write 工具只在提供了 `write` deps 时注册 */
  kind: 'read' | 'write';
  /**
   * 破坏性:会丢数据或造成难以复原的连锁。即便在"自动"模式也必须弹审批(M9)。
   * 注意 `complete_task` **不是**静态破坏性 —— 它是否级联取决于目标有没有活跃子任务,
   * 由宿主在运行期按快照升级(见 desktop/agent/permissionPolicy.ts)。
   */
  destructive?: boolean;
  run: (deps: ToolDeps, args: Record<string, never>) => unknown;
}

const w = (deps: ToolDeps): WriteToolDeps => {
  // 只读会话里写工具不会被注册,走到这里说明宿主漏接了 deps
  if (!deps.write) throw new Error('当前会话为只读,写工具不可用');
  return deps.write;
};

const s = (a: Record<string, never>, k: string): string => a[k] as unknown as string;
const opt = <T>(a: Record<string, never>, k: string): T | undefined =>
  a[k] as unknown as T | undefined;

/**
 * 循环规则入参(D-37/INV-36)。**语义提示都写在 describe 里** —— agent 只看得到这些字:
 * - 用户说"做完之后 / 隔 N 天再 / 从上次算起" → from:'completed';说具体星期或号数 →
 *   'scheduled';拿不准选 'scheduled'。
 * - `{unit:'week', weekdays:['we']}` 与 `{unit:'day', every:7}` 不是一回事:前者被推迟到
 *   周五完成后下一次仍回周三,后者会跟着漂。
 */
const REPEAT = z
  .object({
    unit: z.enum(['day', 'week', 'month', 'year']).describe('单位;月/年的几号几月取自计划日'),
    every: z.number().int().min(1).max(999).optional().describe('每几个单位,默认 1'),
    weekdays: z
      .array(z.enum(['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su']))
      .optional()
      .describe('仅 unit=week:每周哪几天;不给 = 计划日那天。每 N 周(N≥2)时只能是计划日那天'),
    from: z
      .enum(['scheduled', 'completed'])
      .optional()
      .describe('从哪天往后推:scheduled=原计划日(逾期会追赶,默认)/ completed=实际完成日(不追赶)'),
    until: z.string().optional().describe('结束日 YYYY-MM-DD,含当天;不给 = 永不结束'),
  })
  .describe('循环规则;必须与 scheduledDate 搭配');

// 写工具共用的可选任务属性(create_task / add_subtask 同形)
const TASK_ATTRS = {
  description: z.string().optional().describe('补充说明'),
  labels: z.array(z.string()).optional().describe('标签名数组(可带 @);必须已存在'),
  deadline: z.string().optional().describe('截止日 YYYY-MM-DD(硬约束,过了就晚了)'),
  scheduledDate: z.string().optional().describe('计划哪天做 YYYY-MM-DD(软安排,可推迟)'),
  startTime: z.string().optional().describe('开始时刻 HH:MM;与 scheduledDate 合成日历 block'),
  durationMinutes: z.number().int().min(1).max(1440).optional().describe('日历 block 时长'),
  estimatedMinutes: z.number().int().min(1).max(1440).optional().describe('预计耗时,默认 15'),
  energy: z.enum(['low', 'medium', 'high']).optional().describe('所需精力,默认 medium'),
  priority: z.number().int().min(1).max(5).optional().describe('优先级 5=最高 1=最低,默认 3'),
  reminderAt: z.string().optional().describe('提醒时刻 YYYY-MM-DDTHH:MM'),
  timeZone: z.string().optional().describe('IANA 时区名;不给 = 浮动时间'),
};

const taskArgs = (a: Record<string, never>): W.CreateTaskArgs => ({
  title: s(a, 'title'),
  ...(a as unknown as Omit<W.CreateTaskArgs, 'title'>),
});

/** 一次定义,三处使用:注册工具 + 权限分级 + 渲染手册。 */
const SPECS: ToolSpec[] = [
  // ---------------------------------------------------------------- 只读
  {
    name: 'get_now',
    kind: 'read',
    description:
      '当前时刻、星期、时区与地区。长会话里时间会漂移 —— 需要精确判断"还有多久""来不来得及"时重新校一次',
    schema: {},
    run: () => timeContext(),
  },
  {
    name: 'list_inbox',
    kind: 'read',
    description: 'Inbox 里待理清的任务(不含来自外部日历的镜像任务)',
    schema: {},
    run: (d) => R.listInbox(d),
  },
  {
    name: 'list_bucket',
    kind: 'read',
    description: 'Someday/Maybe 或 Reference 容器里的任务(孵化中,不进 Today 与择事)',
    schema: { kind: z.enum(['someday', 'reference']).describe('要看哪个容器') },
    run: (d, a) => R.listBucket(d, s(a, 'kind') as 'someday' | 'reference'),
  },
  {
    name: 'list_today',
    kind: 'read',
    description:
      '今天该做的:计划日 ≤ 今天,加上已过截止但从未排期的。计划到未来的不在此列(那是用户显式推迟)',
    schema: {},
    run: (d) => R.listToday(d),
  },
  {
    name: 'list_calendar',
    kind: 'read',
    description: '日历区间。带 startTime 的任务即日历 block;全天与定时分开返回',
    schema: {
      fromDate: z.string().describe('起始日期 YYYY-MM-DD'),
      days: z.number().int().min(1).max(31).default(7).describe('天数,1–31'),
    },
    run: (d, a) => R.listCalendar(d, s(a, 'fromDate'), opt<number>(a, 'days') ?? 7),
  },
  {
    name: 'list_projects',
    kind: 'read',
    description: '活跃项目 + 完成度 + 是否还有 active next action(hasActiveNextAction)',
    schema: {},
    run: (d) => R.listProjects(d),
  },
  {
    name: 'get_project',
    kind: 'read',
    description: '单个项目及其根任务',
    schema: { projectId: z.string().describe('项目 id 或名称') },
    run: (d, a) => R.getProject(d, s(a, 'projectId')),
  },
  {
    name: 'get_task_detail',
    kind: 'read',
    description:
      '任务详情:子任务树、评论、活跃后代数。**完成或删除一个任务前先调它** —— 完成/删除会向下级联整棵活跃子树,而级联数量只有事后才返回',
    schema: { taskId: z.string().describe('任务 id') },
    run: (d, a) => R.getTaskDetail(d, s(a, 'taskId')),
  },
  {
    name: 'list_labels',
    kind: 'read',
    description: '全部标签 + 各自的活跃任务数(情境已并入标签)',
    schema: {},
    run: (d) => R.listLabels(d),
  },
  {
    name: 'list_filters',
    kind: 'read',
    description: '用户保存的过滤器(名称 + 查询原文)',
    schema: {},
    run: (d) => R.listFilters(d),
  },
  {
    name: 'list_waiting_for',
    kind: 'read',
    description: '未解决的等待项(委派出去、还没回音的事)',
    schema: {},
    run: (d) => R.listWaitingFor(d),
  },
  {
    name: 'search',
    kind: 'read',
    description:
      '按关键词搜任务标题/描述与项目名。大小写不敏感子串。**软删除的任务搜不到** —— 搜不到不等于不存在,必要时提醒用户可能在回收站',
    schema: {
      query: z.string().describe('关键词'),
      limit: z.number().int().min(1).max(200).optional().describe('每类上限,默认 50'),
    },
    run: (d, a) => R.search(d, s(a, 'query'), opt<number>(a, 'limit')),
  },
  {
    name: 'run_filter',
    kind: 'read',
    description: [
      '按过滤器查询语言求值 —— **这是唯一的条件查询入口**。凡是"某标签下""某优先级以上"',
      '"这周到期"之类的问题都用它,不要自己拉全表再筛。语法:',
      '@标签 · #项目 · p5(⚠ p5=最高,与 Todoist 的 p1=最高相反)· p>=4 ·',
      'today/tomorrow/overdue/no date/next 7 days(**均指计划日**)·',
      'deadline: today / deadline before: +7 days / no deadline(**截止日只能这样写**)·',
      'energy: low · est: 30 · inbox/someday/reference · bucket: project ·',
      'done / status: active,done / status: any · search:/title:/desc: 词 ·',
      'no labels / no project / no time · subtask · mirrored · recurring(循环任务)· & | ! ( ) · 顶层逗号 = 并列两段。',
      '默认只看活跃任务;写了状态但没提 deleted 时仍排除软删。',
      '引用了不存在的标签/项目不会报错,而是返回空结果 + unknownLabels/unknownProjects ——',
      '那说明条件恒不成立,不要当作"没有这样的任务"。',
    ].join(' '),
    schema: { query: z.string().describe('查询原文,如 deadline before: +7 days & no date') },
    run: (d, a) => R.runFilter(d, s(a, 'query')),
  },
  {
    name: 'get_engage_recommendations',
    kind: 'read',
    description: [
      '择事推荐(GTD 四标准:情境→时间→精力→优先级)。先给今天已排期的硬性日程',
      '(calendarFirst,与标签无关),再给候选前 7 条。**只读** —— 完成任务是独立的写操作。',
    ].join(' '),
    schema: {
      labelName: z.string().optional().describe('标签名,可带或不带 @;不传 = 不按标签过滤'),
      availableMinutes: z.number().int().min(1).default(60).describe('可用分钟数'),
      energy: z.enum(['low', 'medium', 'high']).default('medium').describe('当前精力'),
    },
    run: (d, a) =>
      R.engageRecommendations(
        d,
        opt<string>(a, 'labelName'),
        opt<number>(a, 'availableMinutes') ?? 60,
        opt<'low' | 'medium' | 'high'>(a, 'energy') ?? 'medium',
      ),
  },

  // ---------------------------------------------------------------- 写入
  {
    name: 'capture',
    kind: 'write',
    description:
      '把一批想法原样丢进 Inbox(INV-16 捕捉零判断:不解析、不加属性、不去重)。理清是后面单独一步',
    schema: { texts: z.array(z.string()).min(1).describe('每条一行,原文保存') },
    run: (d, a) => W.capture(w(d), a['texts'] as unknown as string[]),
  },
  {
    name: 'create_task',
    kind: 'write',
    description:
      '新建任务。不给 project 就落 Inbox。挂到有 deadline 的项目时会**静默继承**项目 deadline(INV-10),返回的 inheritedDeadline 要告诉用户。Someday/Reference 不能直接建 —— 先建再 move_task。repeat 须与 scheduledDate 搭配(循环挂在计划日上)',
    schema: {
      title: z.string().min(1).describe('任务标题'),
      project: z.string().optional().describe('项目 id 或名称;不给 = Inbox'),
      ...TASK_ATTRS,
      repeat: REPEAT.optional(),
    },
    run: (d, a) => W.createTask(w(d), taskArgs(a)),
  },
  {
    name: 'add_subtask',
    kind: 'write',
    description: '给已有任务加子任务(最多嵌套 5 层,INV-25)。子任务继承父的容器/项目,不能另指定',
    schema: {
      parentTaskId: z.string().describe('父任务 id'),
      title: z.string().min(1).describe('子任务标题'),
      ...TASK_ATTRS,
    },
    run: (d, a) => W.addSubtaskTool(w(d), { ...taskArgs(a), parentTaskId: s(a, 'parentTaskId') }),
  },
  {
    name: 'create_project',
    kind: 'write',
    description:
      '新建项目(GTD 定义:需要多步才能完成的结果)。outcome 写成**已完成的结果**而不是动作',
    schema: {
      outcome: z.string().min(1).describe('期望结果,如「新护照拿到手」'),
      deadline: z.string().optional().describe('截止日 YYYY-MM-DD;之后建的任务会继承'),
    },
    run: (d, a) =>
      W.createProject(w(d), { outcome: s(a, 'outcome'), deadline: opt(a, 'deadline') }),
  },
  {
    name: 'update_task',
    kind: 'write',
    description:
      '改任务属性。日期类字段传 null = 清除。**改不了容器/项目/父任务**(那要用 move_task),也改不了状态(用 complete/reopen/delete)。来自外部日历的镜像任务拒绝改标题与时间(INV-29)。' +
      '**用户说"这个循环我不做了/停掉它"时,要的是这里的 repeat:null,不是 complete_task**(完成反而会生成下一次);连这一次也不做才是 delete_task。' +
      'repeat 与 scheduledDate 是一对:设 repeat 必须已有计划日;清计划日而循环还在会被拒。改 scheduledDate 只挪这一次并重置锚点,不改规则本身',
    schema: {
      taskId: z.string().describe('任务 id'),
      title: z.string().optional(),
      description: z.string().optional(),
      deadline: z.string().nullable().optional().describe('YYYY-MM-DD 或 null 清除'),
      scheduledDate: z.string().nullable().optional().describe('YYYY-MM-DD 或 null 清除'),
      startTime: z.string().nullable().optional().describe('HH:MM 或 null(变全天)'),
      durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
      estimatedMinutes: z.number().int().min(1).max(1440).optional(),
      energy: z.enum(['low', 'medium', 'high']).optional(),
      priority: z.number().int().min(1).max(5).optional().describe('5=最高'),
      timeZone: z.string().nullable().optional(),
      repeat: REPEAT.nullable()
        .optional()
        .describe('三态:省略=不动 / null=关闭循环 / 对象=整条替换'),
    },
    run: (d, a) => W.updateTaskTool(w(d), a as unknown as W.UpdateTaskArgs),
  },
  {
    name: 'move_task',
    kind: 'write',
    description:
      '把任务挪到别的容器。挪进有 deadline 的项目且任务本身没 deadline → 静默继承(inheritedDeadline);挪动子任务会让它**脱离父任务**(detachedFromParent)。两者都必须转告用户',
    schema: {
      taskId: z.string().describe('任务 id'),
      to: z.enum(['inbox', 'someday', 'reference', 'project']).describe('目标容器'),
      project: z.string().optional().describe('to=project 时必填:项目 id 或名称'),
    },
    run: (d, a) =>
      W.moveTaskTool(w(d), {
        taskId: s(a, 'taskId'),
        to: s(a, 'to') as 'inbox' | 'someday' | 'reference' | 'project',
        project: opt(a, 'project'),
      }),
  },
  {
    name: 'set_task_labels',
    kind: 'write',
    description: '覆盖式设置任务的标签集合(传空数组 = 清空)。标签必须已存在',
    schema: {
      taskId: z.string().describe('任务 id'),
      labels: z.array(z.string()).describe('最终标签名数组,可带 @'),
    },
    run: (d, a) =>
      W.setLabels(w(d), { taskId: s(a, 'taskId'), labels: a['labels'] as unknown as string[] }),
  },
  {
    name: 'update_project',
    kind: 'write',
    description:
      '改项目名或 deadline。改 deadline 会返回 tasksWithInheritedDeadline(旧值与项目相同的行动)—— **默认不传播**;要一起改必须先问用户,再带 propagateDeadline: true 重调一次(INV-12)',
    schema: {
      project: z.string().describe('项目 id 或名称'),
      outcome: z.string().optional().describe('新的结果描述'),
      deadline: z.string().nullable().optional().describe('YYYY-MM-DD 或 null 清除'),
      propagateDeadline: z.boolean().optional().describe('true = 连带更新继承了旧 deadline 的行动'),
    },
    run: (d, a) =>
      W.updateProjectTool(w(d), {
        project: s(a, 'project'),
        outcome: opt(a, 'outcome'),
        deadline: opt(a, 'deadline'),
        propagateDeadline: opt(a, 'propagateDeadline'),
      }),
  },
  {
    name: 'complete_task',
    kind: 'write',
    description:
      '完成任务。**会向下级联完成整棵活跃子树**(INV-26.1),数量只在返回值 completedSubtaskCount 里 —— 所以有子任务时先 get_task_detail 看清楚、问过用户再调。返回 parentCompletionCandidate 时说明项目已无余活动:**征询**用户要不要一并完成项目,绝不自动完成(INV-15)。' +
      '目标带循环规则时,完成**不会让它消失**:当前这条置 done,并在同一事务里新建下一次(返回 nextOccurrence.{taskId,scheduledDate,copiedSubtaskCount},或 repeatEnded:true)。完成后**必须**向用户复述下一次的日期。**用户说"这个循环停掉/不做了"要的是 update_task {repeat:null},不是这里** —— 调完成反而会生成下一次',
    schema: { taskId: z.string().describe('任务 id') },
    run: (d, a) => W.completeTaskTool(w(d), s(a, 'taskId')),
  },
  {
    name: 'reopen_task',
    kind: 'write',
    description: '把已完成的任务改回进行中。**不级联** —— 之前被连带完成的子任务要逐个重开',
    schema: { taskId: z.string().describe('任务 id') },
    run: (d, a) => W.reopenTaskTool(w(d), s(a, 'taskId')),
  },
  {
    name: 'complete_project',
    kind: 'write',
    description:
      '完成项目。**不会**动它下面的行动:返回 activeTaskCount 就是被留下的活跃行动数,>0 时要向用户点明',
    schema: { project: z.string().describe('项目 id 或名称') },
    destructive: true,
    run: (d, a) => W.completeProjectTool(w(d), s(a, 'project')),
  },
  {
    name: 'delete_task',
    kind: 'write',
    description:
      '软删除任务(进回收站,可 restore_task 恢复)。**向下级联删除整棵活跃子树**(INV-26.2),数量只在 deletedSubtaskCount 里 —— 先 get_task_detail、先问用户',
    schema: { taskId: z.string().describe('任务 id') },
    destructive: true,
    run: (d, a) => W.deleteTaskTool(w(d), s(a, 'taskId')),
  },
  {
    name: 'restore_task',
    kind: 'write',
    description: '从回收站恢复任务。**不级联**:一起被删的子任务要逐个恢复',
    schema: { taskId: z.string().describe('任务 id') },
    run: (d, a) => W.restoreTaskTool(w(d), s(a, 'taskId')),
  },
  {
    name: 'create_waiting_for',
    kind: 'write',
    description: '记一条等待项(委派出去、等别人回音的事)。它计入项目的"还有活",不是待办',
    schema: {
      description: z.string().min(1).describe('在等什么'),
      delegatedTo: z.string().optional().describe('等谁;不给 = someone'),
      project: z.string().optional().describe('归属项目'),
    },
    run: (d, a) =>
      W.createWaitingFor(w(d), {
        description: s(a, 'description'),
        delegatedTo: opt(a, 'delegatedTo'),
        project: opt(a, 'project'),
      }),
  },
  {
    name: 'resolve_waiting_for',
    kind: 'write',
    description: '标记等待项已有回音。**不会**顺便建后续任务(INV-23),要建就单独调 create_task',
    schema: { waitingForId: z.string().describe('等待项 id') },
    run: (d, a) => W.resolveWaiting(w(d), s(a, 'waitingForId')),
  },
  {
    name: 'create_follow_up',
    kind: 'write',
    description: '给**未解决**的等待项建一条催办行动。不改变它的未解决状态(INV-23)',
    schema: { waitingForId: z.string().describe('等待项 id') },
    run: (d, a) => W.followUp(w(d), s(a, 'waitingForId')),
  },
  {
    name: 'add_comment',
    kind: 'write',
    description: '给任务追加一条评论(只追加,不改任何属性)',
    schema: {
      taskId: z.string().describe('任务 id'),
      body: z.string().min(1).describe('评论正文'),
    },
    run: (d, a) => W.comment(w(d), { taskId: s(a, 'taskId'), body: s(a, 'body') }),
  },
  {
    name: 'create_label',
    kind: 'write',
    description: '新建标签(同名已存在则原样返回既有的,created: false)。名字不含 @',
    schema: { name: z.string().min(1).describe('标签名,不带 @') },
    run: (d, a) => W.createLabelTool(w(d), s(a, 'name')),
  },
  {
    name: 'create_filter',
    kind: 'write',
    description: '保存一个过滤器。query 用 run_filter 的语法,语法错会被拒绝 —— 先 run_filter 试跑',
    schema: {
      name: z.string().min(1).describe('过滤器名'),
      query: z.string().min(1).describe('查询原文'),
    },
    run: (d, a) => W.createFilterTool(w(d), { name: s(a, 'name'), query: s(a, 'query') }),
  },
];

export const READ_TOOL_NAMES = SPECS.filter((x) => x.kind === 'read').map((x) => x.name);
export const WRITE_TOOL_NAMES = SPECS.filter((x) => x.kind === 'write').map((x) => x.name);
/** 静态破坏性集合;运行期还会按快照升级(见 permissionPolicy.ts)。 */
export const DESTRUCTIVE_TOOL_NAMES = SPECS.filter((x) => x.destructive === true).map(
  (x) => x.name,
);

export function toolKind(name: string): 'read' | 'write' | 'unknown' {
  return SPECS.find((x) => x.name === shortToolName(name))?.kind ?? 'unknown';
}

export function createGtdServer(deps: ToolDeps): McpSdkServerConfigWithInstance {
  const writable = deps.write !== undefined;
  const specs = SPECS.filter((x) => writable || x.kind === 'read');
  return createSdkMcpServer({
    name: GTD_MCP_SERVER_NAME,
    version: '2.0.0',
    instructions:
      '本应用(Claudoist)的 GTD 数据。条件查询一律用 run_filter(过滤器查询语言),' +
      'list_* 只做按容器/项目列举。' +
      (writable
        ? '写工具会真的改用户的数据:动手前先说清楚要改什么,拿到 consequences 后按其中的' +
          '后果字段征询用户,不要连着调下一个写工具。'
        : '全部为只读:没有任何工具会改动数据。'),
    tools: specs.map((x) =>
      tool(x.name, x.description, x.schema, async (a) =>
        Promise.resolve(json(x.run(deps, a as Record<string, never>))),
      ),
    ),
  });
}

/** M8 名字保留:只读会话。 */
export function createGtdReadServer(deps: ReadToolDeps): McpSdkServerConfigWithInstance {
  return createGtdServer(deps);
}

// ------------------------------------------------------------------ 手册

export interface ToolManualParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ToolManualEntry {
  /** 在 skill 里要写的全名,如 mcp__gtd__run_filter */
  qualified: string;
  name: string;
  description: string;
  kind: 'read' | 'write';
  destructive: boolean;
  params: ToolManualParam[];
}

/** 从 zod 定义反推参数信息 —— 与真实 schema 同源,不可能写错。 */
function describeField(f: z.ZodTypeAny): Omit<ToolManualParam, 'name'> {
  let node = f as unknown as {
    def?: {
      type?: string;
      innerType?: unknown;
      entries?: Record<string, unknown>;
      values?: unknown[];
    };
    description?: string;
  };
  let required = true;
  let description = node.description ?? '';
  let nullable = false;
  // optional/default/nullable 是包装层,要剥到里层才知道真实类型
  for (
    let i = 0;
    i < 6 &&
    node.def &&
    (node.def.type === 'optional' || node.def.type === 'default' || node.def.type === 'nullable');
    i += 1
  ) {
    if (node.def.type === 'nullable') nullable = true;
    else required = false;
    node = node.def.innerType as typeof node;
    if (description === '') description = node?.description ?? '';
  }
  const kind = node?.def?.type ?? 'unknown';
  const enumValues = node?.def?.entries
    ? Object.keys(node.def.entries)
    : Array.isArray(node?.def?.values)
      ? (node.def.values as string[])
      : null;
  // object/array 展开内部结构 —— 不展开的话手册里 repeat 只显示一个光秃秃的 "object",
  // 内部字段全不可见,用户照手册写 skill 会卡住
  let typeText = enumValues !== null ? enumValues.join(' | ') : kind;
  const shape = (node?.def as { shape?: Record<string, z.ZodTypeAny> } | undefined)?.shape;
  if (kind === 'object' && shape) {
    typeText = `{ ${Object.entries(shape)
      .map(([k, v]) => {
        const inner = describeField(v);
        return `${k}${inner.required ? '' : '?'}: ${inner.type}`;
      })
      .join(', ')} }`;
  } else if (kind === 'array') {
    const el = (node?.def as { element?: z.ZodTypeAny } | undefined)?.element;
    typeText = el ? `${describeField(el).type}[]` : 'array';
  }
  return {
    type: typeText + (nullable ? ' | null' : ''),
    required,
    description,
  };
}

/** Skills 页的"工具参考"。用户写自己的 skill 时靠它查工具名与参数。 */
export function toolManual(): ToolManualEntry[] {
  return SPECS.map((x) => ({
    qualified: qualifiedToolName(x.name),
    name: x.name,
    description: x.description,
    kind: x.kind,
    destructive: x.destructive === true,
    params: Object.entries(x.schema).map(([name, f]) => ({ name, ...describeField(f) })),
  }));
}
