import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * GTD 流程 skill 的载体(D-28 / DESIGN §6.9)。
 *
 * SDK 有 `options.skills?: string[] | 'all'`,skill 由 CLI 自己从磁盘发现。三条约束
 * 决定了文件必须放在 **`<userData>/.claude/skills/`**:
 *
 * 1. `CLAUDE_CONFIG_DIR` 按 M1 定案**不重定向**,所以不能借用户的 `~/.claude` ——
 *    否则应用的 skill 会污染用户自己的 Claude Code 环境,反之亦然。
 * 2. 会话的 `cwd` 就是 `userData`,skill 因此作为"项目级"被发现(`settingSources`
 *    含 `'project'`/`'local'`)。
 * 3. 打包后 asar 里的文件子进程读不到 —— 所以不是"打包进去再指路径",而是**每次启动
 *    写出到 userData**。顺带白拿一个好处:skill 内容跟着版本走,不会留下旧副本。
 *
 * M8 只落 `gtd-engage` 的**只读半程**(INV-20.5:推荐是只读,完成是独立写操作)。
 * clarify / decompose / weekly-review 依赖写工具,随 M9 落地。
 */

export const SKILL_NAMES = ['gtd-engage'] as const;

const ENGAGE_SKILL = `---
name: gtd-engage
description: 帮用户挑一件现在就能做的事(GTD 择事)。用户说"帮我挑一件事做""现在做什么""我有 30 分钟"之类时使用。
---

# 择事(Engage)

GTD 的四标准择事模型:**情境 → 可用时间 → 精力 → 优先级**,顺序即算法。

## 步骤

1. **先摆出今天已排期的事**。调用 \`mcp__gtd__get_engage_recommendations\`,它返回的
   \`calendarFirst\` 就是今天已承诺的硬性日程(按时刻序)。这些**轮不到"挑"** —— 先告诉
   用户"今天你已经答应了这些",再往下走。注意它**不受标签过滤影响**,这是有意的:
   已经承诺的事跟你现在在哪没关系。

2. **问清三件事**(用户没说的才问,说了的不要重复问):
   - 现在在什么情境?→ 标签。可先调 \`mcp__gtd__list_labels\` 把选项和各自的任务数摆出来。
   - 有多少时间?→ 分钟数,默认 60。
   - 精力如何?→ low / medium / high,默认 medium。

3. **给候选**。把上面三项作为 \`labelName\` / \`availableMinutes\` / \`energy\` 再调一次
   \`get_engage_recommendations\`,直接呈现它返回的 \`candidates\`(最多 7 条)。若
   \`matched > candidates.length\`,补一句"另有 N 条未列出"。

4. **停在这里**。用户说"我做完了"时,如实告诉他:你现在**只有只读工具,不能替他打勾**,
   请他在界面上点完成圈,或等写入能力上线。

## 铁律

- **不要自己拉全表再筛**。候选必须来自 \`get_engage_recommendations\`;它已经实现了
  "任务 energy ≤ 用户 energy""预估时长 ≤ 可用分钟""排除 someday/reference""排除今天
  已排期的""优先级降序稳定排序""最多 7 条"。你另写一套必然与应用界面对不上。
- 优先级 **5 最高、1 最低**(与 Todoist 相反)。
- 截止日**不参与**择事排序,只随行显示。用户要问"什么快到期了",那是另一个问题,
  用 \`mcp__gtd__run_filter\` 配 \`deadline before: +N days\`。
`;

/** 每次启动写出 skill 文件;返回可直接并入 Options 的片段。 */
export function skillsOption(): { skills: string[] } {
  const root = join(app.getPath('userData'), '.claude', 'skills');
  for (const [name, body] of [['gtd-engage', ENGAGE_SKILL]] as const) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
  }
  return { skills: [...SKILL_NAMES] };
}

/** 冒烟用:skill 文件写到哪了。 */
export function skillsDir(): string {
  return join(app.getPath('userData'), '.claude', 'skills');
}
