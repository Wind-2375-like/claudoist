import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ReadToolDeps } from './readTools';
import * as R from './readTools';
import { timeContext } from './timeContext';

export * from './readTools';
export * from './timeContext';

/**
 * @gtd/agent-tools — in-process MCP 工具面(M8:只读)。
 *
 * 工具名最终形如 `mcp__gtd__list_inbox`。handler 直连 main 的同一个 `GtdStore`,
 * 所以 agent 看到的永远是当前库状态,不存在缓存不一致。
 *
 * **为什么工具切得这么细**:每个工具都是一次 domain 调用的薄包装,读起来像
 * "这次调用用了哪条规则"。反过来,一个万能的 `query_tasks(conditions...)` 会
 * 诱使实现方在这一层重写过滤 —— 那正是 INV-20.6 / INV-32.6 / INV-33.9 三条
 * "单一口径"纪律要防的事(桌面与 CLI 曾各写一遍,结果计数与列表对不上)。
 *
 * **工具定义与用户手册同源**:下面的 `SPECS` 既用来注册工具,也用来渲染
 * Skills 页里的"工具参考"(`toolManual()`)。用户要自己写 skill 就必须知道有哪些
 * 工具、参数叫什么 —— 手册若是另抄一份,迟早与真实工具对不上,而那种错误只会在
 * agent 调用失败时才暴露。
 */

const json = (v: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(v) }],
});

export const GTD_MCP_SERVER_NAME = 'gtd';

export const qualifiedToolName = (n: string): string => `mcp__${GTD_MCP_SERVER_NAME}__${n}`;

interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  run: (deps: ReadToolDeps, args: Record<string, never>) => unknown;
}

/** 一次定义,两处使用:注册工具 + 渲染手册。 */
const SPECS: ToolSpec[] = [
  {
    name: 'get_now',
    description:
      '当前时刻、星期、时区与地区。长会话里时间会漂移 —— 需要精确判断"还有多久""来不来得及"时重新校一次',
    schema: {},
    run: () => timeContext(),
  },
  {
    name: 'list_inbox',
    description: 'Inbox 里待理清的任务(不含来自外部日历的镜像任务)',
    schema: {},
    run: (d) => R.listInbox(d),
  },
  {
    name: 'list_bucket',
    description: 'Someday/Maybe 或 Reference 容器里的任务(孵化中,不进 Today 与择事)',
    schema: { kind: z.enum(['someday', 'reference']).describe('要看哪个容器') },
    run: (d, a) => R.listBucket(d, a['kind'] as unknown as 'someday' | 'reference'),
  },
  {
    name: 'list_today',
    description:
      '今天该做的:计划日 ≤ 今天,加上已过截止但从未排期的。计划到未来的不在此列(那是用户显式推迟)',
    schema: {},
    run: (d) => R.listToday(d),
  },
  {
    name: 'list_calendar',
    description: '日历区间。带 startTime 的任务即日历 block;全天与定时分开返回',
    schema: {
      fromDate: z.string().describe('起始日期 YYYY-MM-DD'),
      days: z.number().int().min(1).max(31).default(7).describe('天数,1–31'),
    },
    run: (d, a) =>
      R.listCalendar(d, a['fromDate'] as unknown as string, a['days'] as unknown as number),
  },
  {
    name: 'list_projects',
    description: '活跃项目 + 完成度 + 是否还有 active next action(hasActiveNextAction)',
    schema: {},
    run: (d) => R.listProjects(d),
  },
  {
    name: 'get_project',
    description: '单个项目及其根任务',
    schema: { projectId: z.string().describe('项目 id 或名称') },
    run: (d, a) => R.getProject(d, a['projectId'] as unknown as string),
  },
  {
    name: 'get_task_detail',
    description: '任务详情:子任务树、评论、活跃后代数(判断"完成会级联多少条"时用它)',
    schema: { taskId: z.string().describe('任务 id') },
    run: (d, a) => R.getTaskDetail(d, a['taskId'] as unknown as string),
  },
  {
    name: 'list_labels',
    description: '全部标签 + 各自的活跃任务数(情境已并入标签)',
    schema: {},
    run: (d) => R.listLabels(d),
  },
  {
    name: 'list_filters',
    description: '用户保存的过滤器(名称 + 查询原文)',
    schema: {},
    run: (d) => R.listFilters(d),
  },
  {
    name: 'list_waiting_for',
    description: '未解决的等待项(委派出去、还没回音的事)',
    schema: {},
    run: (d) => R.listWaitingFor(d),
  },
  {
    name: 'search',
    description:
      '按关键词搜任务标题/描述与项目名。大小写不敏感子串。**软删除的任务搜不到** —— 搜不到不等于不存在,必要时提醒用户可能在回收站',
    schema: {
      query: z.string().describe('关键词'),
      limit: z.number().int().min(1).max(200).optional().describe('每类上限,默认 50'),
    },
    run: (d, a) =>
      R.search(d, a['query'] as unknown as string, a['limit'] as unknown as number | undefined),
  },
  {
    name: 'run_filter',
    description: [
      '按过滤器查询语言求值 —— **这是唯一的条件查询入口**。凡是"某标签下""某优先级以上"',
      '"这周到期"之类的问题都用它,不要自己拉全表再筛。语法:',
      '@标签 · #项目 · p5(⚠ p5=最高,与 Todoist 的 p1=最高相反)· p>=4 ·',
      'today/tomorrow/overdue/no date/next 7 days(**均指计划日**)·',
      'deadline: today / deadline before: +7 days / no deadline(**截止日只能这样写**)·',
      'energy: low · est: 30 · inbox/someday/reference · bucket: project ·',
      'done / status: active,done / status: any · search:/title:/desc: 词 ·',
      'no labels / no project / no time · subtask · mirrored · & | ! ( ) · 顶层逗号 = 并列两段。',
      '默认只看活跃任务;写了状态但没提 deleted 时仍排除软删。',
      '引用了不存在的标签/项目不会报错,而是返回空结果 + unknownLabels/unknownProjects ——',
      '那说明条件恒不成立,不要当作"没有这样的任务"。',
    ].join(' '),
    schema: { query: z.string().describe('查询原文,如 deadline before: +7 days & no date') },
    run: (d, a) => R.runFilter(d, a['query'] as unknown as string),
  },
  {
    name: 'get_engage_recommendations',
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
        a['labelName'] as unknown as string | undefined,
        a['availableMinutes'] as unknown as number,
        a['energy'] as unknown as 'low' | 'medium' | 'high',
      ),
  },
];

export const READ_TOOL_NAMES = SPECS.map((s) => s.name);

export function createGtdReadServer(deps: ReadToolDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: GTD_MCP_SERVER_NAME,
    version: '1.0.0',
    instructions:
      '本应用(Claudoist)的 GTD 数据。全部为只读:没有任何工具会改动数据。' +
      '条件查询一律用 run_filter(过滤器查询语言),list_* 只做按容器/项目列举。',
    tools: SPECS.map((s) =>
      tool(s.name, s.description, s.schema, async (a) =>
        Promise.resolve(json(s.run(deps, a as Record<string, never>))),
      ),
    ),
  });
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
  // optional/default 是包装层,要剥到里层才知道真实类型
  for (
    let i = 0;
    i < 5 && node.def && (node.def.type === 'optional' || node.def.type === 'default');
    i += 1
  ) {
    if (node.def.type === 'optional') required = false;
    if (node.def.type === 'default') required = false;
    node = node.def.innerType as typeof node;
    if (description === '') description = node?.description ?? '';
  }
  const kind = node?.def?.type ?? 'unknown';
  const enumValues = node?.def?.entries
    ? Object.keys(node.def.entries)
    : Array.isArray(node?.def?.values)
      ? (node.def.values as string[])
      : null;
  return {
    type: enumValues !== null ? enumValues.join(' | ') : kind,
    required,
    description,
  };
}

/** Skills 页的"工具参考"。用户写自己的 skill 时靠它查工具名与参数。 */
export function toolManual(): ToolManualEntry[] {
  return SPECS.map((s) => ({
    qualified: qualifiedToolName(s.name),
    name: s.name,
    description: s.description,
    params: Object.entries(s.schema).map(([name, f]) => ({ name, ...describeField(f) })),
  }));
}
