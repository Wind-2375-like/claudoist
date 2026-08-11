import { app } from 'electron';
import type { Clock, GtdStore } from '@gtd/domain';
import { READ_TOOL_NAMES, qualifiedToolName, statusSnapshot } from '@gtd/agent-tools';
import { authStatus } from './auth';
import { startSession } from './sessionManager';
import { skillsDir } from './skills';
import { buildSystemPrompt } from './systemPrompt';

/**
 * M8 无头冒烟(`--agent-smoke[=提问]`)。M1 用 `--spike-test` 验过"打包内 SDK 能跑通",
 * M8 要验的是三件**只靠单元测试验不到**的事:
 *
 * 1. **skill 真被子进程加载** —— `system/init` 会回报 `skills: string[]`,里面必须有
 *    `gtd-engage`。打包后 asar 挡住 skill 文件是很现实的失败,不跑一次不知道。
 * 2. **工具面真的只有只读工具** —— `system/init.tools` 里不能出现 Bash/Write/Edit。
 * 3. 一次真实往返能拿到 result。
 */
export async function runAgentSmoke(store: GtdStore, clock: Clock, arg: string): Promise<void> {
  const question = arg.includes('=')
    ? arg.slice(arg.indexOf('=') + 1)
    : '我今天该做什么?只用工具查,简短回答。';
  const auth = authStatus();
  let init: {
    tools?: string[];
    skills?: string[];
    mcp_servers?: { name: string; status: string }[];
  } | null = null;
  let failed = false;
  const toolsCalled: string[] = [];
  let answer = '';

  await new Promise<void>((resolve) => {
    startSession({ deps: { store, clock }, maxTurns: 6, maxBudgetUsd: 1 }, (ev) => {
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
        // 记下这轮真正调了哪些工具、最后说了什么 —— 只读工具面不是"注册上了"就算数
        const content = ((m['message'] as { content?: unknown[] } | undefined)?.content ?? []) as {
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
    });
    // 会话起来后立刻问一句
    setTimeout(() => {
      void import('./sessionManager').then((s) => s.send(question, []));
    }, 300);
  });

  const i = init as {
    tools?: string[];
    skills?: string[];
    mcp_servers?: { name: string; status: string }[];
  } | null;
  const tools = i?.tools ?? [];
  const gtdTools = tools.filter((t) => t.startsWith('mcp__gtd__'));
  const builtins = tools.filter((t) => !t.startsWith('mcp__'));
  const skillsLoaded = i?.skills ?? [];
  const report = {
    auth: { loggedIn: auth.loggedIn, email: auth.email, apiKeyInEnv: auth.apiKeyInEnv },
    skillsDir: skillsDir(),
    // 注意区分:init.skills 是**发现**到的(含用户 ~/.claude/skills 里的私人 skill),
    // 而 options.skills 是**启用过滤器** —— 未列出的对模型隐藏且 Skill 工具会拒绝。
    // 再加上我们不给 Read/Bash,用户的私人 skill 既看不到也调不动。
    skillsDiscovered: skillsLoaded.length,
    skillsEnabled: ['gtd-engage'],
    skillOk: skillsLoaded.includes('gtd-engage'),
    gtdToolCount: gtdTools.length,
    expectedToolCount: READ_TOOL_NAMES.length,
    toolsOk:
      READ_TOOL_NAMES.every((n) => gtdTools.includes(qualifiedToolName(n))) &&
      gtdTools.length === READ_TOOL_NAMES.length,
    // 只读的硬保证:内置工具**只允许** Skill(它是加载 skill 的入口,本身不碰数据)
    builtins,
    builtinsLeaked: builtins.filter((t) => t !== 'Skill'),
    readOnlyOk: builtins.every((t) => t === 'Skill') && builtins.includes('Skill'),
    mcpServers: i?.mcp_servers ?? [],
    promptChars: buildSystemPrompt(statusSnapshot({ store, clock })).length,
    toolsCalled,
    // 真跑通的标志:这一轮确实调了 GTD 只读工具,而不是凭 system prompt 快照瞎猜
    calledGtdTool: toolsCalled.some((t) => t.startsWith('mcp__gtd__')),
    answerPreview: answer.slice(0, 200),
  };
  process.stdout.write(`[AGENT_SMOKE] ${JSON.stringify(report)}\n`);
  const ok =
    !failed && report.skillOk && report.toolsOk && report.readOnlyOk && report.calledGtdTool;
  app.exit(ok ? 0 : 1);
}
