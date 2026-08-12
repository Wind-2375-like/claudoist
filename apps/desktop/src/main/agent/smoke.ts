import { app } from 'electron';
import type { Clock, GtdStore } from '@gtd/domain';
import {
  qualifiedToolName,
  READ_TOOL_NAMES,
  statusSnapshot,
  WRITE_TOOL_NAMES,
  type PermissionModeId,
} from '@gtd/agent-tools';
import { agentStore, settingsStore } from '../db';
import { authStatus } from './auth';
import { startSession, send } from './sessionManager';
import { BUILTIN_SKILL_NAMES, skillsDir } from './skills';
import { buildSystemPrompt } from './systemPrompt';
import { createConversation } from './conversations';
import { buildCanUseTool, recordSdkMessage } from './bookkeeping';

/**
 * 无头冒烟(`--agent-smoke[=提问][ --agent-smoke-mode=auto]`)。
 *
 * M1 用 `--spike-test` 验过"打包内 SDK 能跑通";这里验的是**只靠单元测试验不到**的事:
 *
 * 1. **skill 真被子进程加载** —— `system/init.skills` 里必须有内置那几个。
 *    打包后 asar 挡住 skill 文件是很现实的失败,不跑一次不知道。
 * 2. **工具面与权限模式一致** —— plan 模式下写工具**根本不该出现**在 init.tools 里;
 *    可写模式下读写工具都要齐。这是纵深防御的第一层,必须在真实进程里确认。
 * 3. **内置工具没漏** —— 只允许 Skill 与 Read,Bash/Write/Edit 一个都不能有。
 * 4. **canUseTool 真的被调到,并且真的落审计** —— 权限体系里最容易"看着接上了其实没接"
 *    的一环:只要有一次工具调用没经过 canUseTool,它就既不受模式约束也不进审计。
 * 5. 一次真实往返能拿到 result。
 */
export async function runAgentSmoke(store: GtdStore, clock: Clock, arg: string): Promise<void> {
  const settings = settingsStore();
  const question = arg.includes('=')
    ? arg.slice(arg.indexOf('=') + 1)
    : '我今天该做什么?只用工具查,简短回答。';
  const modeArg = process.argv.find((a) => a.startsWith('--agent-smoke-mode='));
  const mode = (modeArg?.slice('--agent-smoke-mode='.length) ?? 'manual') as PermissionModeId;
  const auth = authStatus();
  let init: { tools?: string[]; skills?: string[] } | null = null;
  let failed = false;
  const toolsCalled: string[] = [];
  /** canUseTool 实际收到的调用 —— 与 toolsCalled 对不上就说明有调用绕过了权限层 */
  const gated: string[] = [];
  let answer = '';

  const conversationId = createConversation('smoke');
  const canWrite = mode !== 'plan';
  const writeDeps = canWrite
    ? {
        store,
        deps: { clock, idGen: { next: (): string => crypto.randomUUID() } },
        onChanged: (): void => undefined,
      }
    : undefined;

  const real = buildCanUseTool({ store, settings, conversationId: () => conversationId });

  await new Promise<void>((resolve) => {
    startSession(
      {
        deps: { store, clock },
        ...(writeDeps !== undefined ? { write: writeDeps } : {}),
        settings,
        conversationId,
        permissionMode: mode,
        // **生产路径的那座桥**,不是冒烟自制的简化版 —— 权限一处漏就全盘失效,
        // 冒烟必须打在真代码上。无头环境没有窗口,ask 会按 fail-closed 判成拒绝,
        // 这正是我们要验的行为之一。
        canUseTool: (toolName, input, opts) => {
          gated.push(toolName);
          return real(toolName, input, opts);
        },
        maxTurns: 6,
        maxBudgetUsd: 1,
      },
      (ev) => {
        if (ev.type === 'message') recordSdkMessage(conversationId, ev.payload);
        if (ev.type === 'error') {
          process.stdout.write(`[AGENT_SMOKE_ERROR] ${ev.message ?? ''}\n`);
          failed = true;
          resolve();
          return;
        }
        if (ev.type === 'ended') return resolve();
        const m = ev.payload as { type: string; subtype?: string; is_error?: boolean } & Record<
          string,
          unknown
        >;
        if (m.type === 'system' && m.subtype === 'init') init = m as never;
        if (m.type === 'assistant') {
          // 记下这轮真正调了哪些工具、最后说了什么 —— 工具面不是"注册上了"就算数
          const content = ((m['message'] as { content?: unknown[] } | undefined)?.content ??
            []) as {
            type?: string;
            name?: string;
            text?: string;
          }[];
          for (const b of content) {
            if (b.type === 'tool_use' && b.name) toolsCalled.push(b.name);
            if (b.type === 'text' && b.text) answer = b.text;
          }
        }
        if (m.type === 'result') {
          failed = m.is_error === true;
          resolve();
        }
      },
    );
    // 会话起来后立刻问一句
    setTimeout(() => send(question, []), 300);
  });

  const i = init as { tools?: string[]; skills?: string[] } | null;
  const tools = i?.tools ?? [];
  const gtdTools = tools.filter((t) => t.startsWith('mcp__gtd__'));
  const builtins = tools.filter((t) => !t.startsWith('mcp__'));
  const skillsLoaded = i?.skills ?? [];
  const expected = canWrite ? [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES] : READ_TOOL_NAMES;
  const ALLOWED_BUILTINS = ['Skill', 'Read'];
  const audit = agentStore().listAudit(conversationId, 100);

  const report = {
    mode,
    auth: { loggedIn: auth.loggedIn, email: auth.email, apiKeyInEnv: auth.apiKeyInEnv },
    skillsDir: skillsDir(),
    // 注意区分:init.skills 是**发现**到的(含用户 ~/.claude/skills 里的私人 skill),
    // 而 options.skills 是**启用过滤器** —— 未列出的对模型隐藏且 Skill 工具会拒绝。
    skillsDiscovered: skillsLoaded.length,
    skillsEnabled: BUILTIN_SKILL_NAMES,
    skillOk: BUILTIN_SKILL_NAMES.every((n: string) => skillsLoaded.includes(n)),
    gtdToolCount: gtdTools.length,
    expectedToolCount: expected.length,
    toolsOk:
      expected.every((n) => gtdTools.includes(qualifiedToolName(n))) &&
      gtdTools.length === expected.length,
    // 只读模式的硬保证:写工具**不注册**,而不是"注册了但会被拒"
    writeToolsAbsentInPlan:
      canWrite || WRITE_TOOL_NAMES.every((n) => !gtdTools.includes(qualifiedToolName(n))),
    builtins,
    builtinsLeaked: builtins.filter((t) => !ALLOWED_BUILTINS.includes(t)),
    readOnlyOk: builtins.every((t) => ALLOWED_BUILTINS.includes(t)) && builtins.includes('Skill'),
    toolsCalled,
    calledGtdTool: toolsCalled.some((t) => t.startsWith('mcp__gtd__')),
    // 每一次工具调用都必须经过 canUseTool;漏一次就等于开了一个不受权限管的后门
    gatedCount: gated.length,
    allGated: toolsCalled.every((t) => gated.includes(t)),
    auditRows: audit.length,
    // 放行的调用必须有结果摘要 —— 没有就说明 toolUseID → 审计行的关联断了
    auditWithResult: audit.filter((a) => a.resultSummary !== null).length,
    auditOk:
      audit.length >= gated.length &&
      gated.length > 0 &&
      audit.filter((a) => a.decision !== 'denied').every((a) => a.resultSummary !== null),
    promptChars: buildSystemPrompt(statusSnapshot({ store, clock }), {
      canWrite,
      permissionMode: mode,
    }).length,
    answerPreview: answer.slice(0, 200),
  };
  process.stdout.write(`[AGENT_SMOKE] ${JSON.stringify(report)}\n`);
  const ok =
    !failed &&
    report.skillOk &&
    report.toolsOk &&
    report.writeToolsAbsentInPlan &&
    report.readOnlyOk &&
    report.calledGtdTool &&
    report.allGated &&
    report.auditOk;
  app.exit(ok ? 0 : 1);
}
