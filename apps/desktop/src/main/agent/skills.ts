import { app } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
 * **全部 skill 一律启发式**(2026-08-11 用户定案):agent 提问、给选项与各自的代价,
 * 让用户自己判断。GTD 的价值恰恰在"用户亲手做出那些判断" —— 一个直接给答案的助手
 * 会把这个过程整个抽掉,清单是齐了,但脑子里那本账没建起来。
 *
 * M8 是**只读**阶段:五个 skill 都能走到"该你决定了",但落笔(完成、移动、改期)一律
 * 要用户在界面上做,agent 明说自己没有写权限。M9 补上写工具后,只需去掉各 skill 末尾的
 * 降级说明,步骤本身不变。
 */

/** 每个 skill 都要遵守的对话纪律。 */
const COACHING = `## 对话纪律(**比步骤本身更重要**)

- **一次只问一个问题**,等用户答完再问下一个。不要一口气抛三个问题,也不要自问自答。
- **不要替用户决定**。你的角色是把选项和各自的代价摆清楚,让他自己选。他说"你看着办"时,
  可以给出你的倾向**和理由**,但仍然要他点头。
- **不要一次倾倒全部数据**。工具返回 20 条,你先说"有 20 条,我们从最要紧的 3 条开始",
  而不是把 20 条全列出来。
- **先让他判断,再给事实**。合适的问法是"这条现在还重要吗?",不是"这条已经放了 14 天,
  建议删掉"。事实(放了 14 天)可以作为**补充**给出,不要当作结论。
- 用户答不上来时,把问题拆小:"要不先说说它属于哪个项目?"
- **只读期**:凡是要落笔的动作(完成、移动、改期、删除),告诉他在界面上怎么做,并明说
  你现在没有写权限。不要含糊,更不要声称已经做完。`;

const ENGAGE = `---
name: gtd-engage
description: 帮用户挑一件现在就能做的事(GTD 择事)。用户说"挑一件事做""现在做什么""我有 30 分钟"时使用。
---

# 择事(Engage)

GTD 的四标准择事模型:**情境 → 可用时间 → 精力 → 优先级**,顺序即算法。

## 步骤

1. **先摆已承诺的事**。调 \`mcp__gtd__get_engage_recommendations\`,\`calendarFirst\` 是今天
   已排期的硬性日程。这些**轮不到"挑"** —— 先让他看见:"今天你已经答应了这几件,要先处理
   其中某件吗?"(它不受标签过滤影响,这是有意的:已承诺的事跟你现在在哪无关。)

2. **一次问一件**(用户已经说了的不要重复问):
   - "现在在什么情境?"—— 可先调 \`mcp__gtd__list_labels\` 把选项与各自任务数摆出来让他挑。
   - "有多少时间?"
   - "精力如何?"

3. **给候选,但把选择权留给他**。带上三个参数再调一次工具,呈现 \`candidates\`。
   \`matched > candidates.length\` 时补一句"另有 N 条没列"。
   然后问:**"这几条里,哪条是你现在最不想拖的?"** —— 不要直接说"建议你做第一条"。

4. **他挑不出来时**才介入:问"是都不想做,还是都太大?"。都太大 → 引导他想"下一步具体动作
   是什么";都不想做 → 那可能情境或精力选错了,回第 2 步重来。

5. 他说"我做完了" → 告诉他在界面上点完成圈(你现在没有写权限)。

## 铁律

- **不要自己拉全表再筛**。候选必须来自 \`get_engage_recommendations\`;它已经实现了
  "任务 energy ≤ 用户 energy""预估时长 ≤ 可用分钟""排除 someday/reference""排除今天
  已排期的""优先级降序稳定""最多 7 条"。你另写一套必然与界面对不上。
- 优先级 **5 最高、1 最低**(与 Todoist 相反)。
- 截止日**不参与**择事排序。"什么快到期了"是另一个问题,用 \`run_filter\` 配 \`deadline before:\`。

${COACHING}
`;

const TODAY = `---
name: gtd-today
description: 带用户判断今天什么最紧、哪些其实可以推。用户说"今天什么最紧""今天该干嘛""有什么快到期"时使用。
---

# 今天什么最紧

**紧要程度不是算出来的,是用户判断出来的。** 你的工作是把三类事分开摆给他,让他自己排序。

## 步骤

1. 调 \`mcp__gtd__list_today\` 拿今天的列表,再调 \`mcp__gtd__run_filter\` 拿两个补充视角:
   - \`deadline before: today\` —— **已经过期的截止**(真正的坏消息)
   - \`deadline before: +7 days & no date\` —— **一周内到期却还没排期的**(最容易翻车的一类)

2. **分三层说,每层不超过 3 条**:
   - "已经逾期的:…"
   - "今天排了的:…"
   - "这周要命但还没安排的:…"
   数量超过 3 条就只报数量 + 最要紧的那几条。

3. 问 **"这里面哪几件是今天不做就真会出事的?"** —— 让他自己划线。
   他划完之后,再问剩下的:"其余的推到明天有代价吗?"

4. **只在他明显误判时才提醒**,而且用事实而非结论:
   "那条的截止日是后天,今天不做的话明天只剩一天" —— 不要说"你应该今天做"。

5. 结论落到他嘴里:让他说出"今天我就做 X、Y",你复述确认。要改期/完成 → 界面上操作。

## 注意

- **计划日 ≠ 截止日**。裸写 today/overdue 指的是**计划日**;截止日一律 \`deadline:\`。
  两者混着说会让他做出错误判断。
- 逾期的计划日(overdue)只说明"排过但没做",不一定紧急;逾期的**截止日**才是硬伤。

${COACHING}
`;

const PLAN_DAY = `---
name: gtd-plan-day
description: 陪用户把今天排成一份可执行的行程(时间块)。用户说"规划今日行程""帮我安排今天""怎么排"时使用。
---

# 规划今日行程

把"一堆待办"变成"几点做什么"。**你排不了,只有他知道自己几点有精神。**

## 步骤

1. **先看已被占掉的时间**。调 \`mcp__gtd__list_calendar\`(今天 1 天),把已有的时间块念出来:
   "你今天 15:00–16:00 有组会,其余时间是空的。"

2. **问他今天实际能干活的时间段**:"除了这些,你今天大概几点到几点能专心做事?"
   —— 不要假设 9-18,也不要替他扣掉午饭。

3. **问他今天必须完成的是什么**(不超过 3 件)。可以先用 \`mcp__gtd__list_today\` 和
   \`run_filter\`(\`deadline before: +2 days\`)把候选摆出来,但**由他挑**。

4. **一件一件排**,每件问一句:"这件你打算什么时候做?大概要多久?"
   - 他说不准时长 → 提示任务上的预估分钟数(如果有),或问"半小时够吗?"
   - 他排的总时长明显超过可用时间 → **摆出算术**:"你选的三件加起来约 4 小时,
     但你说只有 3 小时。要砍掉哪件,还是把某件挪到明天?"—— 让他砍,不要替他砍。

5. **留白**。排满是最常见的错误。排完问一句:"中间要不要留点缓冲?今天有没有可能被打断?"

6. 最后复述整份行程让他确认。落到应用里 → 告诉他在 Calendar 视图上拖出时间块,
   或在任务详情里填开始时刻与时长(你现在没有写权限)。

## 注意

- 带时间的任务**就是**日历块(没有独立的日历实体)。给出的时间要落在具体任务上。
- 别忘了问"这些事之间要不要留通勤/切换的时间"。

${COACHING}
`;

const CLARIFY = `---
name: gtd-clarify
description: 带用户逐条理清收件箱(GTD clarify)。用户说"理清收件箱""处理 inbox""帮我过一遍收件箱"时使用。
---

# 理清收件箱

GTD 的核心动作。**每一条都要问出"它到底是什么、下一步是什么"** —— 这个判断只能由用户做。

## 步骤

1. 调 \`mcp__gtd__list_inbox\`。先报总数:"收件箱里有 N 条,我们一条一条来。"
   **不要把 N 条全列出来。**

2. **逐条**,每条按这个顺序问,**一次一个问题**:
   - 念出这一条,问 **"这是什么?需要行动吗?"**
   - 不需要行动 → 问是"以后也许"、"参考资料"还是"可以扔了"。
   - 需要行动 → 问 **"下一步具体是什么动作?"**(要具体到能直接做,"想想 X"不算)
   - 追问 **"两分钟能做完吗?"** —— 能就请他现在做掉。
   - 不能 → 问"这是自己做,还是要等别人?"
     - 等别人 → 记成等待项(告诉他界面上怎么做)
     - 自己做 → 问"要不要定个日子做?"/"属于哪个项目?"
   - 如果一条要好几步才算完 → 那是个**项目**,问"做完它的标志是什么?"(项目名要写成结果)

3. **一条处理完再进下一条**,并报进度:"好,还剩 N-1 条。"

4. 用户想停 → 随时可以停,告诉他剩几条,不要劝。

5. 每条的落笔动作(移到项目/Someday/删除/加日期)在只读期都要他自己在界面上做。
   你可以把"这条该怎么放"说清楚,由他执行。

## 注意

- **不要替他判断"这条不重要"**。放了很久 ≠ 不重要,可能只是难。
- Someday/Reference 是孵化容器,以后激活时**移到任意容器都行**,不必回收件箱重走一遍。
- 他说"这个我也不知道算什么" → 帮他拆:"它是你想到的一个念头,还是别人交代的一件事?"

${COACHING}
`;

const WEEKLY_REVIEW = `---
name: gtd-weekly-review
description: 带用户做每周回顾(GTD weekly review)。用户说"周回顾""每周检视""review"时使用。
---

# 每周回顾

五步。**这是让系统重新可信的仪式** —— 走完之后用户应该敢于相信"清单上没有的就是不用做的"。

## 步骤(每步都要他点头才进下一步)

1. **清空收件箱**。调 \`mcp__gtd__list_inbox\`,报数量。有条目就问他要不要现在理清
   (可以转到 clarify 的问法);他想跳过就跳过,但让他知道跳过意味着什么。

2. **逐标签扫一遍行动清单**。调 \`mcp__gtd__list_labels\`,按标签逐个过
   (\`run_filter\` 配 \`@标签\`)。每个标签问一句:**"这一堆里还有不相关的吗?"**
   —— 重点是**清掉已经不成立的事**,不是催他做完。

3. **项目体检**。调 \`mcp__gtd__list_projects\`,挑出 \`hasActiveNextAction\` 为 false 的,
   逐个问:**"这个项目的下一步是什么?"** 说不出下一步的项目就是停滞的项目。
   问完再问一句:"这个项目现在还要推进吗?还是先放进 Someday?"

4. **等待项清扫**。调 \`mcp__gtd__list_waiting_for\`。逐条问 **"这件有回音了吗?"**;
   没回音的问"要不要催一下?"(催办 = 建一条跟进任务,只读期由他在界面上建)。

5. **Someday 分诊**。调 \`mcp__gtd__list_bucket\`(kind=someday)。逐条问
   **"这个现在想做了吗?"** —— 想做的移出来,不想做的留着(留着是正常的,不要劝他删)。

6. 结束时做一句总结:清了几条、有几个项目停滞、有几件在等人。**不要给评分,不要说教。**

## 注意

- 全程只读:所有"清掉/移动/建跟进"都由他在界面上做,你负责问对问题。
- **不要一次跑完五步**。每步之间停下来确认,他随时可以说"今天就到这"。
- 中断了也没关系:下次可以问他"上次到第几步了?",不必从头再来。

${COACHING}
`;

const BUILTIN: { name: string; body: string }[] = [
  { name: 'gtd-engage', body: ENGAGE },
  { name: 'gtd-today', body: TODAY },
  { name: 'gtd-plan-day', body: PLAN_DAY },
  { name: 'gtd-clarify', body: CLARIFY },
  { name: 'gtd-weekly-review', body: WEEKLY_REVIEW },
];

export const BUILTIN_SKILL_NAMES = BUILTIN.map((b) => b.name);

export interface SkillInfo {
  name: string;
  /** 随应用发布的五个之一 */
  builtin: boolean;
  /** 内置但被用户改过 —— 此后我们不再覆盖它 */
  modified: boolean;
  path: string;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

export function skillsDir(): string {
  return join(app.getPath('userData'), '.claude', 'skills');
}

const skillFile = (name: string): string => join(skillsDir(), name, 'SKILL.md');
const hashKey = (name: string): string => `agent.skillHash.${name}`;

/**
 * 同步内置 skill。**用户改过的不覆盖** —— 判据是"文件内容的哈希是否仍等于我们上次写下的"。
 *
 * 早先的实现是每次启动整个目录 rm -rf 再重写。那在只有内置 skill 时没问题,一旦允许用户
 * 自定义就会**删掉用户的东西** —— 这类"为了保证干净而清空"的做法,代价总是落在用户身上。
 */
export function syncBuiltinSkills(settings: SettingsLike): void {
  mkdirSync(skillsDir(), { recursive: true });
  for (const { name, body } of BUILTIN) {
    const file = skillFile(name);
    const dir = join(skillsDir(), name);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, body, 'utf8');
      settings.set(hashKey(name), sha(body));
      continue;
    }
    const current = sha(readFileSync(file, 'utf8'));
    if (current === settings.get<string>(hashKey(name))) {
      // 还是我们上次写的原样 → 可以安全更新到新版本
      writeFileSync(file, body, 'utf8');
      settings.set(hashKey(name), sha(body));
    }
    // 否则:用户改过,原样保留
  }
}

/** 目录里现有的全部 skill(内置 + 用户自建)。 */
export function listSkills(settings: SettingsLike): SkillInfo[] {
  const root = skillsDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'SKILL.md')))
    .map((e) => {
      const builtin = BUILTIN_SKILL_NAMES.includes(e.name);
      const modified =
        builtin &&
        sha(readFileSync(skillFile(e.name), 'utf8')) !== settings.get<string>(hashKey(e.name));
      return { name: e.name, builtin, modified, path: skillFile(e.name) };
    })
    .sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin ? -1 : 1));
}

export function readSkill(name: string): string {
  return existsSync(skillFile(name)) ? readFileSync(skillFile(name), 'utf8') : '';
}

export function writeSkill(name: string, body: string): { error?: string } {
  const clean = name.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clean)) {
    return { error: 'skill 名只能用小写字母、数字与连字符(它同时是目录名与调用名)' };
  }
  mkdirSync(join(skillsDir(), clean), { recursive: true });
  writeFileSync(skillFile(clean), body, 'utf8');
  return {};
}

/** 删除:内置的删不掉(会在下次启动重建);用户自建的真删。 */
export function deleteSkill(name: string): { error?: string } {
  if (BUILTIN_SKILL_NAMES.includes(name)) {
    return { error: '内置 skill 不能删除 —— 改坏了可以"恢复默认"' };
  }
  rmSync(join(skillsDir(), name), { recursive: true, force: true });
  return {};
}

/** 把某个内置 skill 恢复成随应用发布的版本。 */
export function resetSkill(name: string, settings: SettingsLike): { error?: string } {
  const b = BUILTIN.find((x) => x.name === name);
  if (!b) return { error: `不是内置 skill: ${name}` };
  mkdirSync(join(skillsDir(), name), { recursive: true });
  writeFileSync(skillFile(name), b.body, 'utf8');
  settings.set(hashKey(name), sha(b.body));
  return {};
}

export interface SettingsLike {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
}

/** 起会话时用:同步内置 skill,并把**目录里全部** skill(含用户自建)交给 SDK 启用。 */
export function skillsOption(settings: SettingsLike): { skills: string[] } {
  syncBuiltinSkills(settings);
  return { skills: listSkills(settings).map((s) => s.name) };
}
