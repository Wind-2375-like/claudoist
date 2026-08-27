# Claudoist — 项目路线图(ROADMAP)

> 项目跟踪文档。架构与技术设计见 [./DESIGN.md](./DESIGN.md);GTD 业务规则唯一权威见 [./INVARIANTS.md](./INVARIANTS.md)。
> 本文档随开发进度持续更新:里程碑状态、验收勾选、用户反馈、决策日志都在这里维护。

---

## 1. 协作流程

按里程碑逐步推进,每个里程碑走同一个循环:

1. **步前预告** —— 开始实现前,先向用户说明:(a) 本步要做什么;(b) 预期结果与验收标准(即本文档对应里程碑的验收清单,如有出入先更新文档再动手)。
2. **实现** —— 按 [./DESIGN.md](./DESIGN.md) 的架构与 [./INVARIANTS.md](./INVARIANTS.md) 的业务规则实现,满足 Definition of Done。
3. **用户试用** —— 交付可运行结果(`pnpm dev` 或 dmg),用户实际操作并给反馈。
4. **反馈处理** —— 反馈项修完、验收标准逐条勾选通过后,该里程碑标记 ✅,进入下一步。反馈记录写入对应里程碑的"用户反馈"小节。

**文档维护义务**:每个里程碑完成时,同步更新三份文档 —— 本文档的状态与勾选、DESIGN.md 中已变化的设计事实、INVARIANTS.md 中新增或修订的规则。文档与代码不一致视为该里程碑未完成。

---

## 2. Definition of Done(每个里程碑通用)

一个里程碑只有在以下各项**全部**满足时才算完成:

- [ ] `pnpm lint` 通过(ESLint 含 `eslint-plugin-boundaries` 依赖方向检查 + Prettier)
- [ ] `pnpm typecheck` 通过(TypeScript strict,全部包)
- [ ] `pnpm test` 全绿(含 `@gtd/domain` 不变量套件与已有的全部测试,无跳过、无 flaky)
- [ ] `pnpm smoke` 退出码 0(无头启动主进程并 dump 视图 JSON)——**单元测试与 CI 的 build 都不运行打包产物**,打包期问题(模块求值顺序、跨模块重复函数体被折叠等)只有真正启动才暴露;2026-08-10 曾因此让 `ReferenceError` 逃逸到运行期
- [ ] 本文档中该里程碑的验收标准逐条勾选满足
- [ ] 用户试用通过,反馈已处理并记录
- [ ] 三份文档已同步更新(ROADMAP / DESIGN / INVARIANTS)
- [ ] 提交历史符合 Conventional Commits;GitHub Actions CI(lint + typecheck + test + build)绿

---

## 3. 里程碑总表

状态:⬜ 未开始 · 🔄 进行中 · ✅ 已验收

| 编号 | 名称 | 一句话目标 | 状态 |
|---|---|---|---|
| M0 | 脚手架 | monorepo + electron-vite 三目标 hello world + electron-builder 可安装 dmg + 工程规范骨架 | ✅ |
| M1 | 打包风险 spike | 打包后的 app 内跑通最小 Agent SDK 会话,验证图片 content block 与无 Node 机器 | ✅ |
| M2 | 领域核心 | `@gtd/domain` 实体/规则/流程状态机,INVARIANTS.md 每条不变量一个命名测试 | ✅ |
| M3 | 存储层 | `@gtd/storage-sqlite` 实现 GtdStore(node:sqlite)+ 迁移 + contract 测试 + `pnpm seed` | ✅ |
| M4 | 只读壳 | main 开库 + IPC 读通道 + 侧栏与 Inbox/My Projects/Today 只读视图 | ✅ |
| M5 | 捕捉与理清(经 R/R2/R3 三次用户反馈重塑) | 捕捉、Todoist 式单卡快速添加、容器模型(D-20)、平面项目 + 任务子树/评论/详情弹窗(D-21)、CLI 通道(M5C) | 🔄 |
| M6 | 其余视图 | Upcoming 周网格、Filters & Labels、⌘K 搜索、Reminders 响铃、评论附件 | ⬜ |
| M7 | 执行辅助 | Focus 面板(engageRanking 纯规则,无向导状态机)、Completed 归档策略 | ⬜ |
| M8 | Agent 只读版 | SDK 接入 + API key onboarding + 流式聊天 + 只读工具 + 成本护栏 | ⬜ |
| M9 | Agent 写入 + 权限 | 写工具 + canUseTool 审批 + 权限模式 + agent_audit + 实时刷新 | ⬜ |
| M10 | Agent 面板补全 | 会话管理/fork、图片粘贴、附件、模型与 effort 切换、用量账本、coaching evals | ⬜ |
| M11 | 打包加固与打磨 | 无 Node 机器全流程复验、notarization、主题、错误上报面 | ⬜ |

---

## 4. 里程碑详情

### M0 — 脚手架

**目标**:建立可持续开发的工程底座:pnpm workspace monorepo、electron-vite 三目标构建、electron-builder 打包、lint/typecheck/test/CI 骨架。

**范围要点**
- pnpm workspace:`packages/domain`、`packages/storage-sqlite`、`packages/agent-tools`、`apps/desktop`(空壳即可,占位 package.json + tsconfig)。
- electron-vite 5.0.0 三目标(main / preload / renderer)hello world 窗口;React 19 + Tailwind CSS 接入 renderer。
- electron-builder 26.15.3:macOS dmg + zip,appId `com.windlike.claudoist`,`asarUnpack: ['**/node_modules/@anthropic-ai/**']` 预先写入配置(M1 依赖)。
- TypeScript strict(`tsconfig.base.json`)、ESLint + `eslint-plugin-boundaries`(强制依赖方向:domain ← storage-sqlite / agent-tools / desktop,renderer 只经 preload)、Prettier、Vitest 骨架。
- GitHub Actions CI:lint + typecheck + test + build 四个 job。
- 降级预案(见决策日志):若 pnpm workspace 与 electron-builder 原生模块摩擦过大,可退化为单包 + `src/` 目录边界,eslint-boundaries 保持依赖方向,包边界设计不变。

**验收标准**
- [x] `pnpm dev` 打开应用窗口(2026-08-08 本机验证;三栏静态壳 + IPC 冒烟通道)
- [x] `pnpm dist` 产出 dmg,可启动(2026-08-08 本机验证;更名后产物 `release/Claudoist-0.1.0-arm64.dmg`;"干净账户"复验留给用户试用/M11)
- [x] `pnpm lint` / `pnpm typecheck` / `pnpm test` 均可运行且绿(测试 3/3)
- [x] CI 在 push 上全绿(2026-08-08 run #1 "feat: rename product to Claudoist",4 job 全绿,37s;测试报告 3/3。附注:runner 对 actions/checkout@v4 等的 Node 20 弃用警告为第三方 action 噪音,不阻塞,后续顺手升级 action 版本即可)

**实现记录(2026-08-08)**
- 版本矩阵:Electron 43.3 / electron-vite 5.0 / electron-builder 26.15 / React 19.2 / Vite 7.3(electron-vite 上限 ^7,故未用 8)/ @vitejs/plugin-react 5.2(6.x 需 Vite 8)/ TS 5.9(typescript-eslint 上限 <6.1,未用 TS 7)/ Vitest 4.1 / ESLint 10 / pnpm 11.20(corepack + `packageManager` 钉版)。
- 依赖方向改用 ESLint 分区 `no-restricted-imports`(DESIGN §3.2 已同步);`.npmrc` 用 `node-linker=hoisted` 规避 electron-builder 符号链接摩擦。
- 两个实操坑已记档:`productName` 必须写在 `apps/desktop/package.json`(否则 userData 目录变成 `@gtd`);VSCode 派生终端会泄漏 `ELECTRON_RUN_AS_NODE=1`(README 有说明)。

**用户反馈**

- 2026-08-08:`pnpm dev` 三栏窗口正常;`pnpm dist`/`lint`/`typecheck`/`test` 本人复跑全绿。反馈项:① 产品更名 **Claudoist**(已执行,见决策日志);② 询问 dmg 安装方式(已在回复中说明);③ 终端出现 `IMKCFRunLoopWakeUpReliable` 日志 —— macOS 输入法框架(IMK)对终端启动 GUI 应用的已知无害噪音,非本应用缺陷,不处理。
- 2026-08-08(验收通过):dmg 安装成功;push 后 CI run #1 全绿。**M0 ✅**

---

### M1 — 打包风险 spike

**目标**:把整个项目最高不确定性——"打包后的 Electron app 里 Agent SDK 能否运行"——最先证实。在领域移植前拿到结论。

**范围要点**
- `@anthropic-ai/claude-agent-sdk` 0.3.226(pin)接入 main 进程,最小 `query()` 流式会话(临时 UI 即可)。
- 打包链路三件套:`asarUnpack` → `cliPath.ts` 解析 `require.resolve('@anthropic-ai/claude-agent-sdk/cli.js')` 并把 `app.asar` 重写为 `app.asar.unpacked` 后传 `pathToClaudeCodeExecutable` → spawn 覆写用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`(打包机器无需系统 Node)。
- `CLAUDE_CONFIG_DIR` 指向 `userData/claude`;**验证主认证路径**:不注入 API key,确认 SDK 子进程能复用本机 Claude Code 登录(macOS Keychain 凭据)且不受 `CLAUDE_CONFIG_DIR` 重定向影响;若冲突,按 DESIGN.md §6.1 的兜底顺序定案并记录。
- 验证 base64 图片 content block:以 pinned SDK 版本发送含 `{ type:'image', data, mimeType }` 的 `SDKUserMessage`,确认模型能描述图片。
- 若图片验证失败,启用兜底方案:图片落盘到附件目录、经 SDK 内置 `Read` 工具读取;结论(成功或兜底)写入 DESIGN.md 风险清单。
- 在一台**未安装 Node** 的 macOS 机器上测试打包产物;若无第二台机器,以 **stripped-PATH 模拟**代替:`PATH=/usr/bin:/bin:/usr/sbin:/sbin`(不含 node/homebrew)启动打包版完成一次对话,效果等价于验证 spawn 不依赖系统 Node。

**验收标准**
- [x] 不开终端完成一次完整流式对话(2026-08-08 用户在 dev UI 实测:流式输出 + 图片识别 + session/成本元信息;打包版由 `--spike-test` 无头通道验证)
- [x] **主认证路径验证**:未注入 API key,凭本机 Claude Code 登录完成对话。实证:`CLAUDE_CONFIG_DIR` 重定向到空目录 → `Not logged in`(凭据与 config 目录绑定);**定案 = 不重定向**,会话以 `cwd=userData` 隔离在 `~/.claude/projects/` 下,已记录 [./DESIGN.md](./DESIGN.md) §6.1
- [x] base64 图片 content block 被模型正确描述(纯红测试图 → "Red",SDK 0.3.226 原生支持,无需兜底;兜底保留为升级回归预案)
- [x] stripped-PATH(`PATH=/usr/bin:/bin:...`,无 node/homebrew)下打包版复验通过——SDK 0.3.x 为**自包含原生二进制**(267MB),完全不依赖系统 Node,旧的 `ELECTRON_RUN_AS_NODE` spawn 方案已过时(DESIGN §9.3 已定稿)

**实现记录(2026-08-08)**
- pinned `@anthropic-ai/claude-agent-sdk@0.3.226`(内嵌 Claude Code 2.1.226);**发包坑**:tarball `optionalDependencies` 只列 linux,darwin 二进制需在 `apps/desktop/package.json` 显式声明 optionalDependency(升级时两处同步)。
- 新增:`src/main/agent/cliPath.ts`(平台二进制解析 + asar.unpacked 重写)、`src/main/agent/spike.ts`(最小会话:一次 send 一个 `query()` + `resume` 续接,`CLAUDOIST_CONFIG_DIR_MODE` 旋钮)、`--spike-test=`/`--spike-image=` 无头验证通道、右栏临时聊天 UI(流式 + 图片粘贴 + 中断)。
- dmg 192MB(含二进制);dev 与打包版均验证:文本流式、图片识别、订阅计费下 `total_cost_usd` 有值(≈$0.10/次小对话)。

**用户反馈**

- 2026-08-08(验收通过):图片粘贴识别正常(学术图表被正确解读);CI 全绿。反馈项:**无法拖拽文件**——属 M10 范围(附件暂存目录 + `additionalDirectories`),按计划后置,不算 M1 缺陷。**M1 ✅**

---

### M2 — 领域核心

**目标**:`@gtd/domain` —— 纯 TypeScript、零框架依赖的领域包,承载全部 GTD 业务规则;[./INVARIANTS.md](./INVARIANTS.md) 每条不变量对应一个命名 Vitest spec。

**范围要点**
- entities:`task.ts`、`project.ts`、`waitingFor.ts`、`calendarItem.ts`、`inboxItem.ts`、`context.ts`、`label.ts`、`filter.ts`(类型 + 不变量函数)。
- ports:`gtdStore.ts`(接口)、`clock.ts`、`idGen.ts`。
- rules:`deadlineInheritance.ts`(copy-on-create)、`projectHealth.ts`(active action 定义含 calendar + waiting)、`orphans.ts`、`energy.ts`(ENERGY_ORDER,任务 energy ≤ 用户 energy)、`engageRanking.ts`(min ≤ time ∧ energy ≤ user,priority 降序,top 7)。
- flows(纯 reducer 状态机 `FlowState + answer → { nextState, question, commands[] }`):`clarify.ts`、`route.ts`、`afterCompletion.ts`、`parentCascade.ts`、`weeklyReview.ts`(6 步)、`engage.ts`、`ddlDecompose.ts`(left-edge drilling)、`orphanFix.ts`。
- usecases:`captureToInbox.ts`、`createTask.ts`、`completeTask.ts`、`searchAll.ts` 等;写操作返回 consequence 字段(`parentCompletionCandidate`、`inheritedDeadline`、`projectHasRemainingActivity`、`completedSubtaskCount`),供 UI 与 agent 征询后再级联。
- 领域事件带 actor 标记(`'user' | 'agent'` + conversationId)。
- 不含任何 legacy 迁移代码。

**验收标准**
- [x] `pnpm -F @gtd/domain test` 在纯 Node 下全绿(2026-08-08:36 个 spec 文件、173 测试;无 Electron、无 SQLite 依赖)
- [x] INVARIANTS.md 每条 INV-xx 有对应 spec,覆盖率核对无遗漏(`pnpm -F @gtd/domain check-coverage`:INV/BUG 29/29;核对脚本进 CI 习惯留 M3 起接入)
- [x] 易错项专项测试通过:priority 1=最低 5=最高(INV-01)、能量过滤方向(INV-02)、calendar/waiting 计入 active action(INV-05)、someday 激活必回 inbox(INV-21)、级联仅向上且必须征询(INV-13/15)
- [x] ESLint 依赖方向分区确认 domain 不依赖任何外层包(no-restricted-imports,M0 已定的机制)

**实现记录(2026-08-08)**
- 架构:规则 = `GtdSnapshot` 纯函数;流程 = 可序列化 reducer 状态机(`FlowStep{state,question,commands,done,chain}`),命令只在事务边界发出(clarify 条目级缓冲实现 INV-17 原子性;[TX/项] 逐步发);跨流程衔接经 `chain`(afterCompletion / parentCascade / orphanCheck),宿主先 apply 再接续。
- 覆盖:9 个流程(clarify 全链 + afterCompletion + parentCascade + engage + orphanFix + weeklyReview 六步)、12 个 usecase 域(与 UI/MCP 共用的唯一写路径,写操作返回 consequence 字段)、filterQuery 解释器、searchAll、statusSummary。
- 三处按 INVARIANTS 权威裁决并同步 DESIGN:`create_task` 的 INV-10 无条件覆盖;deadline 传播改**单次调用模型**(§5.4);`resolve_waiting_for` 零后果(INV-14 边界,handler 需要时以只读规则补算)。
- 组织方式:地基层(实体/ports/规则/流程框架/clarify 链)单独成型后,4 个并行 agent 实现其余流程与 usecases,集成时统一 barrel 与 chain 参数形状(`source` 字段)。

**用户反馈**

- 2026-08-08(验收通过):本机复跑 `pnpm -F @gtd/domain test`(36 文件/173 测试)、`check-coverage`(29/29)、lint/typecheck 全绿;GitHub CI 全绿。**M2 ✅**

---

### M3 — 存储层

**目标**:`@gtd/storage-sqlite` 实现 `GtdStore` port,drizzle schema + 生成式迁移 + contract 测试套件 + `pnpm seed` 演示数据。

**范围要点**(2026-08-08 按数据层定案修订,见决策日志与 DESIGN §2.2)
- schema 以 DESIGN §5.1 为权威逐字转写为迁移 SQL(全部 UUIDv4 主键,**无 legacy 字段**):`contexts`、`inbox_items`、`projects`、`tasks`、`calendar_items`、`waiting_for`、`list_items`、`labels`、`task_labels`、`filters`、`conversations`、`settings`、`agent_audit`、`reminders`。
- 数据层 = **`node:sqlite`(DatabaseSync)+ 手写 SQL**;迁移 = `PRAGMA user_version` + 按序号的 TS 内嵌 SQL 迁移模块(源码,提交入库);无 drizzle、无原生模块。
- `SqliteGtdStore` 实现 `GtdStore`(snapshot()/apply(),apply 整批一个事务,失败回滚)。
- store-contract 测试套件定义在 domain 侧(以 `applyToSnapshot` 为参照实现,全 Command 对拍 + 原子性断言),对 SQLite 适配器运行(`:memory:`)。
- `pnpm seed`:dev-only 脚本,向 dev userData 数据库写入覆盖全实体的演示数据(多层项目树、含孤儿项目、calendar、waiting、labels、filters、inbox);默认拒绝写入非空库,`--reset` 先清后写。
- CI Node 升至 24;engines `>=23.4`(`node:sqlite` 免 flag 门槛)。

**验收标准**
- [x] store-contract 套件对 SQLite 适配器全绿(2026-08-08:4 场景 —— 全命令对拍 `applyToSnapshot`、主键冲突整批回滚、ghost id no-op、空 patch no-op)
- [x] 空库启动可完整应用全部迁移(14 表 + 索引);迁移文件已提交入库(`src/migrations/`);重复迁移幂等;外键约束实测生效
- [x] `pnpm seed` 生成演示数据(6 contexts/4 inbox/5 projects 含孤儿与 re-root 场景/11 tasks/4 calendar/2 waiting/4 lists/8 labels/4 预置 filters);默认拒绝非空库(exit 1),`--reset` 先清后写 —— 三种行为实测
- [x] `agent_audit` 与 `reminders` 表结构与 [./DESIGN.md](./DESIGN.md) schema 一致(PRAGMA table_info 断言 + decision CHECK 三值 + reminders XOR 约束实测)

**实现记录(2026-08-08)**
- 数据层按当日定案实现:`node:sqlite`(DatabaseSync)+ 手写 SQL;`PRAGMA user_version` 迁移器 + TS 内嵌 SQL 迁移;`SqliteGtdStore.apply` 整批 `BEGIN IMMEDIATE … COMMIT/ROLLBACK`;snapshot 按 rowid 序读出与参照实现的追加序对齐。
- contract 套件放在 `@gtd/domain/src/testing/storeContract.ts`(纯 TS、无框架依赖),对任何未来适配器(expo-sqlite/libsql)同样适用。
- CI Node 22 → 24;engines `>=23.4`。全仓 40 spec 文件 / 185 测试绿。
- dev 库(`Claudoist-dev/data/gtd.sqlite3`)已 seed,M4 视图开发直接可用。

**用户反馈**

- 2026-08-08(验收通过):本机复跑 domain/storage/全仓测试(185)、lint/typecheck、seed 三态全部符合预期;CI 全绿。两个疑问已解答:① `pnpm seed` 对非空库的 "fail" 是设计内的拒绝语义(退出码 1 供脚本检测),`--reset` 路径正常;② CI 的 Node 20 弃用警告来自官方 actions 自身的运行时声明,已升级 checkout/setup-node 至 v5 消除(pnpm/action-setup 仍为最新 v4,其警告需等上游发版)。**M3 ✅**

---

### M4 — 只读壳

**目标**:应用能看:main 进程开库、IPC 读通道、preload bridge、侧栏 + Inbox / My Projects / Today 三个只读视图。

**范围要点**
- main:`app.isPackaged` 为 false 时 userData 加 `-dev` 后缀(`Claudoist-dev/`);`db.ts` 在 `userData/data` 开库并跑迁移。
- renderer 安全基线:`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、严格 CSP;preload 用 `contextBridge` 暴露类型化 API。
- IPC 读通道:`gtd:inbox.list`、`gtd:tasks.list`、`gtd:projects.tree`、`gtd:calendar.list`、`gtd:waiting.list`、`gtd:contexts.list`、`gtd:orphans.count` 等(全表见 DESIGN.md IPC 通道表)。
- TanStack Query over IPC + `gtd:changed` 推送失效机制(本里程碑先接读侧)。
- 视图:Sidebar、Inbox(FIFO)、My Projects(无限深度树)、Today(先只读)。

**验收标准**
- [x] seed 数据在三个视图中可见(2026-08-08:`--dump=views` 对拍 + `--screenshot` 目视 —— Inbox 4 条、Today 日程 2/到期 2、树 2 根 3 层)
- [x] 项目树按 re-rooting 规则渲染("遗留子项目"因父项目 complete 升为根)
- [x] ✓/⚠ 健康徽章正确("发布 Claudoist 1.0" 无直属任务但有 waiting/calendar/子项目 → ✓;"设计应用图标" → ⚠;侧栏孤儿徽章 ⚠1)
- [x] dev 数据库为 `Claudoist-dev`(窗口页脚显示 dev userData 路径;打包版走 `Claudoist/`,M0 起机制未变)

**实现记录(2026-08-08)**
- main:`initStore`(userData/data 开库迁移)+ `systemClock`(本地 naive 日期)+ `createGtdViews`/`registerGtdIpc`(读通道:`gtd:inbox.list`/`projects.tree`/`today`/`contexts.list`/`orphans.count`;每次调用取全量快照,零缓存一致性问题);workspace 包(TS 源码)经 `externalizeDepsPlugin({ exclude })` 打进 main bundle。
- renderer:TanStack Query over IPC(`gtd:changed` → 全量失效,写入方 M5/M9 接上),shared DTO(`src/shared/viewModels.ts`,renderer 不 import 内层包),Inbox/Today/Projects 三视图 + 实数据侧栏(计数徽章、孤儿徽章、树根导航)。
- 新验证通道:`--dump=views`(无头 JSON,与 IPC handler 同一代码路径)、`--screenshot=<path>`(窗口截图)。
- **修掉一个 seed bug**:`day()` 用 `toISOString()`(UTC),美东时区晚 8 点后跑 seed 会把"今天"的数据写到明天——违反 INV-03 本地 naive 日期纪律,已改本地格式化(与 `systemClock` 同源语义)。

**用户反馈**

- 2026-08-08:三视图数据正常。五项疑问:①②③ Add task / inbox 条目 / 项目行不可点 —— 按计划(写交互 M5、项目详情 M5/M6),正常;④ **窄窗口下任务标题被挤成竖排** —— 真缺陷,已修(flex 布局补 `min-w-0`/truncate + `@container` 容器查询降级:窄容器隐藏次要 meta、标题优先);⑤ **三栏不可调宽** —— 已补(左/右栏拖拽手柄,180–420 / 300–680px,宽度持久化 localStorage)。另加 dev 参数 `--win-width` 供窄窗验证。
- 2026-08-08(复验通过,进入 M5):布局与分栏修复确认。**M4 ✅**

---

### M5 — 捕捉 + 快速添加 + clarify 向导

**目标**:GTD 的心脏:零摩擦捕捉、快速添加对话框、完整 clarify 向导(路由、DDL 分解、逐项事务提交、批处理后孤儿检查)。

**范围要点**
- `gtd:capture` + 全局 "+" / Cmd+N 快速添加对话框:Capture tab(单行文本 → inbox)与 Full task tab(标题、context 选择器含内联新建、estimated minutes、energy、priority——显示文字最高/高/中/低/最低、存储 GTD 语义 1=最低 5=最高、任何地方不重编号、deadline、scheduled 日期时间→转 calendar item、项目树选择器、labels)。
- clarify 向导(renderer over `gtd:flow.start {kind:'clarify'}`):actionable? → reference / someday / trash;多步? → 建项目(父项目选择 + 确认式 deadline 继承)+ 可选"按 DDL 分解"步骤(left-edge drilling,空子 deadline 继承父);单步 → 定义(context/min/energy/priority;deadline 按 INVARIANTS 规则静默继承项目)→ 路由(Do now ≤2min / Delegate → waiting_for / Schedule → calendar / Next actions)。
- **Skip for now**:条目留在 inbox、向导前进(修复 CLI `b` 死循环,见 INVARIANTS.md 差异表)。
- 每条 inbox 项完成时事务提交(逐项崩溃持久性);批处理结束跑孤儿检测并提供 Fix-orphans sheet。

**验收标准**
- [x] clarify 决策树各路径走通(技术侧 2026-08-08:domain 36 spec 全覆盖 + flowHost 集成测试走查 reference/someday/do-now/关联项目/Skip;完整 UI 走查留用户试用)
- [x] 批处理中途进程消失:flowHost kill 模拟测试 —— 文件库重开后已提交条目在库、进行中条目原位、零半成品(用户可 `kill -9` 复验)
- [x] Skip 前进不死循环、被 Skip 项留在 inbox(BUG-01 spec + flowHost 测试)
- [x] action deadline 静默继承 / DDL 空白子 deadline 继承父(INV-10/INV-11c spec;向导驱动同一状态机)
- [x] 批处理结束孤儿检查触发:flowHost chain 栈自动插入 Fix-orphans 向导(逐项 定义行动/建子项目/跳过);处理过条目才触发(INV-07)

**实现记录(2026-08-08)**
- **FlowHost**(`src/main/flows/flowHost.ts`,纯类无 Electron 依赖):托管 domain 状态机,每步命令原子 apply([TX] 载体),chain 请求以**栈**实现 CLI 内联语义 —— clarify 途中 do-now 完成 → 挂起当前问题、插入 afterCompletion(→可再级联 parentCascade)→ 归来续问;批尾 orphanCheck → orphanFix 自动接上。cancel 丢弃条目缓冲(INV-17 零半成品)。5 条集成测试(真实 SQLite)。
- 写通道:`gtd:capture` / `tasks.create` / `calendar.create` / `contexts.add` + `gtd:flow.start/answer/cancel`;usecase 唯一写路径,apply 后广播 `gtd:changed`(actor='user')→ 全视图实时刷新。
- renderer:**FlowWizard** 通用向导(渲染 6 种 Question、chain 子流程徽章、取消即弃缓冲)、**QuickAddDialog** 双 tab(Capture 连续捕捉 / Full task 含内联新建 context、文字优先级、deadline 与计划日期二选一语义)、⌘N 快捷键、Inbox「开始理清」入口。
- 延后项:quick-add 的 labels 选择(usecase 尚无 labels 参数)→ M6 一并做。

**用户反馈**

- 2026-08-08(方向修正,触发 M5R 返工):分步理清向导太复杂,不想按 GTD 逐题点击。要求:Add task 像 Todoist 一样简约(单卡 + 可选属性);Inbox 理清 = 用户直接 specify(转 today/tomorrow 单步任务或多步项目,可选 date/deadline/priority/reminders/labels)或与 Claude 对话清空;user 与 agent 共享待理清视图。三项取舍经问答定案(见决策日志):移除向导入口、Task 加 `scheduledDate`、attachment→M10 / location 不做。

**M5R 实现记录(2026-08-08)**
- domain:Task 加 `description`/`scheduledDate`(INV-03 写侧校验);Reminder 实体 + 三条命令进 Command 联合与 contract 对拍;`quickAddTask` 扩展(labels/reminder/description/scheduledDate,一次事务);新 usecase `clarifyDirect`(转 Task/转 Project/归档三列表,均与条目移除同一事务 = INV-17 的卡片化载体)。
- storage:迁移 0002(tasks 加两列);reminders 读写映射;seed 含计划日期与描述示例。
- UI:**TaskCard 统一卡片**(Todoist 式:name+description+属性 chips Date/Deadline/Priority/Labels/Reminders/@context;`add` 模式零属性+Inbox=纯捕捉、有属性=直建任务;`clarify` 模式在 Inbox 条目内联展开,另有 转为项目/Someday/Reference/删除);Today 三段(日程/计划今天/到期,计划任务不重复出现在到期);「让 Claude 帮我理清」入口占位(M8/M9 启用);分步向导入口移除(FlowHost 与状态机保留)。
- **M5R 验收标准(取代原 M5 清单的交互部分;事务/继承等技术项仍由原自动化测试覆盖)**:
  - [ ] Add task:纯文字回车 = 连续捕捉进 Inbox;点 Date→Today 后提交 = 直接出现在 Today「计划今天」
  - [ ] Inbox 条目点击展开卡片:补属性转为任务、"转为项目"、归档 Someday/Reference、删除,各操作后条目消失且产物就位
  - [ ] 卡片属性齐全可用:Date(Today/Tomorrow/自选)、Deadline、Priority(文字)、Labels 多选、Reminders(落库)、@context 切换
  - [ ] 挂到有 deadline 的项目时任务自动继承 deadline(INV-10,卡片会回显)
- 2026-08-09(再修正,触发 M5R2):"转为任务后找不到了"——理清不该是变身消失而是**挪动**;task 默认在 Inbox、不挪不消失;去向 = Inbox/项目(树形)/Someday/Reference/勾完成;Trash 视图与 Weekly Review 侧栏项删除(trash=右键处理);Completed 保留记录(量大后需归档方案);Inbox 不要"让 Claude 帮我理清"按钮(直接右栏对话)。裁决与模型见决策日志 D-20 行。

**M5R2 实现记录(2026-08-09)**
- domain:`Task.bucket`('project' ⟺ projectId 非空,updateTask 守卫同步);capture = 在 Inbox 建 Task(默认 context = sortOrder 最小);新 usecase `moveTask`(容器移动 + INV-10 move 版继承);engage/Today 排除 someday/reference(孵化中);`clarifyDirect` 与 InboxItem 降为 legacy(测试保留)。
- storage:迁移 0003(bucket 列 + 按 project_id 回填);seed 全面改任务制(lists 归零)。
- UI:**TaskRow**(完成勾选圈、属性 chip、右键菜单 完成/编辑/删除)+ **TaskCard** add/edit 双模式(位置选择器 = Move to:Inbox/Someday/Reference/项目树);Inbox = 任务列表 + 底部内联 Add task;Someday/Reference/Completed 三视图上线;侧栏 GTD 组精简(Trash 与 Weekly Review 移除);"让 Claude 理清"按钮移除。
- **M5R2 验收标准**:
  - [ ] 捕捉的任务留在 Inbox 可见,加了 Date=Today 也仍在 Inbox(同时出现在 Today)——不挪不消失
  - [ ] Inbox 行点开 → 位置选择器挪到项目(自动继承项目 deadline)/Someday/Reference,行随之出现在对应视图
  - [ ] 勾选完成圈 → 任务进 Completed;右键 → 删除(消失,无 Trash 视图)
  - [ ] Someday 的任务不出现在 Today;Move 回 Inbox 后恢复参与
  - [ ] 侧栏 GTD 组只有 Someday/Reference/Completed;Inbox 无 Claude 按钮

**M5C — CLI 操作通道(2026-08-09,用户新增需求)**

- 需求原文:"我需要同时支持 cli 操作 add task 等, 从而之后让 claude code 通过调用 cli command 来操作 tasks"。设计见 DESIGN §6.7。
- 实现:新包 `@gtd/cli`(eslint zone:只向内依赖 domain/storage,禁 Electron/UI/SDK)。入口 `pnpm --silent cli <命令> [--json]`;命令 add/capture/list/today/show/move/complete/update/delete/projects/project-add/contexts/context-add/labels/label-add;任务与项目可用 id / id 前缀 / 名称全等引用;`--json` 输出 `{ok, db, data}`(data 含完整 id)。
- DB 定位:`CLAUDOIST_DB` env > `--db=` > `--prod`/`--dev` > 自动(dev 库存在且 prod 库不存在 → dev,否则 prod);人读模式 db 路径打 stderr。
- 并发:storage openDb 增加 `PRAGMA busy_timeout = 2000`;main 进程 watch data 目录(gtd.sqlite3/-wal/-shm,300ms 防抖)→ `gtd:changed(actor='agent')`,CLI 写入后开着的 App 自动刷新。
- 顺手修复 domain bug:`updateTask` 白名单漏拷 `description`/`scheduledDate`(接口声明了但运行时静默丢弃;App 编辑卡同样受影响)——已补 + 回归测试。
- 验证:14 条 CLI 测试(真实临时 sqlite 库)+ 全套 214 绿;真实 e2e:scratch 库跑全命令(INV-10 继承、INV-15 完成追问提示、软删、--json、错误退出码 1 均符合),dev 库只读 list 确认自动定位。
- **M5C 验收标准**:
  - [ ] `pnpm --silent cli capture "想法"` 后,开着的 App Inbox 约 0.3s 内自动出现该行(watcher)
  - [ ] `pnpm --silent cli list inbox --json` 输出含 id 的 JSON;`move <id 前缀> someday` 生效且 App 同步
  - [ ] App 内添加任务,CLI `list` 立即可见(同库双向)

**M5R3 — Todoist 化:平面项目 + 任务子树(2026-08-09,M5R2/M5C 试用反馈,7 点)**

- 反馈逐条:① 行内黄 chip 的 1/2 是 label 数量 → 改显示 label 名;② My Projects 与 GTD 侧栏项加未完成计数徽章;③ Today 与 Inbox 同构(实时待办列表,来自 inbox 或项目)且可直接 add task(默认 date=today);④ 去 orphan project、去 subproject——只有 project→task,task 不可执行就拆 subtask(单击弹详情窗,可加 subtask/comment,subtask 可嵌套 ≤5 层);⑤ My Projects 可 add/toggle,总览显示各项目 progress,项目可右键编辑,项目视图右侧同 Inbox 可 add task;⑥ 任务挪进项目后必须能点开项目看到它(单项目视图);⑦ CLI 同步联动。
- 实现要点:D-21(见决策日志与 INVARIANTS):`Task.parentTaskId`(迁移 0004,projects 去 parent_id、新 task_comments 表);usecases `addSubtask`/`addComment`/级联 move/delete/`updateProject(propagateDeadline)`;向导 flows + FlowHost + 孤儿机制删除;IPC `projects.list`/`project.view`/`task.detail` 等;UI 详情弹窗、项目视图、总览、徽章;CLI `add --parent`/`comment`/`show` 子任务树/`project-update`。
- 延后:评论附件(M10)、拖拽排序/Upcoming/Filters/⌘K(M6)、Focus 面板(M7)、Completed 归档策略(后续)。
- **M5R3 验收标准**:
  - [ ] 任务行 chip 显示 label 名(不再是数字);侧栏每个项目、Someday/Reference 显示未完成计数
  - [ ] 单击任务(非勾选圈)弹详情窗:可加子任务(嵌套到第 5 层,第 6 层被拒)、可加评论;右键"编辑"仍是原卡片
  - [ ] 把任务挪进项目后,点侧栏该项目能看到它;项目视图底部可直接添加任务(默认落该项目)
  - [ ] Today 与 Inbox 观感一致,底部可直接 add task(自动 date=today);Today 徽章 = 列表未完成数
  - [ ] My Projects:+ 新建、箭头折叠、点组头看进度总览(done/(done+active));项目右键可改名/改 deadline
  - [ ] 完成带子任务的父任务 → 子任务不动并提示数量;删除父任务 → 确认文案含子任务数、整树软删
  - [ ] CLI:`add --parent=<任务>` 建子任务、`comment`、`show` 显示子任务树+评论、`projects` 显示进度;与 App 双向实时同步

**M5R4 — 二次 Todoist 对齐(2026-08-09,M5R3 试用反馈,5 点)**

- 反馈逐条:① Today 硬边界改成任务式行(与 Inbox 一致,不再是卡片块);② 添加子任务用与添加任务相同的表单(默认继承父),子任务也能右键;③ **完成父任务向下级联完成整棵子树(D-22,反转 M5R3 的不级联)**,完成控件 hover 提示防误操作;④ 单击任务弹 Todoist 式两栏详情(左内容/右属性,右栏可就地编辑并 Move to inbox/其他项目);⑤ CLI 与以上保持一致。
- 实现要点:INV-26.1 反转为向下级联(`completedSubtaskCount`);addSubtask 支持完整属性集(labelIds/reminderAt);新增 `setTaskLabels`/reminder 编辑 usecase 与 IPC;TaskDetailModal 两栏重写(右栏属性面板 + Move to);TaskCard 加 `parentTaskId` 子任务模式;Today 日历项行化;CLI `complete` 级联提示、`add --parent` 支持 --labels/--remind。
- **M5R4 验收标准**:
  - [ ] Today 硬边界渲染为任务式行(完成圈 + 标题 + 时间),与下方任务同观感
  - [ ] 详情弹窗内 "+ Add sub-task" 打开与添加任务相同的卡片(继承父的位置/context),子任务行可右键完成/删除
  - [ ] 完成带子任务的父任务 → 整棵子树一并完成;完成控件 hover 有"连同 N 个子任务"提示;完成子任务不影响父任务
  - [ ] 单击任务 = 两栏详情(左内容 / 右属性面板),右栏可改 Date/Deadline/Priority/Labels/context 并 Move to inbox/其他项目
  - [ ] CLI:`complete` 报告级联完成数量、`add --parent --labels/--remind` 生效;与 App 双向一致

**M5R5 — 子任务树 + 属性 toggle(2026-08-09,M5R4 试用反馈,取点 1/2)**

- 反馈取用两点:① 详情右栏属性 —— 有值时点值本身编辑(toggle),无值才显示 `＋`;② 嵌套任务在列表里显示为**树状结构**(缩进 + 展开/折叠 + "已完成/总数" 徽章),不再是"仅根任务、子任务藏在弹窗"。
- 实现:shared `TaskTreeVM`(task + children + subtaskDone/subtaskTotal);IPC inbox/bucket/project 返回任务树(根 + 活跃子树);TaskRow 加 depth/chevron/progress;新增递归 `TaskTree` 组件;详情弹窗子任务区改嵌套树;右栏属性面板改 toggle;CLI `list` 输出树状缩进。
- **M5R5 验收标准**:
  - [ ] 详情右栏:Priority=中 等有值项点文字即可改;Date/Deadline 等无值项显示 ＋
  - [ ] Inbox/项目视图里带子任务的任务显示为可展开/折叠的树,含 "0/1" 计数
  - [ ] CLI `list` 以缩进显示子任务层级;与 App 一致

**M5R6 — 拖拽重排 + 嵌套(2026-08-09 用户追加,M6 之前)**

- 反馈:允许拖拽任务条目换位,或拖成 nested task(子任务);然后开始 M6。
- **反馈 v2(2026-08-09)**:拖拽应是"上下拖换位、向右拖 indent、向左拖 outdent";不要再"拖进方框中间"才嵌套(参照 Todoist 交互)。
- 实现(D-24 / INV-27):`Task.sortOrder`(同级组按 sortOrder+createdAt 排,反对称比较器);`reorderTask` usecase(设 parentTaskId + 整组重排,约束沿用 INV-25:同容器、不成环、深度 ≤5;`beforeId===自身` 视为追加末尾而非报错);顶层追加改用 `nextRootSortOrder`(按 `isTaskListRoot` 展示根集,修复孤儿子任务根撞序);迁移 v5 加 sort_order;IPC 排序改 sortOrder + `gtd:tasks.reorder`;CLI `reorder <任务> [--parent=|--top] [--before=]`(`--top` 走 flag() 校验)、`list all` 跨组按 createdAt、`list project` 根按 (projectId, sortOrder)。
- **UI 拖拽 v2**:`TaskTree` 重写为**扁平行 + 缩进**;上下拖 = 在候选行间隙换位(live 蓝线),左右拖 = 由水平位移控制缩进(indent/outdent),层级在 `[下一行 depth, min(上一行 depth+1, 5-子树高度)]` 内夹取;落点解析出 `{parentTaskId, beforeId}` 交 reorderTask;候选集排除被拖子树 → `beforeId`/`parentTaskId` 永不等于自身。
- **拖拽 v2 反馈修复(2026-08-09,评审 + 用户复测)**:
  - 拖拽时被拖子树整体隐藏 → 间隙/蓝线与光标对齐(修"蓝线位置不对/不缩进");
  - 子树高度改从 VM 计算(独立于折叠)→ 折叠后拖拽的缩进预算正确;
  - 详情弹窗复用 `TaskTree` 传 `reorderable=false`(弹窗内 depth-0 是子任务非容器顶层,拖拽会误摘父子关系 —— 评审 HIGH);
  - reorderTask 顶层组改用 `isTaskListRoot`(仅 active)口径 → 可相对"孤儿根"重排、重编号一致(评审 MEDIUM)。
- **Today 拖拽(2026-08-09 用户定案:仅推迟,排序留 M6)**:Today 是跨 bucket 按日计算视图,手动排序无干净落点 → 本轮只做**拖到底部推迟到明天**(改 `scheduledDate`,域内/CLI 一致);完整上下手动排序随 M6 的 Today/日历/agenda 重做(届时时间驱动)。
- **第三轮评审修定(2026-08-09)**:
  - Chromium 拖拽源在 dragstart 同任务内 display:none 会取消拖拽(用户复测"完全拖不动")→ 延迟一个宏任务再隐藏;
  - **Today due 口径**:`scheduledDate` 计划到未来 = 显式推迟,不再因过期 deadline 留在 Today(否则推迟过期截止项无效 —— 评审 HIGH);IPC 与 CLI 同步;
  - 孤儿根顶层重排**保留 done 父链接**(父 reopen 后回归;改父仅显式嵌套或从活跃父 outdent);
  - 拖拽缩进预算改用域口径 `subtreeHeight`(VM 带 height,计隐藏的 done 子任务);推迟基准日取主进程时钟(跨零点防陈旧)。
- **M5R6 验收标准**:
  - [ ] 上下拖任务换位,顺序持久化(重开 App 仍保持)
  - [ ] 向右拖 = 缩进成上一行的子任务;向左拖 = 返回上层;超 5 层 / 自身后代 / 跨 bucket → UI 夹取 + reorderTask 兜底拒绝
  - [ ] 拖回原位无报错、无副作用;live 蓝线随光标/缩进正确指示
  - [ ] 详情弹窗内子任务不可拖拽(避免误摘父子)
  - [ ] Today:拖任务到底部区块 → 推迟到明天(scheduledDate=明天)
  - [ ] CLI `reorder` 与拖拽同效;`list` 顺序一致

**M6c — Google Calendar 同步(2026-08-10 用户定案)**

- **模式 A(用户选定,= Todoist 做法)**:外部日历**只读**显示在 Calendar/Today;本应用的任务写进一个**由应用创建的专用日历**(名为 `Claudoist`),该日历**双向**同步。主日历永不被写入。
- **冲突策略**:**last-write-wins**(按两侧 updated 时刻比较,自动裁决,不打扰用户)。
- **凭据**:用户自建 Desktop OAuth client(2026-08-10 已建,project `Claudoist`)。client id/secret 由用户在应用内导入下载的 credentials JSON,存 `userData`(**不入 git、不入数据库**);refresh token 经 Electron `safeStorage` 加密后存 `userData`。授权走**系统浏览器 + 本地回环回调**(Google 禁止应用内嵌 webview 登录)。
- **scope(最小化)**:`calendar.app.created`(仅能读写**本应用创建的**日历 → 专用日历的双向同步)、`calendar.calendarlist.readonly`(取日历列表供勾选)、`calendar.readonly`(只读展示外部日历事件;sensitive scope,未验证应用授权时会出现"Google 未验证此应用"提示页,自用点开"Advanced → 继续"即可)。
- **子步与验收**:
  - **M6c-1 连接账号**:设置页(照 Todoist 版式)导入 credentials → 点「连接 Google」→ 系统浏览器授权 → 回到应用显示**已连接的账号邮箱**与**日历列表**;可「断开」(撤销 token 并清本地凭据)。
    - [ ] 点连接 → 浏览器弹出 Google 选账号/授权 → 应用显示 `已连接 <邮箱>`
    - [ ] 应用内列出你的日历(CSE 373 / Holidays / … )
    - [ ] 断开后本地 token 清除,再次连接可重新授权
    - [ ] token 落盘为密文(非明文可读);dev 与 prod 互不干扰
  - **M6c-2 外部日历只读导入(2026-08-10 实施)**:设置页每个日历一个 👁 开关(本地选择存 `settings` 表 `google.shownCalendarIds`,首次沿用 Google 侧订阅态);显示的日历其事件以**只读**形式出现在 Calendar 网格(虚线边 + 日历色,`pointer-events-none` 不挡建块/拖拽)与 Today(列表上方只读行)。事件读取用 `events.list` + `singleEvents=true`(展开重复事件),全天事件按 `end.date` 独占逐日展开,跨日事件在起始日呈现到 24:00。
    - [ ] 设置页点 👁 可切换某日历显示/隐藏,重开应用后保持
    - [ ] 勾选的日历事件出现在 Calendar 周网格(虚线样式,不影响建块/拖块)与 Today
    - [ ] 取消勾选后该日历事件消失
  - **M6c-2b 多账号(2026-08-10 用户定案)**:学校 Workspace 同时禁掉了「对外共享日历」与「密钥 iCal 地址」(只剩需要把日历设为公开的 public 地址),把工作账号**直接连上**是唯一不依赖管理员的办法。保险箱由 `{credentials, tokens}` 改为 `{credentials, accounts[]}`(旧形态自动就地迁移),client 凭据全账号共用;日历列表/事件按账号合并读取,单账号失败不影响其它账号;显示选择的键必须带账号(不同账号下同一个节日日历 id 相同)。
    - [ ] 设置页可「＋ 添加账号」连第二个账号,两个账号各自可单独 Disconnect
    - [ ] 日历列表按账号分组;两个账号里同名日历互不干扰
    - [x] 学校账号的 CSE 373 勾选后出现在 Calendar/Today(2026-08-10 用户验收通过)
  - **M6c-2b 复测修定(2026-08-10 用户反馈)**:①第一次点任一 👁 会把**所有**日历一起关掉 —— 显示态原是"白名单数组 + null 表示未设置",首次点击从空集开始增删,存下空白名单即全灭;改为**逐项覆盖表** `{账号::日历id: bool}`,只写被点的那一项,未记录的回落 Google 订阅态(新连账号的日历也因此仍有正确默认)。②不同日历的事件在同一时段**互相压住** —— 外部事件原是整列铺开且不参与任务块的重叠分栏;改为任务块与外部事件**同池计算**列分配,各占一列。
  - **M6c-3a 外部事件镜像为任务(2026-08-10 用户定案,取代只读展示)**:D-25/INV-29 —— 事件不再是只读装饰,而是真正的任务(可完成/标签/子任务/评论),只有标题与时间归 Google;`Task.externalId` + 迁移 v7;`syncExternalTasks` 幂等同步(不覆盖本地状态,外部删除时未完成软删、已完成留作历史);镜像不进 Inbox;日历网格里禁用其拖动/拉伸;详情弹窗的 Date/Time 行改为只读提示;每分钟轮询一次(桌面端拿不到 push)。
    - [ ] 在 Google 建的事件出现在 Today/Calendar,**可以勾完成**
    - [ ] 勾完成后过一分钟(重同步)仍是完成状态
    - [ ] 在应用里试图改它的时间 → 明确报错提示去 Google 改
    - [ ] 在 Google 改时间 → 应用里跟着变;Google 删掉 → 未完成的消失、已完成的仍在 Completed
    - [ ] Inbox 里不出现这些事件;它们在侧栏 **Upstream** 容器下
  - **M6c-3a 复测修定(2026-08-10 用户反馈)**:①已完成任务在日历上**完全锁死**(不拖/不拉/左键无效),须右键撤销完成后才能改;②外部镜像任务**左键可点开**详情(改优先级/标签/完成),只是不能改期;③镜像任务从"塞在 Inbox 再过滤"改为独立容器 **Upstream**(侧栏第四项,带计数);④拖拽吸附粒度 15 分钟 → **5 分钟**(更细的时刻在详情里填);⑤全天块**可拖回时间轴**设定时刻(同样只对未完成的本地任务开放)。
  - **M6c-3a 再复测修定(2026-08-10)**:①拖拽/拉伸的**预览**也按 5 分钟吸附(此前预览连续、松手才吸附,会看到 09:00–11:33 这种中间态);②镜像任务的"位置"显示为 **Upstream** 而非 Inbox(详情弹窗与编辑卡片同步);③**全天块支持右键菜单**(完成/撤销、移到全天、删除);④拖拽缩进时**被拖行保留占位** —— 原先整行抽走导致列表塌陷、Add task 上跳,缩进要"向右上"拖才行(项目里只有两条任务时尤其难);现在位置稳定,向右拖即缩进。
  - **M6c-3b 专用日历双向同步(2026-08-10 实施,D-26/INV-30)**:本应用**只写自建的 `Claudoist` 日历**(`calendar.app.created` scope —— 主日历连写权限都没有)。已排期的本地任务 → 该日历事件(定时/全天);指纹去重避免每轮重写;完成的任务留在日历上、标题加 `✓`;取消排期/删除 → 撤下事件。回同步:在该日历里拖动/改时长 → 任务改期,删除 block → 软删任务(唯一传播删除的路径);已完成任务不因日历改动改期或复活。镜像任务永不回推。domain 只算计划(`planPush` / `applyPulledEvents`),HTTP 在主进程。
    - [ ] **默认不写任何东西**;在设置页显式打开「把任务同步到日历」后才推送(关闭时可撤下已推事件)
    - [ ] 给任务设日期/时间 → Google 的 `Claudoist` 日历上出现事件
    - [ ] 改标题/时间 → 事件跟着变;勾完成 → 事件标题变 `✓ …` 且仍在日历上
    - [ ] 取消排期或删除任务 → 事件从日历消失
    - [ ] 在 Google 里拖动该 block → 应用里任务改期;删掉 block → 任务进 Trash
    - [ ] 镜像(Upstream)任务不出现在 `Claudoist` 日历里
  - **拖拽复测修定(2026-08-10)**:①上下移动不对称(向下几像素即触发、向上要挪一整行)—— 定位参考点从**光标**改为**被拖块上沿**(冻结几何是"抽走该块后"的坐标,拿光标比中线必然偏);横向缩进时不再动辄被判成向下移动。②落在"父与其子之间"时只能选子级 —— 下界放开到 0,选更浅层级时把后面那棵更深的子树**收养**到落点任务下(`a / └b / c` → 把 c 放到 a、b 之间选顶层 → `a / c / └b`);真正非法的"首行就缩进"仍由上界挡住。
  - **M6c 对抗评审修定(2026-08-10,24 项确认 / 12 HIGH)**:①全天任务推送后被自己判成"已删除"并软删 —— 读取侧把全天事件展开成 `id:日期`,与 `pushedEventId` 对不上;改用**原始事件 id** 对账。②把 block 拖出同步窗口 = 任务被删(Today 窗口只有一天)—— 删除改为**逐个 `events.get` 实证**,拖走的按新位置改期。③离线/单次 API 失败被当成"日历空了",窗口内镜像被批量软删、恢复后重建成空白任务 —— 改为**失败闭合**(只退休本轮成功拉取的日历),并让再次出现的镜像**复活原任务**。④专用 `Claudoist` 日历自己也在镜像源里 → 每个已推任务多一个孪生只读任务;已排除。⑤回拉无条件以 Google 为准 → 一次推送失败就把用户改期永久覆盖;改为**本地更脏则本轮本地优先**。⑥`google:sync` 可重入(Today 与 Calendar 各一个轮询)→ 串行化。⑦本地每次写都触发整轮同步 → 加 `staleTime`。⑧跨午夜时长被钳到 23:59 后回拉改小 → end 滚到次日。⑨`shouldPush` 不看 bucket(someday 里带日期的任务会被推上去)、推送默认时长与应用内回退不一致、专用日历 id 失效无恢复、同步失败对用户不可见、完成块右键仍可"移到全天"、resize 落库与预览差最多 4 分钟 —— 一并修。

**M6d — 时区(2026-08-10 用户定案,D-27/INV-31)**

- `Task.timeZone`:`null` = **浮动时间**(默认,= 既有 naive 语义 = Todoist 的 Floating time),否则 IANA 时区名。迁移 v9(存量全部视为浮动,无需回填)。
- 推送:浮动 → 不带 `timeZone`(由日历默认时区解释);指定 → 带上。回拉:浮动 → 读字面墙上时间;指定 → 用 `Intl` 换算到该时区。时区参与推送指纹。
- 详情弹窗 Time 行加时区下拉(浮动 / 本机时区);CLI `add|update --tz=floating|IANA`;镜像任务的时区归外部不可改。
- **M6d 验收标准**:
  - [ ] 新建带时刻任务默认显示「浮动时间」
  - [ ] 选本机时区后,该任务推到 Google 带时区;只改时区会重推一次
  - [ ] 镜像任务改时区被拒
  - [ ] CLI `--tz=America/New_York` / `--tz=floating` 生效

**M6 计划变更 — 日历统一 + Google Calendar 同步(2026-08-09 用户定案,取点 3/4/5;见决策日志 D-23)**

- 用户新方向:取消"hard landscape"特殊区分,**任务与日历事件统一**——带时间的任务即日历上的 block;任务↔日历双向同步(改一边同步另一边)。日历视图:all-day 区添加任务、单击小时格四等分(00–15 / 15–30 / 30–45 / 45–60)创建任务、拖选 time-block 创建任务;完成的任务**不从日历/Google 删除**,只在本地显示为完成;仅"删除 block"才双向传播删除并影响对应任务。**Google Calendar 双向 pull/push,可选 Google 账号同步**。
- 规模:Google OAuth + 同步引擎(冲突/去重/软删语义)+ 日历网格 UI(四等分点击、拖选、all-day),是独立大里程碑,故从 M5 拆出为 M6 主线;原 M6 的 Filters & Labels / ⌘K 搜索顺延至后续。
- (设计细化见 DESIGN 待补 §;domain 需引入 task 的 startAt/endAt 或 scheduledDateTime + 时长,替代 CalendarItem 作为独立"硬景观"实体。)

---

### M6 — 日历统一 + Google 同步(取代原"其余视图";下方原范围顺延)

**目标**:见上"M6 计划变更"。子步:**M6a 域模型统一** → **M6b 本地日历网格视图** → **M6c Google Calendar 双向同步**。以下为原"其余视图"范围,Filters/搜索/Reminders 顺延到日历之后。

**M6a — 域模型统一(2026-08-09 实施,用户选型:scheduledDate + startTime + durationMinutes)**

- Task 新增 `startTime`(HH:MM,null=全天/无时间)+ `durationMinutes`(null 回退 `estimatedMinutes`);带时间任务即日历 block。
- **CalendarItem 实体退役**:迁移 0006 把存量 calendar_items 迁为带时间任务(id 复用、date→scheduledDate、time→startTime、done→status、提醒随迁重挂任务),reminders 重建为仅挂任务,表删除;`sourceTaskJson` 随实体丢弃(INV-19 退役)。
- 语义并入:INV-05 activity 判定去掉 calendar 分支(带时间承诺就是 active Task);INV-20.1 calendar-first 改为"今天计划任务按时刻序"(`todaysTimedTasks`);Today/CLI today 无独立"硬边界"段,计划段排序 = 计划日 → 全天在前 → startTime 升序;quickAdd/addSubtask/updateTask + CLI `add/update --time/--duration` 全链路支持;TaskRow 🕐 时间 chip;详情弹窗右栏 Time 行(设/清)。
- **对抗评审修定(9 项确认)**:迁移在「有日历数据但零 context」的库上补 `@migrated` 兜底 context(否则 NOT NULL 使迁移失败、应用永久起不来 —— HIGH,含回归测试);详情弹窗 Time 行改**草稿 + 保存**(原 patch-on-change 每击键落库且首键后编辑器收起 —— HIGH;时刻中间态误存 / 清时刻遗留孤儿时长 —— MEDIUM,保存时空时刻连带清时长);done 日历项 completed_at 取 `MAX(created_at, date)`;addSubtask 重复校验块删除;CLI `--duration` 非法值回显原输入(不吐 NaN)、`add --time` 无 `--date` 输出提示;陈旧注释同步。
- **M6a 验收标准**:
  - [ ] 给任务设时间(如 15:00 / 45 分钟)→ Today 按时刻排在对应位置,无"日程(hard landscape)"段
  - [ ] 旧 CalendarItem(组会/健身房约练等)迁移后变成带时间任务,完成/编辑/删除行为与普通任务一致
  - [ ] CLI `today`/`add --time`/`update --time=none` 与 UI 同口径;全部测试绿

**M6b — 本地日历网格(2026-08-10 实施)**

- 新增 **Calendar** 视图(侧栏第三项,取代原 Upcoming 占位):周网格 7 列 + 左时刻槽 + 顶部全天段;24 小时滚动、首屏 07:00、今天列当前时刻红线;重叠块并排分栏。
- 交互(INV-28,全部复用既有 usecase,日历无独立写路径):单击刻度 → 默认 30 分钟块;拖选 → 该区间;全天段单击 → 全天任务(均经轻量 composer 输入标题 → `quickAddTask`);拖动块改日期/时刻、拖底边改时长、拖到全天段清时刻(→ `updateTask`);单击块开详情;右键完成/移到全天/删除(= 软删任务)。完成的块灰显仍在日历上。
- domain `rules/calendarGrid.ts`(INV-28)承载刻度吸附 / 区间换算 / 全天·定时分段口径,UI 与 CLI `calendar [--from=] [--days=]` 共用;新增 `addDaysIso` 供各处日期运算。
- IPC 新增 `gtd:calendar.range`(天数钳 1..31)。
- **实施中修定**:全天 chip 缺 `min-w-0` 溢出到邻列;详情弹窗 Date/Deadline/Time 一律改为**可自由键入 + 回车保存**的文本框(`YYYY-MM-DD` / `HH:MM`,不再用系统 locale 的原生日期框 —— 原生框敲第一个数字就凑成完整值触发保存并收起编辑器,且格式为 DD.MM.YYYY;2026-08-10 用户反馈),TaskCard/ProjectModal 的日期框同步;`bySortOrder` 与 calendarGrid 的本地比较器函数体逐字相同被打包器折叠,导致主进程启动 `ReferenceError` → 比较器下沉 `rules/subtasks.ts` 唯一实现,并新增 `pnpm smoke` 启动冒烟。
- **对抗评审修定(15 项确认)**:①单击非刻度对齐的块时 1px 抖动被判成拖动 → 静默改 startTime 且详情不弹(HIGH)→ 改用 **4px 像素阈值**判定单击/拖动;②CLI `calendar --from=` 无校验 → 非法值抛 RangeError 或静默算错一周、`from` 与 `days[]` 自相矛盾(HIGH)→ `isValidIsoDate` 校验 + 可读错误;③落到网格外仍提交(时刻由滚动位置外推)→ 落点必须在网格/全天条内,否则丢弃,并支持 **Esc 取消**;④全天段跨容器比 `sortOrder` 与 Today 顺序矛盾 → 统一 `createdAt`;⑤INV-28 "UI 与 CLI 共用"是假声明(renderer 被架构禁止 import 内层包)→ 文档改为**镜像实现 + 同步义务**,并把"单击 vs 拖选"判定收敛为 domain `blockFromDrag`(UI 镜像同一公式,消除短拖预览 15 分钟/实际建 30 分钟的分叉);⑥`addDaysIso` 非法输入抛 RangeError/静默滚月 → 读取侧宽容(原样返回)+ 调用方校验;⑦到午夜的块显示 23:59 与 `·60m` 自相矛盾 → `endTimeLabel` 显示 `24:00`;⑧全天段右键误弹 composer、右键菜单贴边被切、切周闪空(keepPreviousData)、拖动被截断块的预览跳变等。
- **M6b 验收标准**:
  - [ ] 在空白格单击 → 建 30 分钟任务;拖选 14:00–15:30 → 建 90 分钟任务(CLI `calendar` 可见同样内容)
  - [ ] 拖块到别的时段/别的天 → 时间与日期随之变;拖底边 → 时长变;拖到全天段 → 变全天
  - [ ] 单击块开详情;右键可完成/删除;完成后块仍在日历(灰显划线)
  - [ ] 全天 chip 不溢出列;今天红线位置正确;上一周/本周/下一周切换正常
  - [ ] 详情弹窗 Date/Deadline/Time 可直接键入(YYYY-MM-DD / HH:MM),**回车保存**、Esc 取消,无独立保存按钮
  - [ ] 单击块只开详情、不改数据(即使块起点不在 00/15/30/45);拖到网格外松手无变化;拖拽中 Esc 取消
  - [ ] CLI `calendar --from=abc|2026-13-45` 给可读错误;到午夜的块显示 `24:00`

**目标**:视图层补齐:Today 完整、Upcoming 周网格 + 拖拽改期、Filters & Labels、⌘K 搜索、Someday / Reference / Trash / Completed、Reminders。

**范围要点**
- ~~Today:hard landscape + due 两段~~ → **已由 M6a 取代**(D-23 日历统一:单一列表,无硬边界段)。
- ~~Upcoming:7 列周网格~~ → **已由 M6b 取代**(Calendar 视图);deadline 双轨 due chip 与拖拽改 deadline 顺延。
- Filters & Labels:contexts 固定徽章式展示(删除受 domain 规则约束)+ 自由 labels + `@waiting_for` 虚拟视图(保留 delegated_to、since、Resolve、Create-follow-up,不退化为普通 label);saved filters 由 domain `filterQuery` 解释器求值,预置 "Low energy · <15 min"、"Due this week"、"No project"、"High priority next",附表单式编辑器。
- ⌘K:cmdk 面板 over `gtd:search`,覆盖 tasks、projects、inbox、someday、reference、trash、done 归档、calendar、waiting-for + 命令项("Start Weekly Review"、"Focus mode"、"New conversation")。
- Reminders:调度器 → Electron `Notification`(落库与设置入口已随 M5R 提前;本里程碑接响铃)。
- (M6b 已做 `scheduledDate` 计划块;deadline due chip 双轨顺延至后续。)

**验收标准**
- [ ] 预置过滤器结果与 domain 计算结果完全一致(以 "Low energy · <15 min" 为对照用例)
- [ ] 搜索覆盖全部实体类型,seed 数据逐类可命中
- [ ] 拖拽改期经确认后正确持久化,calendar 与 deadline 语义不混淆
- [ ] 提醒按 `remind_at` 准时弹系统通知,`dispatched` 置位不重复弹
- [ ] `@waiting_for` 虚拟视图功能完整(Resolve + follow-up 模板)

**用户反馈**

(待填写)

---

### M7 — GTD 流程

**目标**:三大流程落地:Focus/engage、Weekly Review 6 步向导、完成级联 sheet、常驻孤儿徽章。

**范围要点**
- Focus/engage(Today 头部入口):calendar-first(当日有未处理 calendar item 先给它们)→ 选 context(带计数)→ 可用分钟 → 当前 energy → top-7 排序列表(min ≤ time ∧ energy ≤ user,priority 降序,展示 ~min / energy / P / DDL / 面包屑)→ "Do it" → 完成后追问对话框(定义下一步 / 建子项目 / 完成项目? / 跳过)→ 孤儿检查。
- Weekly Review 6 步向导(`gtd:flow.start {kind:'review'}`):1 处理 inbox(内嵌 clarify)· 2 逐 context 任务相关性清扫("不相关"= 软删除)· 3 项目树完整性清扫(无 next action 警告)· 4 waiting-for 清扫(follow-up 模板:`Follow up with X re: Y`,@phone 或首个 context,5 min,low,P4,同项目)· 5 someday 分诊(激活必回 inbox)· 6 calendar 通读;带进度条、可中断续跑。
- 级联 sheet:非模态,"X 的所有子项目已完成 —— 也完成 X 吗?";级联仅向上、必须征询、绝不自动。
- 常驻孤儿徽章:侧栏 `gtd:orphans.count`,每次 `gtd:changed` 重算,点击开 Fix-orphans sheet。
- 父项目 deadline **编辑**时一次性提示:"同步更新 N 个继承的子项 deadline?"(继承语义 = copy-on-create;编辑传播必须显式确认)。

**验收标准**
- [ ] 对 [./INVARIANTS.md](./INVARIANTS.md) 的 engage、weekly review、after-completion、级联、孤儿修复流程规格逐条走查通过
- [ ] calendar-first 规则生效;推荐排序与 domain `engageRanking` 一致
- [ ] Review 第 2 步"不相关"执行软删除(status='deleted',Trash 可恢复)
- [ ] 级联从不自动发生,每一级都单独征询
- [ ] 父项目 deadline 编辑弹出继承子项同步提示,选择结果正确落库
- [ ] Weekly Review 中断后可恢复进度

**用户反馈**

(待填写)

---

### M8 — Agent 只读版

**目标**:右栏 agent 面板上线(只读):SDK 会话管理、API key onboarding、流式聊天 + 工具 chip、只读 GTD 工具、成本护栏、中断。

**范围要点**
- `sessionManager.ts`:每会话一个长驻 streaming-input `query()`(`prompt` 为 `AsyncIterable<SDKUserMessage>`),`includePartialMessages: true`,`SDKMessage` 序列化后经 `agent:stream` 推给 renderer。
- 认证引导(自用路线,DESIGN.md §6.1):首启检测本机 Claude Code 登录可用性;不可用时引导用户在终端完成 `claude` 登录后重试。备用路径:Settings 可录入 `ANTHROPIC_API_KEY` → `safeStorage` 加密存 `userData/secrets.bin`,经 `options.env` 注入(优先于主路径);`settings:apiKey.status` 只返回是否存在,绝不返回 key。
- `CLAUDE_CONFIG_DIR` = `userData/claude`;`settingSources` 排除 `'user'`(`~/.claude/settings.json` 不得影响应用行为)。
- 只读工具入 `allowedTools`:`mcp__gtd__list_inbox`、`list_tasks`、`get_task`、`list_projects`、`get_project`、`list_calendar`、`list_waiting_for`、`list_contexts`、`list_labels`、`list_filters`、`search`、`get_engage_recommendations`、`list_orphan_projects`、`get_status_summary`(`createSdkMcpServer({ name:'gtd' })`,handler 直连 main 的同一 `GtdStore`)。
- System prompt 固化易错不变量(priority 1=最低 5=最高;energy 过滤方向 任务 ≤ 用户;calendar/waiting 计入项目 active action;someday 激活必回 inbox)+ 每次会话注入轻量状态快照(日期、contexts 及计数、inbox 数、孤儿项目数)。
- 护栏:每次 `query()` 带 `maxTurns` + `maxBudgetUsd`(settings 可配);`agent:interrupt` 接 AbortController;应用退出清理子进程。
- 流式渲染:`stream_event` 状态机(text_delta / tool_use chip + input_json_delta / tool_result 折叠附着)。

**验收标准**
- [ ] 问"本周有什么要到期?",经**可见的** `mcp__gtd__list_tasks` 工具 chip 得到正确回答
- [ ] 已登录本机 Claude Code 的环境零配置直接可聊;未登录环境给出清晰引导
- [ ] 面板 footer 显示本会话 token 累计(成本金额为辅,订阅计费下可为 0)
- [ ] 中断按钮立即终止当前 turn,会话可继续
- [ ] 只读版无任何写路径:写工具未注册,agent 无法改动数据
- [ ] 若使用备用 API key 路径:key 只存在于 `secrets.bin`(加密),日志与 IPC 中不出现明文

**用户反馈**

(待填写)

---

### M9 — Agent 写入 + 权限

**目标**:agent 获得写能力,同时建立完整权限与审计体系:canUseTool 审批弹窗、五种权限模式、destructive class、`agent_audit`、实时刷新 + actor toast。

**范围要点**
- 写工具全集(`mcp__gtd__` 前缀):`capture`、`clarify_inbox_item`、`create_task`、`update_task`、`complete_task`、`delete_task`、`create_project`、`update_project`、`complete_project`、`decompose_project`、`create_waiting_for`、`resolve_waiting_for`、`create_follow_up`、`create_calendar_item`、`complete_calendar_item`、`move_to_list`、`activate_someday`、`add_context`、`manage_labels`。
- **后果返回约定**:所有写工具返回 consequence 字段(`parentCompletionCandidate`、`inheritedDeadline`、`projectHasRemainingActivity`、`completedSubtaskCount` 等),agent 像 CLI 一样"征询后再级联",绝不自动连锁完成。
- 权限模式选择器(Manual / Edit automatically / Plan / Auto / Bypass)→ SDK 选项组合(`permissionMode`、`allowedTools`、`canUseTool`、`allowDangerouslySkipPermissions`)在**单一 policy 模块**中定义;Bypass 藏在确认弹窗后、打包版默认禁用。
- **destructive class**:`delete_task`、`remove_context` 等破坏性工具即使在 Auto / Edit automatically 模式也必须弹窗;审批弹窗支持 "Always allow <tool>" 持久化到 settings。
- `canUseTool` → `agent:permission.request` 推送 → 审批模态(工具名 + 美化输入 + Allow / Always allow / Deny)→ `agent:permission.respond` 回传 `{ behavior, updatedInput? }`。
- **`agent_audit`**:每次 agent 工具调用落一行(工具名、输入、权限决定 allowed-auto / allowed-user / denied、结果摘要、conversation_id、时间)。
- 写路径复用与 UI 完全相同的 domain usecase;每次变更发 `gtd:changed`(带 actor);agent 引起的变更在中间栏行高亮 + toast("Claude: 更新了 3 个任务")。

**验收标准**
- [ ] Manual 模式下说"把买牛奶加到 errands":弹审批 → 批准后任务**即时**出现在中间栏并高亮 + toast
- [ ] Plan 模式拒绝一切写工具
- [ ] Auto 模式下普通写工具直通,但 `delete_task` 仍弹审批(destructive class)
- [ ] "Always allow <tool>" 生效并跨会话持久化
- [ ] `agent_audit` 完整记录上述每次调用(含 denied 的)
- [ ] `complete_task` / `complete_project` 的级联始终经 agent 征询用户,绝无自动连锁
- [ ] 五种权限模式各有一条集成测试,断言其 SDK 选项组合与实际行为

**用户反馈**

(待填写)

---

### M10 — Agent 面板补全

**目标**:agent 面板功能补全:会话列表 / resume / fork、新建会话、图片粘贴、拖拽附件、模型与 effort 切换、thinking 三态、用量账本、coaching evals。

**范围要点**
- 会话管理:`conversations` 表为索引(标题、模型、成本、最后活动);打开历史会话用 `getSessionMessages(sdk_session_id)` 渲染 transcript 后以 `resume` 续接;fork 用 `resume + forkSession: true` 并记录 `forked_from`;新建会话按钮 + 删除(同时删 DB 行与 jsonl)。
- 图片粘贴:Composer `onPaste` 读剪贴板 blob → base64 content block(按 M1 结论;若走兜底则落盘附件目录 + 内置 `Read`)。
- 拖拽附件:文件复制进 `userData/attachments/<uuid>/`,该目录为唯一稳定的 `additionalDirectories` 根(避免逐目录授权);附件 chip 展开为绝对路径供内置 `Read`。
- 模型 / effort 切换:end-and-resume(仅 turn 间隙可切、流式中禁用控件、短暂 handoff 提示);thinking 三态(Off / On-hidden 带计费警告 / On-shown 折叠灰块)。
- 用量账本:每条 `ResultMessage` 的 cost/usage 累计入 `conversations` 与全局 ledger;footer 显示本会话 / 全部历史成本。
- **Coaching evals**:录制 clarify / engage / review / decompose 的 agent 会话脚本,对照 playbook 断言,作为 system prompt 与工具序列的回归测试。

**验收标准**
- [ ] 退出应用重启后 resume 会话,上下文完整(agent 记得此前对话)
- [ ] fork 产生分叉:两条会话各自独立演进
- [ ] 粘贴截图被模型正确描述
- [ ] 拖入文件被复制到附件目录且 agent 可读;原路径不被直接授权
- [ ] 模型切换后历史保留;流式中切换控件被禁用
- [ ] thinking 三态行为与计费警告符合设计
- [ ] 用量账本数字与 `ResultMessage` 累计一致
- [ ] coaching eval 脚本可运行且断言通过

**用户反馈**

(待填写)

---

### M11 — 打包加固与打磨

**目标**:达到"第三方用户拿到 dmg 即可完整使用"的出厂质量。

**范围要点**
- 无 Node 机器上全流程复验(M1 只验了最小会话,这里验全功能)。
- Finder 启动 PATH 修复(fix-path 模式),保证 GUI 启动时 agent 子进程与工具链可用。
- macOS hardened runtime + notarization(凭据走 CI secrets,绝不入库)。
- 主题(light / dark)。
- 错误上报面:用户可见的错误提示与日志入口(`userData/logs/`)。
- Bypass 权限模式在打包版默认禁用的最终核验;SDK 版本 bump 后重跑打包冒烟(session transcript 兼容性风险)。

**验收标准**
- [ ] 干净 macOS 账户:安装 dmg → 完成认证引导(本机 Claude Code 登录或备用 API key)→ 完整 clarify 一批 inbox → 一次 agent 写入,除认证引导外全程无终端
- [ ] notarized 构建通过 Gatekeeper,无签名警告
- [ ] Finder 启动与终端启动行为一致
- [ ] 主题切换即时生效并持久化
- [ ] 错误发生时用户能看到可理解的提示并找到日志

**用户反馈**

(待填写)

---

## 5. 决策日志

| 日期 | 决策 | 说明 | 状态 |
|---|---|---|---|
| 2026-08-08 | 采用 CLEAN 分层架构 + 评审嫁接项 | 获胜方案:`@gtd/domain`(纯 TS)← `@gtd/storage-sqlite` / `@gtd/agent-tools` ← `apps/desktop`,Electron + Agent SDK in main;并入 13 项评审嫁接项(里程碑重排 spike 提前、`agent_audit`、写工具后果返回、destructive class、system prompt 固化不变量、actor 事件、附件暂存目录、父 deadline 编辑提示、图片兜底、priority 显示规则、`reminders`、coaching evals、monorepo 降级预案)。详见 [./DESIGN.md](./DESIGN.md) | ✅ 已定 |
| 2026-08-08 | 放弃 legacy 数据迁移 | `gtd_data.json` 与 `get_things_done.py` 均删除,不做导入。schema 无 legacy 字段、无导入 UI/里程碑;[./INVARIANTS.md](./INVARIANTS.md) 成为 GTD 业务规则唯一权威来源(必须完备自足);视图开发以 `pnpm seed` 演示数据替代真实数据验证 | ✅ 已定 |
| 2026-08-08 | 确立按步验收协作流程 | 每里程碑:步前预告(做什么 + 验收标准)→ 实现 → 用户试用反馈 → 通过后进入下一步;文档随进度持续更新(见第 1 节) | ✅ 已定 |
| 2026-08-08 | Agent auth 部署方式 | **已定:自用构建**(用户裁决)。主路径 = 复用本机 Claude Code 订阅登录(不注入 API key);备用路径 = Settings 录入 `ANTHROPIC_API_KEY`(safeStorage)。`CLAUDE_CONFIG_DIR` 重定向后凭据可用性在 M1 spike 实证。将来若对外分发必须切换 BYO key(切换点:sessionManager 的 `options.env`)。详见 [./DESIGN.md](./DESIGN.md) §6.1 | ✅ 已定 |
| 2026-08-08 | 审批弹窗 UI 规格 | 应用户要求补充弹窗设计:面板内模态、人性化工具名与摘要 + 可展开原始参数、普通/destructive 双变体(destructive 红色强调、无 Always allow、回车不确认)、等待态与排队规则。见 [./DESIGN.md](./DESIGN.md) §6.5;M9 步前预告展示视觉稿 | ✅ 已定 |
| 2026-08-09 | **D-21:项目平面化 + 任务子树(Todoist 对齐)** | 用户 M5R2/M5C 试用反馈定案:去掉 orphan project 与 subproject,"只有 project, 然后就是 task. task 如果不是 actionable 就拆解成 subtask",子任务嵌套 ≤5 层;单击任务弹详情窗(与右键编辑不同),可加子任务与评论;My Projects 平面列表带计数徽章/折叠/新建/右键编辑,总览显示进度;Today 与 Inbox 同构可直接添加;侧栏 GTD 项带计数。INV-06/07/08/09/11/13/18/19 退役,INV-25/26 新增,向导 flows 删除。详见 INVARIANTS D-21 行 | ✅ 已定 |
| 2026-08-09 | **CLI 操作通道(`@gtd/cli`)** | 用户要求:支持 CLI 操作任务,使 Claude Code 可经 Bash 调用命令行操作数据(M8/M9 MCP 之前即可用,之后并存)。复用 domain usecase 唯一写路径;WAL + busy_timeout 处理同库多进程;main watch DB 文件广播 `gtd:changed` 实现窗口实时刷新。见 DESIGN §6.7 | ✅ 已定 |
| 2026-08-09 | **容器(bucket)模型定案,对齐 Todoist 心智** | M5R 验收反馈:"转为任务后找不到了"暴露模型错位。定案:task 生在 Inbox、不挪不消失;`Task.bucket = inbox/project/someday/reference`;理清 = Move to(树形选择器)或勾完成;InboxItem 与分步 clarify 状态机降为 legacy;Trash 视图移除(右键软删)、Weekly Review 移出侧栏、Completed 保留(增长归档策略后续);Inbox 无"让 Claude 理清"按钮(右栏对话即是)。INVARIANTS D-20、DESIGN §5/§8/IPC 已同步 | ✅ 已定 |
| 2026-08-08 | **理清交互定案:双路径,弃分步向导 UI** | M5 验收反馈:逐题问答过重。定案:① Add task = Todoist 式单卡(name+description+属性 chip;位置=Inbox 且零属性 → 纯捕捉,否则直建 Task);② Inbox 理清 = 条目展开同款卡片直接 specify(转 Task/Project/归档/删除,单条目一次事务)或交给 Claude 对话(M8/M9);分步状态机保留为 agent 与 Weekly Review 内部机制。配套:Task 新增 `description`/`scheduledDate`(Todoist 式"哪天做",Today 口径三段);attachment 并入 M10,location 不做。INVARIANTS D-18/D-19、DESIGN §5/§8 已同步 | ✅ 已定 |
| 2026-08-08 | **数据层:`node:sqlite` + 手写 SQL,弃用 better-sqlite3 + drizzle** | 依据:① better-sqlite3 双 ABI 结构性冲突(dev 的 Electron Node 24 与测试的系统 Node 无法共用原生编译产物,M4 必然爆发);② 实测 node:sqlite 在 Node 23.4 与 Electron 43 均免 flag 可用;③ drizzle 无 node:sqlite 驱动。正确性由 domain store-contract 套件(`applyToSnapshot` 对拍)保证;迁移 = `PRAGMA user_version` + TS 内嵌 SQL。详见 [./DESIGN.md](./DESIGN.md) §2.2 | ✅ 已定 |

---

## 6. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-08 | 文档初版:协作流程、Definition of Done、里程碑 M0–M11(全部 ⬜)、决策日志、变更记录 |
| 2026-08-08 | 用户裁决落档:auth = 自用(复用本机 Claude Code 登录,API key 为备用);审批弹窗 UI 规格写入 DESIGN.md §6.5;M1/M8/M11 相应调整;M0 开工(🔄) |
| 2026-08-08 | M1 技术验证完成待用户验收:auth 定案(不重定向 CLAUDE_CONFIG_DIR)、图片原生可用、打包 = asarUnpack + 路径重写二件套(原生二进制,无需系统 Node);DESIGN §4.3/§5.2/§6.1/§6.2/§7/§9 与风险表 1/3/9 按实证定稿 |
| 2026-08-08 | 数据层定案落档(node:sqlite,详见决策日志):DESIGN §2/§3/§5/风险 6/11 与 M3 范围同步;M3 开工(🔄) |
| 2026-08-08 | M2 实现完成待用户验收:`@gtd/domain` 全量落地(9 流程 + 12 usecase 域 + 36 spec/173 测试,INV/BUG 覆盖 29/29);DESIGN §5.4(单次调用传播模型)、§6.3(create_task INV-10 无条件覆盖、resolve_waiting_for 零后果)按 INVARIANTS 权威修订 |
| 2026-08-08 | M0 实现完成待用户验收:monorepo + electron-vite 三目标 + 三栏壳 + dmg + lint/typecheck/test/CI 骨架;DESIGN §3.2/§9.1/§9.2/§10 按实现同步(lint 机制、userData 实际目录名) |
| 2026-08-08 | **产品更名 Claudoist**(M0 验收反馈):productName/appId(`com.windlike.claudoist`)/窗口标题/文档全部更新;内部包保持 `@gtd/*`;userData 目录改为 `Claudoist(-dev)`,旧 `GTD Agent(-dev)` 目录作废;远程仓库 github.com/Wind-2375-like/claudoist |
| 2026-08-08 | INVARIANTS.md 经对照 Python 源码逐条校验后修订 8 处(§4.8 不可达分支标注、§4.3 断言补例外、BUG 编号引用统一、§4.11 Step 3 即时重判语义、INV-14 resolve 边界、§4.9 递归死端合法、D-17 新增、INV-17 归因修正);DESIGN.md 拆分 `resolve_waiting_for`/`create_follow_up` 工具、context 删除改为 archive 机制(§5.3)。随后删除 `get_things_done.py` 与 `gtd_data.json`,仓库自此纯源码 |
