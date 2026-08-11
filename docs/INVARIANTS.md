# INVARIANTS — GTD 业务规则全集

> **地位:唯一权威来源(Single Source of Truth)。**
> 定稿日期:2026-08-08。相关文档:[./DESIGN.md](./DESIGN.md)(架构与实现)、[./ROADMAP.md](./ROADMAP.md)(里程碑与进度)。

---

## 1. 目的与地位

原型是一个 1399 行的 Python CLI(`get_things_done.py`),实现了完整的 GTD 五阶段(Capture / Clarify / Organize / Reflect / Engage)。**该文件在本文档定稿后已从仓库删除**,其行为不再有源码可查。本文档在删除前经逐行核对源码写成,是 GTD 业务规则的**唯一权威来源**:

- **完备自足**:仅凭本文档即可重新实现全部业务行为,无需任何其他参考。
- **裁决顺序**:实现、测试、agent system prompt 与本文档冲突时,一律以本文档为准;本文档需要修改时,先改文档、再改代码。
- **测试锚点**:§3 的每条编号不变量在 `@gtd/domain` 中对应一个命名 Vitest spec(命名约定 `INV-xx-<slug>.spec.ts`,见 ROADMAP M2);§4 的流程规格是 M5 / M7 验收走查的逐条依据。
- **CLI 行为的记载口径**:文中"CLI 行为"均以删除前的工作区版本源码为准。早期行为清单与源码有两处出入,已在 §4.12 与 §4.11 的注中更正。
- 有意不沿袭 CLI 的行为列在 §5(差异表);属于 CLI 缺陷、**禁止**复刻的行为列在 §6。

术语:CLI 中的 `Action` 在桌面版称 **Task(行动)**;"next action" 指 GTD 意义上的下一步物理行动。下文实体命名一律用桌面版名称,首次出现标注 CLI 原名。

---

## 2. 领域实体与字段语义

存储层的 SQL 定义(表名、索引、FK)见 [./DESIGN.md](./DESIGN.md);本节定义**领域语义**:字段含义、默认值、约束。所有 id 为完整 UUIDv4(INV-04);所有时间戳为 ISO-8601 本地文本;所有日期为 `YYYY-MM-DD` 文本(INV-03)。

### 2.1 Context(情境)

GTD 情境即"完成行动所需的场所/工具"。**每个 active Task 必须恰好属于一个 Context**(CLI 中 context 既是 Action 字段又是存储桶键;桌面版归一为必填外键)。

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `id` | UUID | — | 主键 |
| `name` | string,唯一 | — | 必须以 `@` 开头;用户输入无 `@` 时自动补前缀;大小写敏感;重名拒绝 |
| `sortOrder` | int | 追加到末尾 | 显示顺序;**语义负载**:waiting-for follow-up 的兜底 context 取 `sortOrder` 最小者(INV-23) |
| `createdAt` | timestamp | now | — |

首次启动种子五个默认情境(顺序即 sortOrder):`@computer`、`@phone`、`@errands`、`@home`、`@office`。

### 2.2 InboxItem(收件箱条目)

CLI 中 inbox 是裸字符串数组;桌面版升级为对象(§5 差异 D-04)。

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `id` | UUID | — | 主键 |
| `text` | string | — | 原始捕捉文本,逐字保存,不解析、不去重(INV-16);重复条目合法 |
| `createdAt` | timestamp | now | — |
| `position` | int | 队尾 | FIFO 次序:捕捉与 someday 激活都追加到队尾,clarify 从队头消费(INV-17) |

### 2.3 Task(行动;CLI:Action)

"一个具体的、物理上可执行的下一步行动。"

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `id` | UUID | — | 主键 |
| `title` | string | — | CLI 字段名 `text` |
| `contextId` | UUID,**必填** | — | 恰好一个 context(GTD 纪律);context 是主要标签 |
| `estimatedMinutes` | int | **15** | 预估用时;engage 按 `estimatedMinutes <= 可用分钟` 过滤;CLI 对非数字输入回退默认值 |
| `energy` | `'low' \| 'medium' \| 'high'` | **`'medium'`** | 所需精力;比较序 low(1) < medium(2) < high(3);历史数据出现未知值时按 medium(2) 处理(INV-02) |
| `priority` | int 1–5 | **3** | ⚠ **1 = 最高,5 = 最低**(D-29 起与 Todoist 的 p1=最高**同向**,见 INV-01);越界/非法输入回退默认 3 |
| `projectId` | UUID,可空 | `null` | 所属项目;所有"项目有哪些行动"的查询**只按此字段扫描**(CLI 的 `Project.action_ids` 已废除,见 §5 D-08) |
| `deadline` | date,可空 | `null` | 最迟完成日;创建时若所属项目有 deadline 则**静默复制**(INV-10);deadline ≠ 日程(见 2.5) |
| `status` | `'active' \| 'done' \| 'deleted'` | `'active'` | `done` = 完成存档(CLI 的 `done_actions` 列表);`deleted` = 软删除进 Trash(§5 D-01)。注意:走 2 分钟规则当场完成的 Task **出生即 `done`**,从未有过 `active` 状态(INV-18) |
| `createdAt` | timestamp | now | — |
| `completedAt` | timestamp,可空 | `null` | 置为 `done` 时写入 |
| `deletedAt` | timestamp,可空 | `null` | 置为 `deleted` 时写入 |

**桌面扩展字段(2026-08-08 M5 反馈定案,CLI 无,不参与任何 CLI 不变量计算)**:

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `description` | string | `''` | 补充说明(Todoist 式 Description) |
| `scheduledDate` | date,可空 | `null` | **计划哪天做**(today/tomorrow/自选)。与 `deadline`(最迟完成日)语义互补、可并存;不进入 INV-05 活动判定、INV-20 engage 过滤排序;Today 视图口径:`scheduledDate ≤ 今天` 的 active Task 显示在"计划今天"段(过期计划自动滚入今天,见 D-19);**due 段仅收 `scheduledDate === null` 的过期截止项**——计划到未来 = 用户显式推迟(Today 拖拽"推迟到明天"),不再因过期 deadline 留在 Today,deadline 徽标仍各处标红(2026-08-09 M5R6) |
| `parentTaskId` | UUID,可空 | `null` | **子任务**(D-21):非空 = 本任务是 `parentTaskId` 所指任务的子任务。嵌套最多 **5 层**(根任务算第 1 层);子任务的 `bucket`/`projectId` 恒等于其根任务(创建时继承、随父移动,INV-25);完成父任务向下级联完成子树(D-22,INV-26)。不可执行的 task 通过拆子任务变得可执行——取代旧"子项目"机制 |
| `sortOrder` | int | **末尾** | 手动排序(D-24,INV-27):同级组(同 bucket+projectId+parentTaskId)内按 sortOrder 升序、createdAt 兜底;新建追加到末尾;拖拽重排/嵌套改写 |

### 2.4 Project(项目)

"一个需要多于一步才能达成的**期望成果**。"项目名即成果描述,编辑器中的字段标签应为 "Desired outcome",保留 GTD 框架感。

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `id` | UUID | — | 主键 |
| `outcome` | string | — | 成果描述,即项目名 |
| `deadline` | date,可空 | `null` | 继承规则见 INV-10 / INV-12(仅项目→行动) |
| `status` | `'active' \| 'complete'` | `'active'` | 完成的项目保留在表中("归档" = `status='complete'`),不删除 |
| `createdAt` | timestamp | now | — |
| `completedAt` | timestamp,可空 | `null` | 桌面版新增(CLI 无此字段) |

**已废除字段**:CLI 的 `action_ids: List[str]` 是仅追加、含悬挂 id 的簿记(见 §6 BUG-04),CLI 自身的活跃逻辑也从不信任它。桌面版**不设此字段**,一切按 `Task.projectId` / `CalendarItem.projectId` / `WaitingFor.projectId` 扫描。
**`parentId` 已废除(D-21,2026-08-09 用户定案)**:项目**平面化**,不再有子项目/项目树/深度概念——与 Todoist 一致,层级需求由**任务的子任务**承接(§2.3 `parentTaskId`)。存量子项目在迁移中直接升为顶层项目。

### 2.5 带时间任务(原 CalendarItem / hard landscape,D-23/M6a 日历统一)

**CalendarItem 实体已退役(迁移 0006)**:"绑定到具体日期/时间的承诺"如今就是**带
`startTime` 的 Task**(`scheduledDate` = 哪天,`startTime` = HH:MM,`durationMinutes` =
block 时长,null 回退 `estimatedMinutes`)。与 deadline 的语义区分仍然保持:**startTime
是在某时刻发生,deadline 是最迟完成日**,UI 上分开渲染(🕐 vs 🎯)。

保留的排序语义(原日历排序,现用于 Today 计划段与 INV-20.1):**同日内全天(无
startTime)在前、随后按 startTime 升序**。

迁移语义(0006):存量 calendar_items 逐条迁为任务(id 复用;date→scheduledDate、
time→startTime、done→status;提醒随迁重挂任务);`sourceTaskJson` 归档快照随实体丢弃
(INV-19"转换存档、永不自动复活"随之退役 —— 不再存在"任务↔日历"转换,只有同一任务
加/去时间)。

### 2.6 WaitingFor(等待项 / 委派)

"委派出去、正在等待他人的事。"

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `id` | UUID | — | 主键 |
| `description` | string | — | — |
| `delegatedTo` | string | **`'someone'`** | 受托人;输入留空时用默认值 |
| `projectId` | UUID,可空 | `null` | **未解决的等待项计入所属项目的 active next action**(INV-05) |
| `delegatedAt` | timestamp | now | CLI 字段名 `date`;显示"since YYYY-MM-DD" |
| `resolved` | bool | `false` | — |
| `resolvedAt` | timestamp,可空 | `null` | 桌面版新增 |
| `sourceTaskJson` | JSON,可空 | `null` | clarify 路由产生时保存被转换 Task 的元数据快照(§5 D-03);仅存档,永不自动复活 |

**易错语义**:follow-up(催办)行动是针对**尚未解决**的等待项创建的,创建 follow-up **不改变** `resolved` 状态(见 INV-23、§4.11 Step 4)。

### 2.7 ListItem(Someday/Maybe、Reference、Trash)

CLI 中三个裸字符串列表;桌面版统一为对象(§5 D-04)。

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `id` | UUID | — | 主键 |
| `kind` | `'someday' \| 'reference' \| 'trash'` | — | Someday/Maybe = 将来也许;Reference = 参考资料;Trash = 垃圾 |
| `text` | string | — | 归档时逐字保存 clarify 前的原始文本 |
| `createdAt` | timestamp | now | — |

- **Someday 激活**:唯一出口是移回 inbox 队尾(INV-21),绝不直达 Task。
- **Trash 视图**由两类内容组成:`kind='trash'` 的 ListItem(clarify 判定的垃圾)与 `status='deleted'` 的 Task(软删除),后者可恢复。Trash 内容永久保留,直到用户显式清空(桌面新增能力,CLI 无清空流程)。

### 2.8 完成存档(Completed)

不是独立实体:`status='done'` 的 Task + `status='complete'` 的 Project 共同构成 Completed 视图。统计口径(状态汇总):已完成行动数 = done Task 计数;已完成项目数 = complete Project 计数。

### 2.9 非不变量扩展实体(Label / Filter / Reminder / TaskComment / Conversation)

桌面版新增、CLI 不存在,定义见 [./DESIGN.md](./DESIGN.md)。TaskComment(D-21)= 任务详情内的自由评论 `{id, taskId, body, createdAt}`,仅追加展示,不参与任何不变量计算。与本文档的关系只有三条规则:

1. Label 是叠加在**必填 context 之上**的自由多值标签,不参与本文档任何不变量的计算。
2. `@waiting_for` 是由 WaitingFor 表支撑的**虚拟视图**,不得扁平化为普通 label——否则丢失 delegatedTo / since-date / resolve / follow-up 流程。
3. Filter 是保存的查询,其解释器对 energy / priority 的比较必须复用 INV-01 / INV-02 的语义。

---

## 3. 编号不变量

标注 **⚠SP** 的条目是 agent 极易出错的不变量,必须逐字固化进 agent system prompt(机制见 [./DESIGN.md](./DESIGN.md))。每条含:**规则** / **为什么** / **验收测试要点**。

### 基础语义

#### INV-01 Priority:1 = 最高,5 = 最低(D-29 翻转)⚠SP

**规则**:`priority` 取值 1–5,**1 为最高、5 为最低**,默认 3(中)。任何界面、工具、导出**都不重编号**;选择器显示文字(最高/高/中/低/最低),存储值即用户所见的档位序号。排序时**升序 = 由重到轻**。
**为什么**:2026-08-11 之前是反的(1 = 最低)。过滤器文本语法要用 Todoist 的 `p1 = 最高`,若存储仍是 5 = 最高,同一个应用里就会出现两套方向相反的数字 —— `p1` 与 `--priority=1` 恰好相反,这是必然出事的设计(用户定案:"不要让同一个应用出现两套方向相反的数字")。翻转后全链同向,`pN` 与存储值、CLI 入参完全一致,**不再需要任何转换**。
**边界**:值域(1–5)、默认值(3)、"不重编号"三条都不变;3 是对称中点,翻转后仍是"中"。迁移 v10 对存量执行 `priority = 6 - priority`,并把 `filters.query_json` 的 `priorityMin` 改名取补为 `priorityMax`。
**验收**:engage 排序中 p1 排在 p5 之前;UI 选择器选"最高"落库为 1;`pnpm cli add x --priority=1` 显示"最高";迁移后旧库里原本的"最高"仍显示"最高"。

#### INV-02 Energy 序与过滤方向 ⚠SP

**规则**:精力序 `low(1) < medium(2) < high(3)`。engage 候选过滤方向为 **`task.energy <= 用户当前 energy`**(精力充沛的人可以做低精力任务,反之不行)。存量数据出现未知 energy 字符串时按 `medium(2)` 参与比较。
**为什么**:比较方向写反是无声回归——过滤结果看似合理实则相反。
**验收**:用户 energy=medium 时,low/medium 任务入选、high 被排除;用户 energy=high 时三档全入选;energy 为未知值的任务在用户 medium 时入选。

#### INV-03 日期语义与宽容读取

**规则**:所有日期为本地 naive 文本:`deadline` / `CalendarItem.date` 为 `YYYY-MM-DD`,`CalendarItem.time` 为 `HH:MM`。排序按字典序(合法 ISO 格式下与时间序等价)。**新输入**(UI 表单、agent 写工具)必须校验格式并拒绝非法值(CLI 完全不校验,见 §6 BUG-05);**读取路径**(渲染、排序、过滤、"today"匹配)对已存储的任何非法值必须宽容——不崩溃、按字典序参与排序、UI 标记"需修正"。"today"判定 = `date === 今天的本地 ISO 日期`。
**为什么**:校验从无到有是行为收紧,只能在写入侧收紧;读取侧宽容保证任何历史/外部数据不会让应用不可用。
**验收**:写工具对 `2026-1-5` 报错;数据库中预置同样的坏值时列表仍能渲染并带"需修正"标记。

#### INV-04 ID:完整 UUIDv4

**规则**:所有实体主键为完整 UUIDv4。
**为什么**:CLI 用 `uuid4` 截断前 8 个 hex 字符、跨实体类型共享空间且无碰撞检测(§6 BUG-03)。
**验收**:生成 10^5 个 id 无碰撞(统计上平凡);schema 层主键唯一约束存在。

### 项目结构

> **D-21(2026-08-09 用户定案)**:项目**平面化**——子项目、项目树、孤儿机制全部退役(标〔退役 D-21〕的条目保留文本仅作历史依据,不再要求实现与测试覆盖)。层级由任务的子任务承接(见"子任务与评论"节)。

#### INV-05 "项目拥有 active next action" 的定义 ⚠SP

**规则**:项目 P 拥有 active next action,当且仅当以下**任一**成立(全部按 `projectId === P.id` 匹配;子任务同样携带 `projectId`,自然计入):
1. 存在 `status='active'` 的 Task(含带时间任务 —— D-23/M6a 后原"未完成 CalendarItem"分支并入此项);
2. 存在 `resolved=false` 的 **WaitingFor**。

**为什么**:时刻承诺与等待项就是项目当前的"下一步"。移植中只统计 Task 是最常见的错误(D-23 后带时间任务天然是 Task,不再有独立分支可丢)。D-21 后该判定只用于完成后的"项目已无余活动"提示(INV-14),不再驱动孤儿徽章。
**验收**:项目仅挂一条带时间的 active 任务 → `hasActiveNextAction=true`;仅挂一条未解决 WaitingFor → true;两者皆无 → false。

#### 〔退役 D-21〕INV-06 孤儿项目的定义

**规则**:孤儿 = `status='active'` 且 **无 active next action(按 INV-05)** 且 **无 active(未完成)子项目** 的项目。仅有活跃子项目、自身无直属行动的父项目**不是**孤儿。
**为什么**:GTD 要求每个活跃项目要么自己有下一步,要么由子项目推进;两者皆无即"失去动量",必须暴露给用户。
**验收**:父项目无直属行动但有 active 子项目 → 非孤儿;子项目全部 complete 且父无直属行动 → 孤儿;DDL 分解产生的无行动兄弟子项目 → 孤儿。

#### 〔退役 D-21〕INV-07 孤儿检测的触发时机与修复的征询性

**规则(CLI 基线,精确口径)**:孤儿扫描只在两处触发——
1. clarify 批处理自然结束后(进入时 inbox 为空则直接返回,**不**扫描);
2. engage 到达任务推荐阶段并处理完选择之后。engage 的 calendar-first 分支与两处"无候选"提前退出**不**触发(注:早期行为清单称 engage"总是"以孤儿检查收尾,与源码不符,以此处为准)。
weekly review、项目管理、capture 均不直接触发(review 的 Step 1 / Step 5 借道 clarify 批处理时会间接触发)。

**规则(桌面版)**:改为**常驻孤儿徽章**——每次数据变更(`gtd:changed`)重算孤儿计数并显示在侧栏;修复流程(§4.10)由用户主动发起。**修复永远逐项征询,系统绝不自动创建行动或子项目。**
**为什么**:CLI 的触发点是控制台流程的产物;GUI 可持续显示。但"征询、不自动"是 GTD 信任系统的根基,必须原样保留。
**验收**:完成某任务导致其项目变孤儿 → 徽章计数 +1(无弹窗打断);修复 sheet 中每个孤儿单独给出 定义行动/建子项目/跳过 三选。

#### 〔退役 D-21〕INV-08 项目深度无限制

**规则**:项目树深度**没有任何上限**;深度计算仅用于显示缩进。DDL 分解可任意递归。
**为什么**:CLI 从未限制深度;移植时"顺手"加上限会破坏左边缘递归分解(INV 参见 §4.9)。
**验收**:构造 12 层嵌套项目,创建、树渲染、面包屑、级联全部正常。

#### 〔退役 D-21〕INV-09 树的 re-rooting 与健康徽章

**规则**:项目树渲染时,节点作为**根**显示当且仅当:`parentId` 为空,**或** 父项目不存在(引用悬挂),**或** 父项目已 `complete`。因此完成父项目后其活跃子项目自动"升为根",漂浮子树永远可见、永不隐藏。每个节点显示健康徽章:有 active next action(INV-05)→ `✓`,否则 → `⚠`;节点下内联展示直属的 active Task / 未完成 CalendarItem / 未解决 WaitingFor,再递归渲染 active 子项目。
**为什么**:完成级联不下行(INV-13),complete 父项目下可以合法存在活跃子项目;若树按纯 parentId 渲染,这些子树会凭空消失。
**验收**:父 complete、子 active → 子渲染为根;父引用指向不存在的 id → 子渲染为根;仅挂 CalendarItem 的项目徽章为 `✓`。

### Deadline 继承

#### INV-10 行动级继承:静默复制,不询问

**规则**:创建 Task 时,若其所属项目有 deadline,则该 Task **无条件获得项目 deadline 的副本,不向用户提问,也不提供改填入口**(定义行动表单在此情形下直接跳过 deadline 一栏,仅显示"已继承项目 deadline: X"的提示)。项目无 deadline 时才询问行动自己的 deadline。
**为什么**:CLI 用两条冗余路径实现(定义行动时静默取值;clarify 收尾兜底再补一次),净效果就是"项目 deadline 默认流向其行动"。这是刻意的纪律:行动不该比项目更晚。
**验收**:项目 DDL=2026-09-01 下创建行动 → 行动 deadline=2026-09-01 且流程中未出现 deadline 输入;项目无 DDL → 出现 deadline 输入。

#### 〔退役 D-21〕INV-11 项目级继承:三条路径,征询程度不同

**规则**:子项目获得父项目 deadline 的三条路径:

| 路径 | 触发场景 | 继承方式 |
|---|---|---|
| a. `suggestParent` 建议式 | 完成后追问 / 孤儿修复 / 项目管理里"在 X 下加子项目" | 用户确认作为子项目后,若未填 deadline 且父有 → **自动继承,仅提示不询问** |
| b. "属于某现有项目"选择式 | clarify 中新建项目、选择挂到某父项目 | 若未填 deadline 且父有 → **显式询问**"继承父 deadline (X)?",同意才继承 |
| c. DDL 分解 | §4.9 逐个录入子项目 | 每个子项目单独询问 DDL,**留空 = 继承父项目 deadline** |

**为什么**:a 场景中父子关系是流程明示的,追加确认是噪音;b 场景中父项目是用户临时挑的,deadline 继承需明示同意;c 场景留空即继承是录入效率设计。
**验收**:三条路径各一 spec,断言继承发生与否及是否出现确认问句。

#### INV-12 继承是 copy-on-create;编辑时一次性提示传播

**规则**:deadline 继承(项目→行动,INV-10)是**创建/挪入时复制**,不是活引用——之后修改项目 deadline **不会自动**改动任何行动的 deadline。桌面版新增编辑能力(CLI 完全没有编辑流程),因此补充规则:**编辑项目 deadline 时,一次性提示"同步更新 N 个与旧值相同的行动 deadline?"**,用户确认才批量更新;拒绝则只改自己。agent/CLI 路径同理:仅在显式传 `propagateDeadline: true` 时传播。(D-21 后不再存在子项目继承。)
**为什么**:copy 语义是 CLI 的既成事实;编辑是新能力,必须显式决定传播问题,否则要么静默失联(用户以为会跟着改)要么静默批改(用户不知道改了别人)。
**验收**:改项目 DDL 时弹一次性提示且 N 计数只含"当前值等于旧值"的行动;拒绝后行动 DDL 不变;不带 flag 时行动不变。

### 完成与级联

#### 〔退役 D-21〕INV-13 完成级联:仅向上、逐级征询、拒绝即停;父完成不下行

**规则**:
1. 子项目完成时,若其父项目的**全部**子项目(含早已完成的)都已 complete,则**询问**"把父项目也标记完成?";同意 → 标记并对祖父**递归同样的询问**;拒绝 → 父保持 active,级联终止。
2. 若兄弟未全完成 → 级联直接结束。(CLI 源码在此有一个"父项目没有下一步"的警告分支,但其进入前提"存在未完成子项目"按 INV-05/INV-06 的定义蕴含父必有 active 子项目,与其守卫"无 active 子项目"**逻辑矛盾——该分支不可达**。新实现可保留为防御性断言或省略,**不得**为其编写行为测试,见 §4.8。)
3. **不存在向下级联**:完成父项目不改变任何子项目或行动的状态(其活跃子项目按 INV-09 re-root 显示)。
4. **系统在任何情况下都不自动标记完成。**
**为什么**:GTD 的信任来自用户对每次状态变化知情且同意;自动连锁完成会让系统不可信。
**验收**:三层链 A>B>C,完成 C 且 B 无其他子项 → 弹"完成 B?";同意后弹"完成 A?";拒绝 A → A 仍 active;直接完成 A → B、C 状态不变且 B 在树中为根。

#### INV-14 完成后果提示(D-21 修订:后果返回,不弹向导)

**规则**:完成挂在项目下的 Task / CalendarItem 时,写路径的 **consequences** 必须携带项目状态:`projectHasRemainingActivity`(项目仍有余活动,INV-05 口径)或 `parentCompletionCandidate`(项目已无余活动——**提示**用户可以完成项目)。呈现载体为轻量提示(UI toast / CLI 输出文本 / agent 后果字段),不再有向导式追问链。守卫:目标项目已 `complete` 或任务无项目 → 三字段全部缺席(§6 BUG-02)。
**边界**:resolve WaitingFor **不是**入口——resolve 不触发任何完成后果提示(CLI 语义,保持)。
**为什么**:"项目不会在用户不知情时失去动量"的保证保留,但按 D-20/D-21 去仪式化——系统提示、用户决定,绝不自动完成(INV-15)。
**验收**:完成项目最后一个活跃行动 → consequences 含 `parentCompletionCandidate=true`;项目还有别的活跃项 → `projectHasRemainingActivity=true`;项目已 complete → 空对象;任何路径都不自动完成项目。

#### INV-15 征询原则与 agent 后果返回约定

**规则**:系统(UI 或 agent)**绝不自动**创建、完成、删除任何实体;一切级联、修复、生成都以问句/提示呈现,等待用户明确同意。**例外(D-21/D-22,用户单次动作的完整语义,不算"自动")**:移动带子任务的任务 = 整棵子树随动;软删除带子任务的任务 = active 子树级联软删(UI 确认文案带数量);**完成带子任务的任务 = active 子树级联完成(D-22 向下,UI 完成控件 hover 提示数量而非弹确认)**。这些都是单次动作在子树上的完整语义,不是系统自作主张。agent 路径的执行机制:**所有写工具返回 consequence 字段**(`parentCompletionCandidate`、`inheritedDeadline`、`projectHasRemainingActivity`、`completedSubtaskCount` 等,全表见 [./DESIGN.md](./DESIGN.md)),agent 读到后果后必须**先向用户提问、获同意后再发起下一次工具调用**,与 CLI 的 y/n 征询完全同构。
**为什么**:agent 若把"最后一个子项目完成"自动升级成"顺手把父项目也完成了",信任即崩塌。
**验收**:coaching eval(见 ROADMAP M10)断言 `complete_task` 返回 `parentCompletionCandidate` 后,agent 的下一动作是向用户提问而非直接调 `complete_project`。

### 流程纪律

#### INV-16 捕捉零判断

**规则**:capture 只做一件事:把原始文本追加到 inbox 队尾。不解析、不分类、不去重、不询问任何元数据。重复内容合法。
**为什么**:"先倒空大脑、后处理"是 GTD 第一原则;捕捉路径上任何摩擦都会导致漏记。
**验收**:连续 capture 两条相同文本 → inbox 出现两条;capture 不弹任何后续表单。

#### INV-17 一次用户决定 = 一个命令批 = 一个事务(D-21 修订载体)

**规则**:usecase 把一次用户决定的**全部**产物作为**单个 command 批**返回(例:软删带子树的任务 → 整棵子树的 updateTask 在同一批;quick add 带 label/提醒 → createTask+assignLabel+createReminder 同批),宿主(`store.apply`)将该批**原子应用**(一个 SQLite 事务,全成或全败)。进程中途被杀:已提交决定的产物完好、进行中的决定无半成品实体。(历史形态"clarify 批处理逐条目事务"随向导退役,原子性纪律不变。)
**为什么**:CLI 单条目处理中途有多次整文件落盘,崩溃可致重复处理、产生重复实体。命令批事务是对 CLI 的**收紧**,不是复刻。
**验收**:级联软删 usecase 返回的批含子树全部命令(不分两次);storage 契约测试断言批中间注入非法命令时整批回滚。

#### 〔退役 D-21〕INV-18 2 分钟规则

**规则**:路由选择"现在就做(< 2 分钟)"且用户确认完成的行动,**从不进入 next actions 列表**——Task 以 `status='done'`、`completedAt=now` 直接落库(出生即完成),随后触发完成后追问(INV-14)。若用户没做完,则按普通 next action 落入其 context 列表。
**为什么**:两分钟内能做完的事,管理它的成本高于做掉它。
**验收**:do-now + 完成 → 库中该 Task 无任何 `active` 历史;do-now + 未完成 → 出现在对应 context 的 active 列表。

#### 〔退役 D-21〕INV-19 路由到 Delegate / Calendar:实体转换 + 快照保留

**规则**:clarify 中把已定义的行动路由到 Delegate 或 Calendar 时,**不落库 Task**,而是创建 WaitingFor(`description=行动文本`、`delegatedTo`、`projectId`)或 CalendarItem(`title=行动文本`、`date/time`、`projectId`)。CLI 在此丢弃行动的全部元数据(context、estimatedMinutes、energy、priority、deadline);桌面版把这些元数据序列化进 `sourceTaskJson` 快照保存(§5 D-03),但**该快照仅作存档,系统永不自动用它复活 Task**(用户日后可显式"转回行动")。
**为什么**:委派出去的事和定了时间的事在 GTD 里就不再是 next action;但用户逐项填写的元数据白白丢弃是 CLI 的缺陷。
**验收**:路由到 delegate → 无新 Task 落库、WaitingFor.sourceTaskJson 含五项元数据;无任何后台任务读取 sourceTaskJson 生成实体。

#### INV-20 Engage 过滤、排序与 calendar-first ⚠SP(过滤方向)

**规则**:
1. **Calendar-first(D-23/M6a 版)**:进入 engage 先列出**今天计划**(`scheduledDate === today`)的全部 active 任务,按 §2.5 时刻序(全天在前、startTime 升序,`todaysTimedTasks`);有则优先提议处理。该段是**当天硬性日程,与所选 context 无关**,故不随 context/分钟/精力过滤(agent skill 与 CLI `engage --context` 同此口径)。
2. 任务推荐:选定 context 后,候选 = 该 context 的 active Task,依次过滤 `estimatedMinutes <= 可用分钟`(默认 60)与 `energy <= 用户 energy`(INV-02)。
   **INV-20.2**:第 1 条已列出的(`scheduledDate === today`)**不再进候选** —— 已承诺的事轮不到"挑",两处都列只会让同一条任务在一轮择事里出现两次。过期计划(`scheduledDate < today`)不属该段,仍可挑。
3. 排序:**priority 降序**,稳定排序(同优先级保持创建序);**最多展示 7 条**(`ENGAGE_TOP_N`)。
4. **deadline 不参与排序**,仅随行显示(CLI 的已知留白,如需改变先改本文档)。
5. 推荐是只读计算;完成任务是独立的写操作(agent 工具 `get_engage_recommendations` 为只读,完成走 `complete_task`)。
6. **单一过滤口径**:全部匹配项由 `engageMatches` 给出,候选 = 其前 7 条,"另有 N 条未列出"= `matches.length - 7`。任何载体(CLI `engage`、agent skill、将来的任何 UI)都不得自行重写这套过滤条件——曾因桌面 `views.engage` 与 CLI 各写一遍,使"另有 N 条"与列表口径不一致(该面板已随 D-28 撤除)。
**为什么**:GTD 的四标准择事模型(情境→时间→精力→优先级),顺序即算法。
**验收**:8 条同 context 候选 → 只显示 7 条且为 priority 前 7;30 分钟可用时 45 分钟任务被过滤;今天有计划任务(含带时间)时先按时刻序呈现它们,且这些任务不在候选段重复出现;`pnpm cli engage` 与 agent skill 同参数下候选与"另有 N 条"完全一致。

#### INV-21 Someday 孵化语义(D-20/D-21 修订)⚠SP

**规则**:`bucket='someday'`(与 `'reference'`)的任务处于**孵化**状态——不进入 Today 口径、不进入 engage 候选;激活 = 用户显式 **moveTask** 到任意其他容器(Inbox/项目),移动后立即恢复参与一切口径。系统**永不自动**把 someday 任务移出或注入行动清单。
**为什么**:躺了几个月的想法必须由用户亲手拉回;但 D-20 容器模型下"回 inbox 重走 clarify"的强制路径已由"移到哪都行"取代——移动本身就是理清。
**验收**:someday 任务不出现在 Today/engage 候选;move 到 inbox 后重新出现;无任何代码路径自动改 someday 任务的 bucket。

#### INV-22 删除 = 软删除,可恢复(D-21 修订载体:右键删除)

**规则**:任何入口(右键菜单、CLI `delete`、agent 工具)删除 Task 均为软删除:置 `status='deleted'`、`deletedAt=now`,数据保留、可恢复(restoreTask 回 `active` 并清 `deletedAt`;context 已归档时须先重指 context)。(CLI 前身是硬删除、无去处,§5 D-01;D-20 后无 Trash 视图,但数据层语义不变。)
**为什么**:硬删除危险且无必要;误操作率高。
**验收**:删除的任务 `status='deleted'` 仍在表中;恢复后 `status='active'`、`deletedAt` 清空;重复删除报错。

#### INV-23 Waiting-for follow-up 模板

**规则**:对**未解决**的 WaitingFor 创建催办行动,字段固定为:

| 字段 | 值 |
|---|---|
| `title` | `Follow up with {delegatedTo} re: {description}` |
| `contextId` | 名为 `@phone` 的 context;不存在则取 `sortOrder` 最小的 context |
| `estimatedMinutes` | 5 |
| `energy` | `'low'` |
| `priority` | 4 |
| `projectId` | 继承 WaitingFor 的 `projectId` |
| `deadline` | 无 |

创建 follow-up **不改变** WaitingFor 的 `resolved` 状态(催办的对象正是还没回音的委派)。
**为什么**:固定模板让"追一下"零成本;follow-up 与 resolve 解耦是 CLI 的明确语义,捆绑会把"催办"误变成"已解决"。
**验收**:对未解决项创建 follow-up → 新 Task 六字段逐一匹配、WaitingFor 仍 unresolved;无 `@phone` 时 context 落到 sortOrder 最小者。

#### INV-24 Context 规则

**规则**:
1. 名称必须 `@` 前缀,输入无前缀自动补;重名(精确匹配)拒绝。
2. 每个 active Task 必须恰好属于一个存在的 context(FK 保证;CLI 靠"load 时自愈失散桶 + 写入时自动建桶"达到近似效果,归一化存储后该自愈机制不再需要)。
3. **不能删除最后一个** context。
4. 删除含 active Task 的 context 必须先警告数量并确认;确认后这些 Task 软删除进 Trash(CLI 是随桶永久删除,§5 D-09),恢复时需重新指定 context。
5. context 可在任何选择器中内联新建(clarify 定义行动、quick add 等),新建即持久化。
**为什么**:context 是 GTD 的物理过滤维度,也是历史存储桶;规则 3、4 防止用户一键蒸发整张行动清单。
**验收**:输入 `gym` → 存为 `@gym`;重复添加报错;仅剩一个 context 时删除按钮禁用;删除含 3 个活跃任务的 context → 确认文案含数量、任务进 Trash。

### 子任务与评论(D-21,2026-08-09 用户定案)

#### INV-25 子任务:深度 ≤ 5,容器与根一致、随根移动

**规则**:
1. `parentTaskId` 链最深 **5 层**(根任务 = 第 1 层);创建第 6 层子任务必须被拒绝。
2. 子任务创建时继承父任务的 `bucket` / `projectId` / `contextId`(deadline 按 INV-10 对项目照常继承);任务的整棵子树 `bucket`/`projectId` 恒一致。子任务支持与顶层任务**相同的属性集**(description/scheduledDate/deadline/priority/labels/reminders,D-22):添加子任务用与添加任务相同的表单,默认继承父的位置与 context。
3. **移动根任务(moveTask)= 整棵子树随动**(bucket/projectId 级联更新;这是用户单次动作的完整语义,见 INV-15 例外)。
4. 对**子任务**执行 moveTask = 先脱离父任务(`parentTaskId=null`,连同其自身子树)再移动,consequences 须含 `detachedFromParent: true`。
5. 父任务引用必须存在且非 deleted;不允许成环(链式校验天然防环)。

**为什么**:Todoist 心智——不可执行的 task 拆成 subtask,而不是升格成子项目;容器一致性保证任何视图(Inbox/项目/Someday)看到的子树是完整的。5 层与 Todoist 上限一致,防状态爆炸。
**验收**:第 5 层可建、第 6 层报错;移动带子树的根到项目 → 全子树 projectId 更新且无 deadline 的成员按 INV-10 获得项目 deadline;移动子任务 → 脱离原父、consequences 标记。

#### INV-26 子树完成/删除纪律(D-22 修订:完成向下级联)

**规则**:
1. **完成向下级联(Todoist 语义,D-22,2026-08-09 用户定案)**:完成父任务 = **同时完成其整棵 active 子树**(所有 active 后代一并 `status='done'`、`completedAt=now`,同一命令批一个事务)。completeTask 的 consequences 含 `completedSubtaskCount`(随本次一并完成的 active 后代数)。方向**仅向下**:完成一个子任务**不**改变父任务状态(勾子任务不勾父任务)。这是"用户单次动作的完整语义"(见 INV-15 例外),UI 须在完成控件上 **hover 提示**"将连同 N 个未完成子任务一起完成"以防误操作,但不弹确认对话框。
2. **软删级联**:软删除父任务时其整棵 **active** 子树一并 `status='deleted'`(consequences 含 `deletedSubtaskCount`;done 后代**保留** done 不动,完成记录/项目进度不受影响);恢复时逐个恢复(不级联),恢复"删除前已完成"的任务回 `done`(保留 `completedAt`)。

**为什么**:D-22 前"完成不级联"导致完成父任务后活跃子任务悬空在视图外(项目视图看不见但仍计入徽章);Todoist 的向下级联符合"父任务代表整件事"的直觉——勾掉它即勾掉全部。方向仅向下是 Todoist 一致的:勾子任务不代表父任务完成。删除级联只动 active、保留 done,避免洗掉完成历史。
**验收**:完成带 2 个 active 子任务的父任务 → 3 个任务全 done、consequences.completedSubtaskCount=2;完成一个子任务 → 父任务仍 active;软删带 1 active + 1 done 子任务的父 → active 子任务与父 deleted、done 子任务保持 done、deletedSubtaskCount=1;恢复删除前已完成的任务 → 回 done 且 completedAt 不变。

#### INV-27 手动排序与拖拽重排/嵌套(D-24,2026-08-09 用户定案)

**规则**:
1. `Task.sortOrder: number`。同一"同级组"(相同 `bucket` + `projectId` + `parentTaskId` 的非删除任务)内按 `sortOrder` 升序、`createdAt` 升序兜底排序;比较器**反对称**(全等返回 0)。所有列表/树视图与 CLI 一致采用此序。新建任务(capture / quickAdd / addSubtask / follow-up)追加到目标同级组末尾;其中**顶层追加**(capture / quickAdd / follow-up / moveTask 落入容器)用 `nextRootSortOrder` —— 取**容器展示根集**(`isTaskListRoot`,含父已 done/deleted 的孤儿子任务根)的最大 `sortOrder` + 1,避免孤儿根的 `sortOrder` 与顶层组撞值导致"追加到末尾"语义失效;子任务追加(addSubtask)用父组 `nextSortOrder`。
2. **拖拽重排**(reorderTask):把任务移到**同一容器内**新位置或新父任务下。语义 = 设 `parentTaskId`(可空 = 顶层)+ 在目标同级组按落点重排 `sortOrder`(整组重编号一个事务)。约束:目标父任务须 active、与被移动任务**同 bucket/projectId**(跨容器仍走 moveTask);**不得成环**(新父不能是自身或自身后代);**深度** `taskDepth(新父) + subtreeHeight(被移动任务) ≤ 5`(INV-25);违反则拒绝(返回 error)。`beforeId === 自身`视为**无锚点(追加到末尾)而非报错**(拖回原位/微移是无副作用手势)。顶层组(parentTaskId=null)以**展示根集**为准(isTaskListRoot 且 active,含孤儿根),与渲染层/追加口径一致。**改父仅在两种情形**:落到具体父下(显式嵌套),或任务当前嵌套显示中(有活跃父)落到顶层(outdent);**孤儿根**(父仅 done)本就作顶层行显示,顶层重排只改排序、**保留其父链接**(父 reopen 后自然回归,INV-26 契约)。被移动任务的整棵子树随其移动(bucket/projectId 不变,因同容器)。
3. moveTask(跨容器)把任务落到目标容器时,`sortOrder` = 目标容器展示根集最大值 + 1(`nextRootSortOrder`,排到末尾)。
4. **UI 交互(Todoist 式,2026-08-09 用户定案 v2)**:任务树以**扁平行 + 缩进**呈现;拖拽中**被拖块搬到落点渲染成半透明占位行**(Todoist 式):列表高度不变(不会因整段抽走而塌陷、底下的行与「+ Add task」上跳,那会逼得"向右缩进"变成"向右上拖"),且占位行跟着落点走,**蓝线永远画在占位行上沿**(不会时上时下)。落点几何在起拖时冻结一次,否则占位行一动、实时测量就会自反馈横跳(2026-08-10 用户两次复现);拖拽时**上下拖 = 换位**(在候选行间隙插入,live 蓝线指示落点),**向右拖 = indent**(缩进,挂到上一行下作子任务),**向左拖 = outdent**(返回上层)。缩进层级由**水平位移**(相对起拖点)决定,并在该间隙的 `[minDepth, maxDepth]` 内夹取(`maxDepth = min(上一行 depth+1, 5-被拖子树高度)`,`minDepth = 下一行 depth`);不再需要"拖进方框中间"来嵌套。落点解析出 `{parentTaskId, beforeId}` 交由 reorderTask;候选集**排除被拖子树**,故 `beforeId`/`parentTaskId` 永不等于自身。

**为什么**:GTD/Todoist 都需要用户手排优先次序;拖拽既可换位也可拖成子任务。约束沿用 INV-25(深度 ≤5、不成环、容器一致)。整组重编号避免浮点/碰撞。水平位移控制缩进比"拖进方框"更符合直觉(用户反馈)。
**验收**:拖 A 到 B、C 之间 → A.sortOrder 落在 B、C 之间、列表顺序随之变;向右拖 A(在 B 之下)→ A.parentTaskId=B 且排在 B 子任务末尾;向左拖回 → 返回上层;把三层子树拖到会超 5 层的父下 → UI 夹取阻止 + reorderTask 兜底拒绝;拖到自身后代下 → 候选集已排除;跨 bucket 拖拽被拒(跨容器用 Move to);拖回原位 → 无 toast、无副作用。

#### INV-28 日历网格口径与交互(D-23/M6b,2026-08-10 用户定案)

**规则**(纯规则在 `rules/calendarGrid.ts`)。**共用边界**:CLI 与主进程 VM **直接调用**这些函数;渲染层按 DESIGN §4.1 **禁止 import 内层包**,只能保持**镜像实现**(`CalendarView.tsx` 顶部的 `QUARTER_MIN` / `blockMin` / `blockFromDrag` / `endLabel` 与本模块同名同义),**改动须同步两处** —— 判定规则本身只在 domain 定义一次并由测试固定:

1. **上日历的任务**:`scheduledDate` 命中该日 ∧ 非 `deleted` ∧ bucket 非 someday/reference(孵化不占日程)。**完成的任务仍留在日历上**,只显示为完成态(D-23 用户定案:完成不从日历移除;将来 Google 同步同理)。`startTime` 非空但 `scheduledDate` 为空 → **不上日历**(时刻须与日期搭配)。
2. **两段**:`startTime === null` = **全天段**;`startTime !== null` = **定时段**(按 startTime、createdAt 兜底)。**两段都不按 `sortOrder` 排** —— sortOrder 只在同级组(bucket+projectId+parentTaskId)内有定义(INV-27),跨容器比较会让别处的拖拽排序改变日历顺序、并与 Today 相互矛盾;全天段与 Today 计划段一致,按 `createdAt`。
3. **刻度**:拖拽/拖选吸附到 **5 分钟**(`SNAP_MINUTES = 5`,2026-08-10 用户改定,原为 15 分钟四等分;更细的时刻如 09:07 只能在任务详情里直接填)。按下-拖动-松手由 `blockFromDrag` 统一判定:**竖直位移不足一个刻度 = 单击** → 默认 **30 分钟**块(00→00:00-00:30、15→15-45、30→30-60、45→45-次时 15,用户口径);否则取拖选区间 —— start 向下吸附、end 向上吸附,**最短一个刻度**,末端**钳到 24:00**(block 不跨午夜;展示用 `endTimeLabel`,1440 显示 `24:00` 而非 23:59)。UI 另有**像素阈值**(4px)判定单击 vs 拖动:块的 startTime 未必落在刻度上,只比较吸附后的值会把 1px 抖动误判成拖动,把"点开详情"变成静默改时间。
4. **block 时长**:显式 `durationMinutes` 优先,为空则回退 `estimatedMinutes`;渲染高度按此计算。
5. **交互能力(2026-08-10 用户定案)**:**已完成的任务在日历上完全锁死** —— 不可拖动、不可拉伸、左键点击无效(先右键「撤销完成」再操作),避免手滑改动已经收尾的事;**外部镜像任务**(INV-29)不可拖动/拉伸(时间归外部),但**左键可点开详情**,在那里改优先级/标签/完成。全天块与定时块同规则:同样支持**右键菜单**,且全天块**可拖回时间轴**设定时刻。拖动/拉伸的**预览**与落库同公式(都按 5 分钟吸附),不显示 11:33 这类中间态。
6. **落点纪律**:拖动只在落点位于**时间网格可视区内或全天条上**时才写库,落到表头/工具栏/窗口别处一律丢弃(否则会按滚动位置外推出一个无关时刻);拖拽中按 **Esc 取消**,不落库。
7. **写语义**(全部走既有 usecase,日历无新写路径):网格建块 = `quickAddTask({scheduledDate, startTime, durationMinutes})`;拖动块 = `updateTask({scheduledDate, startTime})`(跨列即改日期);拉伸块 = `updateTask({durationMinutes})`;拖到全天段 = `updateTask({startTime: null, durationMinutes: null})`;**删除 block = 软删该任务**(INV-22),因为 block 与任务是同一实体(D-23)。

**为什么**:D-23 把日历事件与任务统一后,"日历"只是任务按 `scheduledDate + startTime` 的另一种投影,不能再有独立实体或独立写路径;把吸附/区间/分段做成 domain 纯函数,才能让 UI 与 CLI(以及将来的 Google 映射)口径一致。
**验收**:点 09:20 → 建 `09:15` 起 30 分钟任务;拖选 14:00–15:30 → 90 分钟;23:45 起拖到次日 → 截断为 15 分钟;单击块(含 startTime 非刻度对齐的块)→ 只开详情、不改数据;拖到网格外松手 → 无变化;完成的块仍显示(完成态);someday/已删/未计划任务不出现;CLI `calendar` 与网格同序同内容,且与 `today` 的当日顺序一致。

#### INV-29 外部日历镜像为任务(D-25/M6c-3a,2026-08-10 用户定案)

**规则**:显示中的 Google 日历,其事件**镜像为本地任务**(`Task.externalId` 非空,形如 `google:<账号>:<日历id>:<事件id>`,全局唯一;`externalCalendarId` 供着色与随日历显隐)。

1. **一视同仁**:镜像任务就是任务 —— 可完成/撤销完成、加优先级/标签/评论/子任务、移动到项目、参与 Today 与 engage。**唯一例外是不能改期**。
2. **外部拥有的字段**:`title` / `scheduledDate` / `startTime` / `durationMinutes` 只由同步写入;`updateTask` 对这些字段**明确报错**(而非静默丢弃),提示去 Google 日历改。
3. **永不回写**:本地的一切改动(完成、标签、备注……)都**不推送**到 Google。反向同步(任务 → Google)只发生在 M6c-3b 的专用 `Claudoist` 日历上,与镜像任务无关。
4. **失败闭合**:退休(软删)判定只在**本轮成功拉取的日历**上进行;任何一个日历/账号拉取失败就整轮跳过退休 —— 否则一次断网会把窗口内所有镜像批量软删,恢复后再重建成丢了标签/子任务/评论的空白任务(2026-08-10 评审 HIGH)。被退休的镜像若再次出现,**复活原任务**而非新建(既撞 `external_id` 唯一索引,也会丢本地状态)。专用 `Claudoist` 日历是本应用的**写入面**,必须排除在镜像源之外,否则推上去的事件会被再镜像成重复任务。
5. **同步语义**(`syncExternalTasks`,幂等):窗口内事件 → 不存在则建、存在则**只更新外部拥有的字段**(状态/优先级/标签绝不被覆盖,否则重同步会抹掉用户勾的完成);窗口内、本次未出现的镜像 = 外部已删 → **未完成的软删,已完成的保留作历史**;窗口外的镜像不动。
6. **独立容器 Upstream**:镜像任务归入 **Upstream** 容器(而非 Inbox)—— Inbox 只装"**还没落实的**想法",这些是已经排进日历的承诺,混在一起会把收件箱淹没(2026-08-10 用户定案)。Today/Calendar/Completed 照常包含它们。**该容器 2026-08-11 起不在侧栏露出**(条目太多、计数徽章长期是个大数字,喧宾夺主):镜像任务本就在 Calendar/Today 上各就各位,容器视图保留,经 ⌘K 命中可达。

**为什么**:用户要的是"日历上的事也能在 GTD 里勾掉",只读展示层做不到(不能完成、不能加备注)。把时间的所有权留给 Google、把执行状态留给本地,既满足需求又不会把我们的状态污染到共享日历上。
**验收**:Google 里建的事件出现在 Today/Calendar 且可勾完成;勾完成后重新同步仍是完成;在应用里改它的时间被拒并提示;在 Google 里改时间 → 应用里跟着变;Google 里删掉未完成的 → 应用里消失,已完成的仍在 Completed;Inbox 里不出现这些事件。

#### INV-30 任务 → 专用 Claudoist 日历的双向同步(D-26/M6c-3b,2026-08-10 用户定案)

**规则**:本应用**只写自己创建的那一个日历**(名为 `Claudoist`,用 `calendar.app.created` scope 创建;用户的主日历与其它日历我们连写权限都没有)。

0. **默认关闭,显式开启**:推送由设置页开关控制(`google.pushEnabled`,默认 `false`)。**往用户的 Google 账号里写任何东西都必须是用户明确选择的** —— 2026-08-10 曾做成常开,用户发现账号里凭空多出一个日历和 10 个事件。关闭时提供"一并撤下已推送事件"的选项(否则会留下永不更新的僵尸事件)。

1. **推送口径**:`externalId` 为空(非镜像)、非 deleted、**已排期**(`scheduledDate` 非空)的任务 → 该日历上的一个事件。有 `startTime` 推成定时事件,否则推成全天事件(`end.date` 独占 +1 天)。事件带 `extendedProperties.private.claudoistTaskId` 以便回认。
2. **指纹去重**:`pushedFingerprint`(标题|日期|时刻|时长|状态)未变则**跳过 API 调用** —— 否则每轮轮询都会把整张日历重写一遍。推送成功后写回 `pushedEventId` + 指纹。
3. **完成不删除**:已完成的任务**仍留在日历上**(标题前缀 `✓`),只是不再需要注意力(用户定案:完成不从日历/Google 移除)。
4. **撤下**:任务被删除或取消排期 → 删除对应事件并清账(`pushedEventId=null`)。
5. **回同步**(Google → 任务):在该日历里**拖动/改时长** → 任务改期;**删除 block** → **软删任务**(这是唯一会传播删除的路径)。删除必须**实证**(逐个 `events.get`,404/410/`cancelled` 才算),**不得用"本轮窗口里没看见"推断** —— Today 视图窗口只有一天,把 block 拖到明天就会被误判成删除(2026-08-10 评审 HIGH)。对账一律用 Google **原始事件 id**(全天事件在读取侧被逐日展开成 `id:日期`,拿它比对会让每个全天任务在推送后自毁)。**本地有未推送成功的改动**(指纹与 `pushedFingerprint` 不一致)时本轮**本地优先**,不接受回拉,否则一次推送失败就会让旧值永久覆盖用户的改期。**已完成的任务不因日历改动而改期或复活**,删其 block 只清账、保留完成历史。
6. **镜像任务永不回推**(INV-29):`externalId` 非空的任务不进推送计划,也不受本日历回同步影响。
7. **domain 不发网络请求**:`planPush` 只算计划、`applyPulledEvents` 只算命令,真正的 HTTP 在主进程;推送结果经 `recordPushed` 记账。

**为什么**:双向同步必须有明确的"谁拥有什么"。外部日历的事件时间归 Google(INV-29),我们自己的任务时间归本地 —— 但用户在 Google 里拖动我们推上去的 block 也是一种合法输入,所以那一个日历(且仅那一个)是双向的。指纹与"只写自建日历"这两条,分别防住了 API 配额浪费与"污染别人日历"的风险。
**验收**:给任务设日期 → `Claudoist` 日历上出现事件;改时间/标题 → 事件跟着变;勾完成 → 事件标题变 `✓ …` 且仍在;取消排期或删除任务 → 事件消失;在 Google 里拖动该 block → 应用里任务改期;在 Google 里删掉该 block → 应用里任务进 Trash;镜像任务不出现在 `Claudoist` 日历里。

#### INV-31 时区:浮动时间 vs 指定时区(D-27/M6d,2026-08-10 用户定案)

**规则**:`Task.timeZone`,`null` = **浮动时间**(默认),否则为 IANA 时区名。

1. **浮动**(与本仓一贯的 naive 时刻语义一致,INV-03,也是 Todoist 的 Floating time):墙上几点就是几点,**换时区不换算**。推送到 Google 时**不带 `timeZone` 字段**,由该日历的默认时区解释;回拉时**直接读 RFC3339 字符串里的字面墙上时间**,不经 `Date` 换算 —— 换算会在旅行时把它挪走。
2. **指定时区**:该时刻钉在这个时区上。推送时带 `timeZone`;回拉时把绝对时刻**换算到该时区**的墙上时间(`Intl.DateTimeFormat` + `timeZone`,不引第三方库)。
3. **时区参与推送指纹**:只改时区也必须重推,否则 Google 上仍是旧解释。
4. **镜像任务的时区归外部**(INV-29):`timeZone` 与标题/时刻/时长一样不可本地修改。
5. 写入侧校验时区名有效性(Intl 判定),非法即拒。

**为什么**:我们存的一直是 naive 本地时刻 —— 语义上就是浮动时间;但此前推送时钉上了本机时区,等于把浮动时刻偷偷变成绝对时刻,用户跨时区后应用与 Google 会对不上。把这件事显式化(默认仍是浮动,想钉死再选时区)既保持既有语义,又让跨时区可控。
**验收**:默认新建的带时刻任务显示「浮动时间」;推到 Google 后在另一时区打开应用,墙上时间不变;选定时区的任务跨时区会换算;只改时区会触发一次重推;镜像任务的时区改不动。

#### INV-32 搜索口径(M7a,2026-08-11)

**规则**:`searchAll` 是 ⌘K 与 CLI `search` 的**唯一**数据源。

1. **覆盖**:任务(`title` + `description`)、项目(`outcome`)、等待项(`description` + `delegatedTo`)。匹配 = 大小写不敏感**子串**,不分词、不模糊。
2. **容器口径(D-20/D-21/D-23)**:Inbox / Someday / Reference / 项目任务 / 日历块**都是带 `bucket` 的 Task**,统一在 `tasks` 一组返回,由调用方按 bucket 分组呈现。**不得**再读 D-20 之前的 `snap.inbox` / `snap.listItems` —— 那两张表自容器模型起零写入,照旧读它等于这些内容根本搜不到(2026-08-11 修复)。
3. **已完成可搜**(归档要能回溯),排在活跃之后;**软删除不返回** —— 删除虽可恢复(INV-22),但当前没有恢复入口,给一条点不动的结果不如不给。有了 Trash 视图再放开。
4. **排序**:活跃优先 → 标题命中优先于仅描述命中 → `createdAt` 倒序 → id(全序,保证稳定)。
5. **截断**:按 `limit`(默认 50)分类截断;`totalMatched` 始终是**截断前**的总数。
6. **单一口径**:桌面 ⌘K 与 CLI `search` 都不得自行过滤或排序(同 INV-20.6 的纪律)。呈现差异只允许出现在"列不列"上——面板不列等待项,因为桌面没有等待项视图,点了无处可去。

**为什么**:搜索是找回东西的最后手段;口径含糊、分组恒空,等于数据在用户眼里丢失了。
**验收**:someday/reference 容器里的任务能被搜到;已删除的搜不到;已完成的排在活跃之后且有明确标记;只在描述里出现的关键词能命中;`limit` 截断后 `totalMatched` 仍为总数。


---

## 4. 流程规格

以下伪代码即验收走查脚本。标注 **[TX]** 的步骤必须作为一个事务原子提交;标注 **[TX/项]** 的循环必须逐项提交(每项一个事务)。交互式流程实现为 `@gtd/domain` 的纯 reducer 状态机(`FlowState + answer → { nextState, question, commands[] }`),UI 与 agent 驱动同一状态机(见 [./DESIGN.md](./DESIGN.md))。所有向导在提交前均可自由后退(逐项事务使得未提交状态无副作用);**跨条目**的前进语义见"Skip"(§5 D-02)。

### 4.1 Capture(捕捉)

```
输入: 一段或多段文本
对每段非空文本:                         [TX/项]
  创建 InboxItem { text=原文, position=队尾 }
不做: 解析 / 去重 / 追加元数据 / 弹后续表单   (INV-16)
```

### 4.2 Quick Add(跳过 inbox 直建行动)

CLI 基线(桌面版 Quick-add 对话框的 "Full task" 标签页在此之上扩展 energy/deadline/project/labels/日程字段,见 [./DESIGN.md](./DESIGN.md);"Capture" 标签页即 §4.1):

```
输入 title(空则取消)
选择 context(含内联新建, INV-24.5)
estimatedMinutes(默认 15)
priority(默认 3)
energy = 'medium'(CLI 不询问)   deadline = 无   projectId = 无
创建 active Task                                [TX]
```

### 〔退役 D-18/D-21〕4.3 Clarify / Organize 决策树(逐 inbox 条目)

> 交互载体见 D-18:桌面 UI 的日常理清是"卡片直接 specify / Claude 对话"双路径;
> 本节的分步决策树保留为 agent 驱动与 Weekly Review 内嵌的内部机制,
> **去向语义与事务边界对三种载体一致生效**。

批处理从 inbox 队头开始(INV-17),对每个条目:

```
显示 "条目 n/total: <text>"
Q1: 这可执行吗?(需要你去做什么吗?)
├─ Skip → 条目留在 inbox 原位, 向导前进到下一条          (桌面新增, 替代 CLI 'b', §6 BUG-01)
├─ 否 → 不可执行三分:
│     1. Reference(以后可能查阅)→ ListItem kind='reference'
│     2. Someday/Maybe(也许将来做)→ ListItem kind='someday'
│     3. Trash(不需要)→ ListItem kind='trash'
│     → 提交该条目                                        [TX]
└─ 是 → Q2: 完成它需要多于一个行动步骤吗?
    ├─ 是 → 创建项目(§4.4, 无 suggestParent)→ project
    └─ 否 → 若存在 active 项目:
              "把这个行动关联到现有项目?" → 是则树选择 → project(可为空)
    → 定义下一步行动(§4.5, 传入 project)→ task
      (deadline 继承在 §4.5 内完成, INV-10)
    → task.projectId = project.id(若有 project)
    → 路由(§4.6)
    → 提交: 本条目产生的全部实体 + InboxItem 删除, 一个事务   [TX]
批处理结束(inbox 空或用户退出)→ 孤儿检查(§4.10;CLI 仅在"进入时非空且处理到 inbox 空"时触发, INV-07)
```

注:CLI 在 Q2=是 且完成了 DDL 分解后,**仍无条件**要求为父项目再定义一个直属行动;桌面版当分解已产生活跃后代时默认跳过该步(可选提供"仍要加直属行动"入口),见 §5 D-11。除该例外,clarify 创建的项目在事务结束时必有 active next action 或活跃后代(路由到 delegate/calendar 也满足,因 INV-05);**再一例外**:行动走 2 分钟规则当场完成、且用户在完成后追问(§4.7)中选择 Skip 时,项目以孤儿状态离开事务——合法路径,由批处理结尾的孤儿检查(§4.10)接手。

### 〔退役 D-21〕4.4 创建项目(向导;父项目/继承选项随平面化废除,现行为 createProjectDirect)

```
输入: 源文本 item, 可选 suggestParent
outcome(默认 = item)
deadline(可空; 桌面校验 INV-03)
父项目选择:
  若有 suggestParent:
    "作为 <suggestParent.outcome> 的子项目?"
    是 → parentId = suggestParent.id
         若未填 deadline 且父有 → 自动继承并提示(不询问, INV-11a)
    否 → 保持顶层
  否则若存在 active 项目:
    "属于某个现有项目?"
    是 → 展示项目树 → 编号选择(0 = 顶层)
         若未填 deadline 且所选父有 → 询问"继承父 deadline (X)?"(INV-11b)
创建 Project { status='active' }
若 deadline 非空 且 本次调用无 suggestParent:
  → 提供 DDL 分解(§4.9)
  (注意: 经"属于某现有项目"挂为子项目的场景同样会提供分解; 只有 suggestParent 调用不提供)
```

### 〔退役 D-21〕4.5 定义下一步行动

```
输入: 源文本 item, 可选 project
"下一步的物理行动是什么?" → title(默认 = item)
选择 context(含内联新建)
estimatedMinutes(默认 15; 非法输入回退 15)
energy(必选 low/medium/high; UI 预选 medium)
priority 1–5(默认 3; 非法回退 3)
deadline:
  若 project 有 deadline → 静默复制, 不显示输入(INV-10)
  否则 → 询问(可空)
返回 Task 草稿(尚未落库、尚未路由)
```

### 〔退役 D-21〕4.6 路由(四分支)

```
"这个行动怎么处理?"
1. 现在就做(< 2 分钟)
   → "做完了吗?"
     是 → Task 以 status='done', completedAt=now 落库(INV-18)
          → 完成后追问(§4.7 行动版)
     否 → Task 以 status='active' 落库到其 context
2. 委派(该由别人做)
   → 输入受托人(空 → 'someone')
   → 创建 WaitingFor { description=title, delegatedTo, projectId, sourceTaskJson=草稿快照 }
   → 不落库 Task(INV-19)
3. 日历(必须在特定日期/时间发生)
   → 输入 date(必填, 校验)+ time(可选)
   → 创建 CalendarItem { title, date, time, projectId, sourceTaskJson=草稿快照 }
   → 不落库 Task(INV-19)
4. Next Actions(放进 context 清单稍后做)
   → Task 以 status='active' 落库
```

### 〔修订 D-21〕4.7 完成后追问(向导链已删;现行为 INV-14 的 consequences 提示,以下为历史规格)

**行动版**(任何 Task 完成后调用):

```
若 task.projectId 为空 → 结束
project = 查找; 不存在 → 结束
若 project.status == 'complete' → 结束      (桌面守卫; CLI 缺失, §6 BUG-02)
显示项目面包屑(祖先链 "A > B > C")
"这个项目现在完成了吗?"                     (无条件询问, 即使项目还有其他活跃项, INV-14)
├─ 是 → project.status='complete', completedAt=now    [TX]
│       → 父级级联(§4.8)
└─ 否 → "这个项目接下来做什么?"
    1. 定义下一步行动 → §4.5(project)→ §4.6 路由
    2. 创建子项目 → §4.4(suggestParent=project)→ 为其定义第一个行动(§4.5)→ 路由(§4.6)
    3. Skip(什么都不做)
```

**日历版**(任何 CalendarItem 完成后调用):

```
若 ci.projectId 为空 → 结束
project = 查找; 不存在或已 complete → 结束
显示面包屑
"这个项目现在完成了吗?"
├─ 是 → 同上 → 父级级联(§4.8)
└─ 否 → 仅当 ¬hasActiveNextAction(project) 且 ¬hasActiveChildren(project):
        "接下来做什么?" 三选(同上)          (条件询问, INV-14)
```

agent 路径:`complete_task` / `complete_calendar_item` 不内嵌追问,而是返回 `{ projectBreadcrumb, projectHasRemainingActivity, parentCompletionCandidate }`,由 agent 向用户复述提问(INV-15)。

### 〔退役 D-21〕4.8 父级完成级联

```
输入: 刚被标记 complete 的 project
若 project.parentId 为空 → 结束
parent = 查找; 不存在或已 complete → 结束
children = parent 的全部子项目(含已完成的)
若 children 全部 complete:
  "X 的所有子项目都完成了! 把父项目也标记完成?"
  ├─ 是 → parent 标记 complete            [TX]
  │       → 递归本流程(parent)            (逐级向上, 每级都问, INV-13)
  └─ 否 → 结束(parent 保持 active)
否则:
  结束
  (CLI 源码在此分支内有"父项目没有下一步"警告 + 三选, 但进入前提"兄弟未全完成"
   蕴含父必有 active 子项目, 与守卫 ¬hasActiveChildren 逻辑矛盾 —— 不可达代码,
   不得为其编写行为测试; 见 INV-13.2)
```

### 〔退役 D-21〕4.9 DDL 分解(左边缘递归)

对有 deadline 的项目提供(触发点见 §4.4):

```
"把 <outcome>(DDL: d)分解为子项目?"  否 → 结束
"列出主要步骤/阶段, 逐个输入子项目名(空行结束):"
循环:
  读入名称; 空 → 跳出
  询问该子项目的 DDL(留空 = 继承 d, INV-11c; 非空输入需校验)
  创建 Project { parentId=project.id, deadline }        [TX/项]
若未创建任何子项目 → 结束
first = 第一个子项目                                     (左边缘)
"first 还需要进一步分解吗?"
├─ 是 → 递归本流程(first)
└─ 否 → "first 已小到可以直接行动"
        → 为 first 定义第一个行动(§4.5)→ 路由(§4.6)
兄弟子项目 2..n 故意不定义行动 → 成为孤儿, 由孤儿徽章/修复接手(INV-06)
```

哲学:**"把第一步挖到可执行,其余留待后续"**——只有最先要做的分支需要立即细化,兄弟分支由孤儿机制保证不被遗忘。移植时不得"改进"为强制给每个子项目配行动。
递归死端同样合法:递归中若用户对"分解为子项目?"答否、或未录入任何子项目,该左边缘子项目**既无行动也无子项目**,以孤儿收场,交由孤儿机制——**不得**在此强制补定义行动("为 first 定义第一个行动"只发生在对"还需要分解吗?"答否的分支)。

### 〔退役 D-21〕4.10 孤儿检查与修复

```
orphans = [ p | p.status='active' ∧ ¬hasActiveNextAction(p) ∧ ¬hasActiveChildren(p) ]   (INV-05/06)
若空 → 结束
列出全部孤儿(面包屑 + DDL)
逐个:                                                    [TX/项]
  "→ <面包屑> (DDL: d)"
  1. 定义下一步行动 → §4.5(p) → 路由 §4.6
  2. 创建子项目 → §4.4(suggestParent=p)→ 定义其第一个行动 → 路由
  3. Skip
```

桌面版由常驻徽章 + 用户发起的修复 sheet 承载(INV-07);agent 由只读工具 `list_orphan_projects` 发现、逐项征询后用写工具修复。

### 〔退役 D-21〕4.11 Weekly Review(六步)

每一步的每个条目决定即提交 **[TX/项]**(CLI 仅 Step 2/3/4 的判定攒到 review 结尾统一落盘,Step 1/5 借道 clarify 逐条落盘、修复流程亦中途落盘;桌面版全部收紧为逐项;**D-28 起载体 = agent skill,无向导 UI**,"可中断续跑"由对话本身承担,见 §5 D-10/D-28)。

```
Step 1/6 清空收件箱:
  完整执行 §4.3 clarify 批处理(inbox 非空时其结尾的孤儿检查会随之发生)

Step 2/6 检查 Next Actions:
  按 context 顺序, 逐个 active Task:
    显示 title + 项目面包屑 + DDL
    "仍然相关吗?"
    ├─ 是 → 保留
    ├─ 否 → status='deleted'(软删除进 Trash, INV-22)
    └─ Skip → 跳过该条

Step 3/6 检查项目:
  显示完整项目树(INV-09)
  逐个 active 项目(桌面版按树 DFS 顺序; CLI 实为创建顺序 — 源码中"leaf 优先"仅是注释, 未实现; 顺序不构成不变量):
    显示面包屑 + DDL
    "这个项目完成了吗?"
    ├─ 是 → complete → 父级级联(§4.8)
    ├─ 否 → 若 ¬hasActiveNextAction ∧ ¬hasActiveChildren:
    │        "⚠ 没有活跃的下一步!" → 定义行动 / 建子项目 / Skip
    └─ Skip → 跳过该项目
  (遍历中对每个项目即时重判 status: 已在本步骤内经级联变为 complete 的项目直接跳过、
   不再追问; 本步骤中新建的子项目不追加进本轮走查。CLI 对循环前的快照遍历, 会重复
   追问级联完成的父项目 —— BUG-02 同类缺陷, 不复刻)

Step 4/6 检查 Waiting For:
  逐个未解决 WaitingFor(显示 description → delegatedTo, since 日期):
    "收到回复了吗?"
    ├─ 是 → resolved=true, resolvedAt=now
    └─ 否 → "创建催办行动?"
            是 → 按 INV-23 模板创建 Task(直接入 next actions, 不走路由)
                 WaitingFor 保持未解决(INV-23)
    (resolve 不是追问漏斗的入口: 不触发任何完成后追问或孤儿提示, 即使它可能使
     项目变为孤儿 —— 由孤儿徽章/下次扫描承接, 见 INV-14 边界)

Step 5/6 检查 Someday/Maybe:
  逐条:
    1. 保留
    2. 激活 → 移回 inbox 队尾(INV-21)
    3. Trash → kind='trash'
  若有激活项 → 立即对新入 inbox 的条目执行 §4.3 clarify

Step 6/6 通览日历(只读):
  未完成 CalendarItem 按 date 升序、同日全天在前、再按 time 升序列出
```

### 4.12 Engage(择事执行 / Focus;D-21 后向导态删除,规则实现为 `engageRanking`;**D-28 起载体 = agent skill + CLI,不做 UI 向导**——其中的孤儿检查步骤随 D-21 作废)

```
1. Calendar-first(INV-20.1):
   today = 今天未完成的 CalendarItem 列表(含项目面包屑)
   若非空 → "现在处理一个日历项?"
     是 → 选择一项 → "做完了吗?"
           是 → done=true → 日历版完成后追问(§4.7)
     (CLI: 处理完一个日历项即结束本轮, 且该分支不做孤儿检查 —
      agent skill 处理完可继续进入任务推荐, §5 D-12; 孤儿机制随 D-21 退役)
2. 选择当前 context(逐个显示活跃计数)
3. 该 context 无 active Task → 结束
4. "有多少分钟?"(默认 60)→ 过滤 estimatedMinutes <= t
5. "精力如何?" low/medium/high → 过滤 task.energy <= user(INV-02)
6. 无候选 → 结束
7. priority 降序稳定排序, 展示前 7(每条: title, ~分钟, energy, P, DDL, 面包屑)(INV-20)
8. 选择一条(默认第 1 条; 仅一条时直接选中)
9. "做完了吗?"
   是 → status='done', completedAt=now → 行动版完成后追问(§4.7)
10. 孤儿检查(§4.10)
    (注: CLI 仅在到达第 7 步后才执行本步; 第 1 步分支与第 3/6 步提前退出均不执行 —
     早期行为清单记为"总是执行", 与源码不符, 以本条为准。桌面版常驻徽章使该差别不再敏感。)
```

agent 对应:`get_engage_recommendations { contextName, availableMinutes, energy }` 是**只读**工具,返回 top-7 与今天的日历项;完成动作必须另行调用写工具(INV-20.5)。

### 4.13 Context 管理

```
列表: 逐 context 显示活跃 Task 计数
添加: 输入名称 → 自动 '@' 前缀 → 重名拒绝 → 创建           [TX]
删除:
  仅剩一个 → 拒绝(INV-24.3)
  目标含 N 个 active Task → "⚠ 含 N 个活跃行动, 确认删除?"
    确认 → 这些 Task 软删除进 Trash → 删除 context          [TX](§5 D-09)
```

### 〔退役 D-21〕4.14 项目管理入口(My Projects 视图动作;现行为平面列表 + 右键编辑/完成,见 DESIGN §8)

```
添加子项目: 选择父项目 → §4.4(suggestParent=父)
            → "现在为它定义下一步行动?" 是 → §4.5 + §4.6
            (CLI 中选 0 会以占位文本 "new project" 建顶层项目; 桌面版用正常表单代替)
标记完成:   选择项目 → status='complete' → 父级级联(§4.8)   [TX]
分解:       任何有 deadline 的项目提供 "Break down by deadline" → §4.9
            (桌面新增入口, 见 §5 D-17; CLI 仅在创建流程内触发分解, §4.4)
```

### 4.15 状态汇总(只读)

Dashboard / `get_status_summary` 输出:inbox 条数与内容;active 项目树(INV-09 渲染);active Task 按 context 分组(~分钟、P、DDL、面包屑);未完成日历项按时间排序;未解决 WaitingFor(受托人、since);Someday/Maybe;Reference;统计(done Task 计数、complete Project 计数)。纯读,无副作用。

---

## 5. 有意与 CLI 的差异

以下差异是**有意决策**,不是移植误差。除本表所列外,一切行为与 §3/§4 规定的 CLI 语义一致。

| # | CLI 行为 | 桌面版行为 | 理由 |
|---|---|---|---|
| D-01 | weekly review"不再相关"把 Action 从列表**硬删除**,无任何去处、无 undo | `status='deleted'` 软删除,进 Trash,可恢复(INV-22) | 数据安全;相关性判断误操作率高,GUI 有 Trash 视图承接 |
| D-02 | clarify 第一问答 `b`(back)造成同一条目无限重试 + 计数器越界(§6 BUG-01) | 真正的 **Skip**:条目留在 inbox 原位,向导前进到下一条;向导内提供真后退(未提交无副作用) | 修复 bug 并给出 CLI 想要而没实现的语义 |
| D-03 | 路由到 delegate/calendar 时,行动的 context/estimatedMinutes/energy/priority/deadline **全部丢弃**(用户刚填完就被扔掉) | WaitingFor / CalendarItem 携带 `sourceTaskJson` 元数据快照;**仅存档,永不自动复活**(INV-19) | 信息不丢失、支持日后显式"转回行动";不复活则保住 CLI 的实体转换语义 |
| D-04 | inbox / someday / reference / trash 是裸字符串数组,无 id 无时间戳 | InboxItem / ListItem 对象(id、text、createdAt、inbox 另有 position) | 可寻址(agent 工具、逐条操作)、可排序、可审计;重复内容依旧合法 |
| D-05 | 所有实体 id = `uuid4` 前 8 个 hex 字符,跨类型共享空间,无碰撞检测 | 完整 UUIDv4(INV-04) | 消除碰撞风险(§6 BUG-03) |
| D-06 | **没有任何编辑流程**(实体只有创建/完成/删除),deadline 继承因此从不面对"父值变了"的问题 | 全面编辑;编辑项目 deadline 时**一次性提示**"同步更新 N 个继承后代?"(INV-12);agent 侧 `update_project` 需显式 `propagateDeadline` | 继承是 copy-on-create,新增的编辑能力必须显式处理传播,否则静默失联或静默批改 |
| D-07 | 日期是自由文本,零校验;坏格式破坏排序与 today 匹配(§6 BUG-05) | 新输入强校验;读取路径对存量非法值宽容(不崩溃、标记"需修正")(INV-03) | 写入侧收紧、读取侧宽容,历史/外部数据不致瘫痪应用 |
| D-08 | `Project.action_ids` 仅追加簿记,充满悬挂 id(§6 BUG-04) | 字段删除;一切按 `projectId` 扫描 | CLI 的活跃逻辑本来就只按 projectId 查询,字段名存实亡 |
| D-09 | 删除 context 时其中的 action 随存储桶**永久删除**(确认后) | 确认后 Task 软删除进 Trash,可恢复(恢复时重选 context)(INV-24.4) | 与 D-01 同理;一次确认蒸发整张清单过于危险 |
| D-10 | 持久化 = 每次变更整文件重写 JSON;weekly review 部分决定攒到结尾统一落盘 | SQLite 逐决定事务提交 + `gtd:changed` 推送;review 逐项落盘,中断续跑由对话上下文承担(D-28 后无向导) | 崩溃安全等级不降(INV-17)且长向导可恢复 |
| D-11 | clarify 中完成 DDL 分解后,**仍无条件**要求为父项目再定义一个直属行动 | 分解已产生活跃后代时默认跳过该步(提供可选入口) | 父项目已有活跃子项目、非孤儿;强制直属行动违背左边缘哲学(§4.9) |
| D-12 | engage 处理完一个日历项后**本轮直接结束**,不进入任务推荐 | agent skill 处理完日历项后可继续任务推荐(D-28 前曾为 Focus 面板);calendar-first 的**优先次序**保持不变 | 会话式 GUI 无需强制退出;不变量只在"日历优先于任务" |
| D-13 | 孤儿检查只挂在两个流程出口(且有不触发的旁路,INV-07) | 常驻孤儿徽章,每次 `gtd:changed` 重算;修复仍由用户发起、逐项征询 | GUI 可持续显示;征询原则不变 |
| D-14 | priority 以 `P1`–`P5` 数字直接显示 | 选择器与展示用文字(最高/高/中/低/最低),存储不变(INV-01) | 防止用户以 Todoist 习惯(p1=最高)误读 |
| D-15 | `_after_action_completed` 不检查项目是否已完成(§6 BUG-02) | 已 `complete` 的项目不再触发任何完成追问(§4.7 守卫) | CLI 疏漏;重复追问且可能重复触发级联 |
| D-16 | review/clarify 中 `b` 键语义不一(clarify 中意为 back,review 中意为 skip) | 显式、命名一致的 Skip / Back 按钮 | 可用性;消除歧义 |
| D-17 | DDL 分解只在"创建带 deadline 项目"的流程内触发(§4.4),无对既有项目的独立入口 | My Projects 对任何有 deadline 的项目提供 "Break down by deadline"(§4.14) | 编辑能力普遍化后分解不应绑定创建时机;分解流程本体(§4.9)不变 |
| D-18 | 理清 = 强制逐题问答(§4.3 交互形态) | **理清双路径(2026-08-08 用户定案)**:① 手动 specify —— Inbox 条目展开为 Todoist 式卡片,直接补属性转为 Task,或转为 Project,或归档 Someday/Reference/Trash;② 交给 Claude 对话理清(M8/M9 经 MCP 工具)。分步问答状态机**保留为内部机制**(agent 驱动与 Weekly Review 内嵌用),UI 无独立入口 | 逐题问答对日常理清过重;§4.3 的**去向语义**(六种去向、deadline 继承、逐项一次事务 = 一次确认)全部保留,变的只是交互载体 |
| D-19 | Action 无"计划哪天做"概念(日程只能是 CalendarItem) | Task 新增 `scheduledDate`(与 deadline 并存)。(后续 D-23/M6a:CalendarItem 并入 Task,时间即 `startTime`) | Todoist 式 today/tomorrow 快速安排是用户核心工作流;时刻与最迟完成日的语义区分保留(§2.5) |
| D-29 | priority 1 = 最低、5 = 最高(与 Todoist 相反) | **翻转为 1 = 最高、5 = 最低(2026-08-11 用户定案,INV-01)**:过滤器文本语法采用 Todoist 的 `p1 = 最高`,若存储不翻,同一应用里 `p1` 与 `--priority=1` 方向相反,必然出错。存量数据由迁移 v10 执行 `6 - priority`;值域/默认值/不重编号三条不变;`FilterQuery.priorityMin` 改名取补为 `priorityMax` | ✅ 已定 |
| D-28 | `engage` / `review` 是 CLI 的交互式命令(分步问答向导) | **流程类功能不做 UI,改由 agent skill 承载(2026-08-11 用户定案)**:择事与周回顾**本质是一串原子操作的编排**,固化成向导 UI 等于把"何时该怎么想"写死在按钮里。算法(INV-20、§4.11、§4.12)原样保留在 domain;载体改为 agent skill + 聊天输入框下方的建议按钮(DESIGN §6.9),中栏不再有 Focus 面板/回顾向导。M7 范围收缩为 Search + Filters & Labels;已实现的 Focus 面板据此撤除,CLI `engage` 保留 | ✅ 已定 |
| D-27 | 无时区概念,时间即本地墙上时间 | **浮动时间 vs 指定时区(2026-08-10 用户定案,INV-31,M6d)**:`Task.timeZone`(null = 浮动,随设备时区解释;非 null = 绑定 IANA 时区),借鉴 Todoist 的 Floating time | ✅ 已定 |
| D-26 | 无外部日历写入 | **任务 → 专用 Claudoist 日历的双向同步(2026-08-10 用户定案,INV-30,M6c-3b)**:仅写**本应用创建**的日历(scope `calendar.app.created`),**默认关闭**,指纹去重 + 删除复查 + 本地脏数据优先 | ✅ 已定 |
| D-25 | 外部日历事件只读展示 | **外部事件镜像为真任务(2026-08-10 用户定案,INV-29,M6c-3a)**:可完成/加标签/子任务/评论、参与 Today 与 engage;仅标题与时间归 Google 所有,本地改动**永不回写** | ✅ 已定 |
| D-24 | (D-21/22)任务顺序仅按 createdAt,无手动排序;无拖拽 | **手动排序 + 拖拽重排/嵌套(2026-08-09 用户定案,INV-27)**:`Task.sortOrder`,同级组按 sortOrder+createdAt 排;拖拽既可换位也可拖成子任务(reorderTask:设 parentTaskId + 整组重排,约束沿用 INV-25 深度/环/容器);CLI `reorder` 命令对齐。迁移 v5 加 sort_order | ✅ 已定 |
| D-23 | (D-20~22)CalendarItem 是与 Task 分离的"硬景观"实体,Today 有独立日程段;无外部日历同步 | **日历统一 + Google 同步(2026-08-09 用户定案,规划中,M6)**:取消 hard-landscape 特殊区分,**任务与日历事件统一**(带时间的任务即日历 block);任务↔本地日历双向同步;日历网格支持 all-day、小时格四等分单击、拖选 time-block 创建任务;完成任务不从日历/Google 删除,仅标记完成;删除 block 才双向传播。**Google Calendar OAuth + 双向 pull/push,可选账号**。domain 以 Task 时间字段替代 CalendarItem:**M6a 已实施(2026-08-09 用户选型)** —— `scheduledDate + startTime(HH:MM,null=全天)+ durationMinutes(null 回退 estimatedMinutes)`,迁移 0006(日历数据迁任务、提醒随迁、表退役);Google 映射:有 startTime→timed event,无→all-day。日历网格 UI = M6b,Google 同步 = M6c | 🚧 M6a 已实施 |
| D-22 | (D-21)完成子任务不级联,`activeSubtaskCount` 仅提示 | **完成向下级联(2026-08-09 用户定案)**:完成父任务 = 一并完成整棵 active 子树(仅向下;勾子任务不勾父),`completedSubtaskCount` 报告数量,UI 完成控件 hover 提示防误操作(不弹确认)。子任务支持与顶层任务相同的属性集(labels/reminders 等),添加子任务用同一表单;单击任务弹 Todoist 式两栏详情(左内容/右属性,右栏含 Move to);Today 硬边界与任务统一为行式列表。INV-26.1 修订,INV-25/INV-15 补充 | ✅ 已定 |
| D-21 | 项目可嵌套(parentId 树、深度无上限、re-root、孤儿徽章、DDL 分解为子项目、父级完成级联) | **项目平面化 + 任务子树(2026-08-09 用户定案)**:去掉子项目与孤儿机制,Project 只剩平面列表(带 deadline 与进度 = done/(done+active));层级改由 `Task.parentTaskId` 子任务承接(≤5 层,INV-25/26);任务详情弹窗支持子任务与评论(TaskComment);侧栏项目/GTD 条目显示未完成计数徽章,项目视图/Today 与 Inbox 同构可直接添加任务。INV-06/07/08/09/11/13/18/19 与流程 §4.3/4.5/4.6/4.8–4.11 退役;**全部分步向导 flow 删除**(domain usecase 是唯一载体;INV-17 修订为命令批事务) | 用户明确对齐 Todoist:"去掉 orphan project, 去掉 subproject…只有 project, 然后就是 task. task 如果不是 actionable 就拆解成 subtask",最多 5 层 |
| D-20 | inbox 是裸想法(InboxItem),理清 = 转化成其他实体后**消失** | **容器(bucket)模型(2026-08-09 用户定案)**:Task 新增 `bucket: 'inbox'\|'project'\|'someday'\|'reference'`(`'project'` ⟺ `projectId` 非空)。捕捉 = 在 Inbox 建 Task(默认 context);理清 = **Move to**(Inbox/项目树/Someday/Reference)或勾选完成——任务永远在某个可见容器里,绝不"变身后失踪"。挪入有 deadline 的项目时若任务无 deadline → 静默复制(INV-10 的 move 版)。`someday`/`reference` bucket 的任务**不参与** Today/engage(孵化中)。INV-16 载体随之改为 createTask;INV-21 修订:激活 = 从 Someday 移回任意容器(不再强制经 inbox 重理清)。InboxItem 实体与分步 clarify 状态机降为 legacy(agent 时代按 bucket 模型重做)。Trash 无视图(右键软删,数据可恢复);Weekly Review 移出侧栏 | 用户明确的 Todoist 心智:task 默认在 inbox,不挪不消失;去 GTD 仪式化 |

---

## 6. 不复刻的 CLI bug 清单

以下缺陷**禁止**在新实现中重新出现。每条给出复现条件,防止无意间重新引入等价逻辑。

### 〔退役 D-21〕BUG-01 `b`(back)死循环与计数器越界(向导已删,无复刻面)

**机制**:clarify 批处理循环取 `inbox[0]` 处理后无条件 `pop(0)`;第一问答 `b` 时处理函数把条目重新 `insert(0, item)` 再返回——调用方照常 pop,净效果 inbox 不变,同一条目被无限重试;同时进度计数 `Item n/total` 的 n 持续自增超过 total。
**复现**:inbox 至少一条,进入处理,对"可执行吗?"回答 `b`。
**防复刻要求**:Skip 必须实现为"游标前进、条目原位保留"(D-02);批处理进度以"已处理集合"计数,不以循环次数计数。为其写一条流程级测试:对同一条目连续 Skip 两次,断言向导前进且计数不超过条目总数。

### BUG-02 已完成项目被重复追问完成(缺守卫)

**机制**:行动版完成后追问不检查 `project.complete`(日历版有检查)。项目在 review 中被标记完成后,其遗留的 active 行动在 engage 中完成时,仍会被问"这个项目现在完成了吗?";回答"是"会重复标记并再次触发向上级联。
**复现**:项目 P 有 active 行动 A;在 review Step 3 将 P 标记完成(不动 A);随后在 engage 完成 A。
**防复刻要求**:所有完成后追问入口统一守卫 `project.status === 'complete' → 直接结束`(§4.7,D-15)。

### BUG-03 8 字符截断 id 的碰撞风险

**机制**:所有实体 id 取 `uuid4` 前 8 个 hex(≈ 4.3 × 10⁹ 空间),跨实体类型共享且无处检测唯一性;碰撞会造成错误的项目关联/查找。
**防复刻要求**:完整 UUIDv4 + 主键唯一约束(INV-04,D-05)。

### BUG-04 悬挂的 `action_ids`

**机制**:`Project.action_ids` 只增不减;行动被路由成 WaitingFor/CalendarItem(实体转换)或在 review 中删除后,id 仍留在数组里指向虚空。任何把 `action_ids` 当权威的实现都会产出幽灵行动。
**防复刻要求**:字段不存在(D-08);"项目的行动"只能来自按 `projectId` 的查询。禁止实现任何"根据历史 id 列表修复/复活行动"的逻辑。

### BUG-05 日期零校验破坏排序与 today 匹配

**机制**:日期是自由文本;`2026-1-5` 之类未补零的输入使字典序排序错位、engage 的"今天"前缀匹配失效,且全程无报错。
**复现**:创建日历项时输入 `2026-1-5`,再运行 engage——该项永远不出现在"今天"。
**防复刻要求**:写入校验 + 读取宽容(INV-03,D-07);"today"判定基于结构化 `date` 字段的相等比较,不做字符串前缀匹配。

### 次要怪癖(一并规避)

| 怪癖 | CLI 表现 | 新实现 |
|---|---|---|
| review Step 3 顺序注释失实 | 注释称"leaf 优先",实际按创建顺序遍历 | 按树 DFS 展示;顺序不作不变量(§4.11) |
| 项目管理选 0 建占位项目 | 生成名为 `new project` 的顶层项目 | 正常表单,无占位文本(§4.14) |
| engage 孤儿检查旁路 | 三个提前退出分支不触发扫描 | 常驻徽章(D-13) |
| `estimatedMinutes` 接受 0 | `0` 是合法数字输入,0 分钟任务通过一切时间过滤 | 表单校验最小值 ≥ 1 |
| `b` 语义漂移 | 同一个键在不同流程分别表示 back 与 skip | 显式按钮(D-16) |

---

*本文档定稿于 2026-08-08。修订必须先于实现;每次修订同步更新 [./ROADMAP.md](./ROADMAP.md) 的变更记录,并检查 `@gtd/domain` 中对应的 `INV-xx-*.spec.ts` 是否需要同步。*
