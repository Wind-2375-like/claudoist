import { app, shell } from 'electron';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 用户可调的那一层 prompt = **`CLAUDE.md`**(Claude Code 的标准机制)。
 *
 * 分层是有意的,三层各自的可改性不同:
 *
 * | 层 | 内容 | 谁能改 | 为什么 |
 * |---|---|---|---|
 * | 固化不变量(`systemPrompt.ts`) | priority 方向、energy 过滤方向、日期字段语义、级联规则… | **不可改** | 改了 agent 就会给出与应用界面不一致的答案。这些不是偏好,是正确性约束(每条都标了 INV 编号,有 CI 断言) |
 * | **CLAUDE.md**(本文件管的) | 称呼、语气、工作时段、默认可用分钟、你自己的 GTD 习惯 | **用户随便改** | 这些本来就该由用户定;Claude Code 的标准做法就是项目级 CLAUDE.md |
 * | 会话状态快照 | 今天日期、各容器计数 | 自动生成 | 每次会话开始由 main 组装 |
 *
 * 加载机制:会话 `cwd = userData`,`settingSources` 含 `'project'` → SDK 会自动读取
 * `<cwd>/CLAUDE.md`。**不需要我们把它拼进 systemPrompt**,拼进去反而会绕过用户后续的编辑。
 *
 * 与 skill 文件的关键差别:skill **每次启动重写**(内容跟版本走),CLAUDE.md **只在缺失
 * 时创建**,此后再不触碰 —— 它是用户的东西。
 */

const TEMPLATE = `# 我的偏好

> 这份文件是**你的**,Claudoist 只在它不存在时创建一次,之后永远不会覆盖你的修改。
> 右栏的 agent 每次开会话都会读它。想让它换个说话方式、记住你的作息,改这里就行。
>
> ⚠ 有些东西**改这里没用**:优先级方向(5 = 最高)、精力过滤方向、计划日与截止日的区分、
> 完成向下级联等等 —— 那些是应用的正确性约束,写死在程序里。你可以让 agent 换语气,
> 但不能让它按另一套规则算。

## 称呼与语气

- 叫我:(留空则不特别称呼)
- 语气:简洁直接就好,不用铺垫。

## 我的作息

- 一般工作时段:09:00–18:00
- 精力最好的时段:(例如 上午 9–11)
- 不希望被安排事情的时段:(例如 午休 12–13、周日全天)

## 排程习惯

- 默认"我有多少时间":60 分钟
- 单个时间块最长:90 分钟
- 时间块之间希望留:10 分钟缓冲

## 我的 GTD 习惯

- (例如:@computer 下的事我通常上午做)
- (例如:标了 @errands 的事希望攒到一起提醒我)

## 其它

- (任何你希望它记住的事)
`;

export function userMemoryPath(): string {
  return join(app.getPath('userData'), 'CLAUDE.md');
}

/** 只在缺失时创建 —— 这是用户的文件,不是我们的。 */
export function ensureUserMemory(): { path: string; created: boolean } {
  const path = userMemoryPath();
  if (existsSync(path)) return { path, created: false };
  writeFileSync(path, TEMPLATE, 'utf8');
  return { path, created: true };
}

/** 用系统默认编辑器打开,让用户直接改。 */
export async function openUserMemory(): Promise<void> {
  const { path } = ensureUserMemory();
  await shell.openPath(path);
}
