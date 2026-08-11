import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ReadToolDeps } from './readTools';
import * as R from './readTools';

export * from './readTools';

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
 */

const json = (v: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(v) }],
});

export const GTD_MCP_SERVER_NAME = 'gtd';

/** M8 只读工具的完整名单(注册与 allowedTools 用同一份,不许两处各写)。 */
export const READ_TOOL_NAMES = [
  'list_inbox',
  'list_bucket',
  'list_today',
  'list_calendar',
  'list_projects',
  'get_project',
  'get_task_detail',
  'list_labels',
  'list_filters',
  'list_waiting_for',
  'search',
  'run_filter',
  'get_engage_recommendations',
] as const;

export const qualifiedToolName = (n: string): string => `mcp__${GTD_MCP_SERVER_NAME}__${n}`;

export function createGtdReadServer(deps: ReadToolDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: GTD_MCP_SERVER_NAME,
    version: '1.0.0',
    instructions:
      '本应用(Claudoist)的 GTD 数据。全部为只读:没有任何工具会改动数据。' +
      '条件查询一律用 run_filter(过滤器查询语言),list_* 只做按容器/项目列举。',
    tools: [
      tool('list_inbox', 'Inbox 里待理清的任务(不含来自外部日历的镜像任务)', {}, async () =>
        json(R.listInbox(deps)),
      ),
      tool(
        'list_bucket',
        'Someday/Maybe 或 Reference 容器里的任务(孵化中,不进 Today 与择事)',
        { kind: z.enum(['someday', 'reference']) },
        async (a) => json(R.listBucket(deps, a.kind)),
      ),
      tool(
        'list_today',
        '今天该做的:计划日 ≤ 今天,加上已过截止但从未排期的。计划到未来的不在此列(那是用户显式推迟)',
        {},
        async () => json(R.listToday(deps)),
      ),
      tool(
        'list_calendar',
        '日历区间。带 startTime 的任务即日历 block;全天与定时分开返回',
        {
          fromDate: z.string().describe('YYYY-MM-DD'),
          days: z.number().int().min(1).max(31).default(7),
        },
        async (a) => json(R.listCalendar(deps, a.fromDate, a.days)),
      ),
      tool('list_projects', '活跃项目 + 完成度 + 是否还有 active next action', {}, async () =>
        json(R.listProjects(deps)),
      ),
      tool(
        'get_project',
        '单个项目及其根任务(可传项目 id 或名称)',
        { projectId: z.string() },
        async (a) => json(R.getProject(deps, a.projectId)),
      ),
      tool(
        'get_task_detail',
        '任务详情:子任务树、评论、活跃后代数(判断完成会级联多少条时用它)',
        { taskId: z.string() },
        async (a) => json(R.getTaskDetail(deps, a.taskId)),
      ),
      tool('list_labels', '全部标签 + 各自的活跃任务数(情境已并入标签)', {}, async () =>
        json(R.listLabels(deps)),
      ),
      tool('list_filters', '用户保存的过滤器(名称 + 查询原文)', {}, async () =>
        json(R.listFilters(deps)),
      ),
      tool('list_waiting_for', '未解决的等待项(委派出去、还没回音的事)', {}, async () =>
        json(R.listWaitingFor(deps)),
      ),
      tool(
        'search',
        '按关键词搜任务标题/描述与项目名。大小写不敏感子串。**软删除的任务搜不到** —— 搜不到不等于不存在,必要时提醒用户可能在回收站',
        { query: z.string(), limit: z.number().int().min(1).max(200).optional() },
        async (a) => json(R.search(deps, a.query, a.limit)),
      ),
      tool(
        'run_filter',
        [
          '按过滤器查询语言求值 —— **这是唯一的条件查询入口**,凡是"某标签下""某优先级以上"',
          '"这周到期"之类的问题都用它,不要自己拉全表再筛。语法:',
          '@标签 #项目 p5(⚠ p5=最高,与 Todoist 的 p1=最高相反) p>=4',
          'today/tomorrow/overdue/no date/next 7 days(**均指计划日**)',
          'deadline: today / deadline before: +7 days / no deadline(**截止日只能这样写**)',
          'energy: low  est: 30  inbox/someday/reference  bucket: project',
          'done  status: active,done  status: any  search:/title:/desc: 词',
          'no labels/no project/no time  subtask  mirrored   & | ! ( )   顶层逗号 = 并列两段',
          '默认只看活跃任务;写了状态但没提 deleted 时仍排除软删。',
          '引用了不存在的标签/项目不会报错,而是返回空结果 + unknownLabels/unknownProjects —— 那说明条件恒不成立,不要当作"没有这样的任务"。',
        ].join(' '),
        { query: z.string() },
        async (a) => json(R.runFilter(deps, a.query)),
      ),
      tool(
        'get_engage_recommendations',
        [
          '择事推荐(GTD 四标准:情境→时间→精力→优先级)。先给今天已排期的硬性日程',
          '(与标签无关),再给候选前 7 条。**只读** —— 完成任务是独立的写操作。',
          '不传 labelName = 不按标签过滤。',
        ].join(' '),
        {
          labelName: z.string().optional().describe('标签名,可带或不带 @'),
          availableMinutes: z.number().int().min(1).default(60),
          energy: z.enum(['low', 'medium', 'high']).default('medium'),
        },
        async (a) => json(R.engageRecommendations(deps, a.labelName, a.availableMinutes, a.energy)),
      ),
    ],
  });
}
