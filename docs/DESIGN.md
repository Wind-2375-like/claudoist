# Claudoist — 架构设计文档

> 本文档是 Claudoist 桌面应用的架构权威。GTD 业务规则(不变量、流程规格)的唯一权威是 [./INVARIANTS.md](./INVARIANTS.md);里程碑、验收标准与进度跟踪见 [./ROADMAP.md](./ROADMAP.md)。
>
> 最后更新:2026-08-08。

---

## 1. 概述与目标 / 非目标

### 1.1 产品定位

把原 Python CLI GTD 工具重构为 **Todoist 风格的 macOS 桌面应用**,三栏布局:

- **左栏 menu**:Add task、Inbox、Today、**Calendar**(M6b 周网格,取代原 Upcoming 占位)、Search、Filters & Labels、My Projects(平面项目列表,带计数徽章,可折叠/新建)、GTD 组(Someday/Maybe、Reference、Completed;D-20/D-21 精简)。
- **中栏 content**:当前视图内容(任务列表 / 单项目视图 / My Projects 进度总览)与任务详情弹窗(子任务、评论)。
- **右栏 agent**:嵌入式 Claude agent 聊天面板,通过 MCP 工具读写同一份 GTD 数据,与 UI 实时联动。

产品名 **Claudoist**(2026-08-08 M0 验收时由用户定名,原名 GTD Agent),appId `com.windlike.claudoist`,仓库 [claudoist](https://github.com/Wind-2375-like/claudoist)。内部包命名保持 `@gtd/*`(方法论命名,与产品名解耦)。

### 1.2 目标

1. 承接 CLI 的 GTD 方法论并按用户反馈 Todoist 化(D-18/D-20/D-21):capture → 容器式理清(Move)→ 执行;平面项目 + 任务子树(≤5 层)+ 评论;deadline 继承、完成后果提示、软删除等存续规则以 [./INVARIANTS.md](./INVARIANTS.md) 为准(层级项目/孤儿/向导流程已退役)。
2. 嵌入 Claude Agent SDK,agent 与 UI 共享同一数据与同一套 use-case 代码路径,agent 的每次变更在 UI 中即时可见、可审计、可控权限。
3. 工业级工程标准:strict TypeScript、强制依赖方向、领域不变量全测试覆盖、CI、按里程碑交付并验收。
4. 打包为可分发的 dmg:在没有安装 Node 的干净 macOS 机器上,全程无终端完成安装、录入 key、GTD 流程与 agent 对话。

### 1.3 非目标(当前版本)

| 非目标 | 说明 |
|---|---|
| mobile / web 客户端 | 暂不做,但架构不封死:`@gtd/domain` 与 `@gtd/agent-tools` 为纯 TS 包,未来 Expo(drizzle `expo-sqlite` 驱动)或 Hono/tRPC 服务端可原样复用 |
| 多设备同步 | 暂不做;`GtdStore` port 抽象保留 libsql/Postgres 适配器的接入点 |
| legacy 数据迁移 | **已决定不做**(2026-08-08 用户决策):不提供任何旧数据导入;视图开发用 `pnpm seed` 生成演示数据 |
| Windows / Linux 打包 | macOS 优先;electron-builder 配置不排斥后续扩展 |
| 本地模型 / 离线模式 | SDK 无离线能力,不设计本地模型回退 |

---

## 2. 技术选型

所有版本号于 2026-08-08 对 npm 核实。

| 层 | 选择 | 版本 | 理由 |
|---|---|---|---|
| 运行时 | Electron | 43.x(Chromium 150 + Node 24) | Agent SDK 是 JS-only 且需 spawn 子进程与文件系统,天然属于 Node main process;同类应用(Cherry Studio、Crystal、官方 Agent SDK starter)全部是 Electron。8 周更新节奏,pin 最新 stable 并跟车 |
| 语言 | TypeScript | 5.x,strict 全开 | 全仓统一;domain 包零框架依赖便于复用 |
| Monorepo | pnpm workspaces | 最新 stable | 包边界即依赖方向;降级预案见 §3.4 |
| 构建 | electron-vite | 5.0.0 | main/preload/renderer 三目标构建;比 Electron Forge 的 Vite 插件(至今标注 experimental)更成熟,是 Claude 桌面应用生态的实战组合 |
| 打包 | electron-builder | 26.15.3 | dmg + zip,macOS 优先;自动 `install-app-deps` 重建原生模块;`asarUnpack` 是 Agent SDK 能跑的关键(§9.3) |
| 渲染层 | React | 19 | 生态与同类应用一致 |
| 样式 | Tailwind CSS | 最新 stable | 快速构建三栏布局与主题 |
| 视图状态 | Zustand | 最新 stable | 轻量本地 UI 状态 |
| 服务端状态 | TanStack Query | 最新 stable | 以 IPC 为"服务端",`gtd:changed` push 驱动缓存失效,agent 写入即时反映到中栏 |
| 命令面板 | cmdk | 最新 stable | ⌘K 搜索 |
| 拖拽 | (自研,原生事件) | — | 列表重排/缩进用 HTML5 DnD(M5R6);日历网格建块/拖动/拉伸用鼠标事件(M6b,网格内定位需精确到像素,HTML5 DnD 不可靠)。@dnd-kit 未引入 |
| 长列表 | react-window | 最新 stable | Completed / 搜索结果虚拟化 |
| 自然日期 | chrono-node | 最新 stable | 快速添加对话框的自然语言日期解析 |
| 数据库 | **`node:sqlite`(运行时内置)** | Node ≥23.4 / Electron 43(Node 24) | **M3 定案(2026-08-08),启用原风险表预留的逃生通道**:零原生编译,dev(Electron 的 Node 24)、测试(系统 Node)、CI 三个运行时同一份代码——better-sqlite3 的双 ABI 问题(Electron 编译产物与系统 Node 互不可载)在 M4 是结构性爆发点,就地消解。同步 API 保持"main 单写者"串行化语义 |
| 数据访问 | 手写 SQL + `PRAGMA user_version` 迁移 | — | drizzle 无 node:sqlite 驱动;本应用查询极简单,正确性由 domain 的 store-contract 套件(对拍 `applyToSnapshot` 参照实现)保证;迁移以 TS 常量内嵌 SQL 提交(打包无资产解包问题) |
| Agent | @anthropic-ai/claude-agent-sdk | 0.3.226(peers:zod ^4、@anthropic-ai/sdk >=0.93.0、@modelcontextprotocol/sdk ^1.29.0) | 官方 SDK;in-process MCP server(`createSdkMcpServer`)让 GTD 工具直连同一 store 实例 |
| 密钥 | Electron `safeStorage` | 内置 | OS keychain 加密,无 keytar 原生依赖 |
| 测试 | Vitest | 最新 stable | domain 包纯 Node 运行,无 Electron/SQLite 依赖 |
| 原生重建 | @electron/rebuild | 最新 stable | dev 环境 better-sqlite3 ABI 重建;打包时由 electron-builder 接管 |

### 2.1 为何否决 Tauri

Tauri v2 有 ~10x 更小的体积与更低内存,且官方支持 Node sidecar(甚至 SDK 文档提供 `extractFromBunfs()` 支持 bun 单文件编译)。但对本应用是净损失:

1. **三层进程链**:Rust commands ↔ JS sidecar ↔ SDK 自己 spawn 的 CLI 子进程,权限回调(`canUseTool` → 审批弹窗)要跨两跳 IPC 重复搭桥。
2. **数据层割裂**:SQLite 要么进 Rust(tauri-plugin-sql),要么进 sidecar,而 domain 逻辑在 TS,注定两头维护。
3. **需求全部是 Node 原生能力**:Agent SDK 是 JS-only、better-sqlite3、子进程管理、VSCode 扩展式聊天 UX——都在 Node main process 里零成本。
4. **前车之鉴**:走 Tauri 路线的 opcode(ex-Claudia)绕开 SDK 直接 spawn CLI,现已停止维护;活跃维护的嵌入方(Cherry Studio、Crystal/Nimbalyst、官方 starter)全部是 Electron。

只有当包体积/内存是硬性要求且接受 sidecar 税时才值得选 Tauri。本项目不满足该前提。

### 2.2 数据层定案(M3,2026-08-08)

原方案(better-sqlite3 + drizzle)在 M3 实施前被否决,直接启用逃生通道:

- **否决原因**:双 ABI 结构性冲突——`pnpm dev` 的 Electron(Node 24 ABI)与 vitest 的系统 Node 无法共用同一份 better-sqlite3 原生编译产物,dev 与测试必然一方崩溃;且 drizzle-orm 0.45 并无 node:sqlite 驱动可作折中。
- **现方案**:`node:sqlite`(`DatabaseSync`,同步 API)+ 手写 SQL;迁移 = `PRAGMA user_version` + 按序号排列的 TS 内嵌 SQL 常量(`src/migrations/`,是源码、提交入库、打包随 bundle 走无 asar 资产问题)。schema 权威仍是本文档 §5.1,迁移文件逐字转写。
- **正确性护栏**:domain 包提供 store-contract 场景套件(以纯函数 `applyToSnapshot` 为参照实现,对全部 Command 种类做结果对拍 + 事务原子性/回滚断言),任何 `GtdStore` 适配器必须全绿。
- **约束**:Node ≥23.4(`node:sqlite` 免 flag;CI 用 Node 24,Electron 43 内置 Node 24);API 带 experimental 警告,升级 Node/Electron 时以 contract 套件为回归门禁。

---

## 3. 架构总览

### 3.1 Monorepo 包结构

```
open_gtd_agent/
├── pnpm-workspace.yaml
├── package.json                      # workspace 根:scripts、eslint boundaries 配置
├── tsconfig.base.json
├── docs/                             # DESIGN.md、INVARIANTS.md、ROADMAP.md
├── packages/
│   ├── domain/                       # @gtd/domain — 纯 TS,零框架依赖
│   │   ├── src/
│   │   │   ├── entities/             # task.ts, project.ts, waitingFor.ts, calendarItem.ts,
│   │   │   │                         #   inboxItem.ts, context.ts, label.ts, filter.ts, reminder.ts
│   │   │   ├── ports/                # gtdStore.ts(接口), clock.ts, idGen.ts
│   │   │   ├── rules/                # deadlineInheritance.ts, projectHealth.ts, subtasks.ts,
│   │   │   │                         #   energy.ts, engageRanking.ts, filterQuery.ts
│   │   │   ├── flows/                # framework.ts(仅存 FlowDeps 等共用类型;
│   │   │   │                         #   向导状态机已随 D-21 删除)
│   │   │   └── usecases/             # captureToInbox.ts, createTask.ts, completeTask.ts,
│   │   │                             #   searchAll.ts, …(UI IPC 与 MCP 工具共用的唯一写路径)
│   │   └── test/                     # Vitest:INVARIANTS.md 每条不变量一个命名 spec
│   ├── storage-sqlite/               # @gtd/storage-sqlite — node:sqlite 实现 GtdStore(§2.2)
│   │   ├── src/store.ts              # SqliteGtdStore(snapshot/apply,手写 SQL)
│   │   ├── src/db.ts                 # openDb:DatabaseSync + PRAGMA(WAL/foreign_keys)+ 迁移
│   │   ├── src/migrate.ts            # PRAGMA user_version 迁移器
│   │   ├── src/migrations/           # 按序号的 TS 内嵌 SQL 迁移(是源码,提交入库)
│   │   └── scripts/seed.ts           # `pnpm seed`:向 dev userData 数据库写入演示数据(dev-only)
│   └── agent-tools/                  # @gtd/agent-tools — tool() 定义 + createSdkMcpServer 工厂
│       └── src/tools/                # 每工具一文件,zod schema,经 GtdStore 调 domain usecases
├── apps/desktop/
│   ├── electron.vite.config.ts
│   ├── electron-builder.yml          # asarUnpack @anthropic-ai/**、mac target、appId
│   ├── src/main/
│   │   ├── index.ts                  # app 启动、isPackaged→'-dev' userData、CLAUDE_CONFIG_DIR
│   │   ├── db.ts                     # 在 userData/data 打开 sqlite、跑迁移
│   │   ├── ipc/                      # gtd.ts, agent.ts, settings.ts — ipcMain.handle 注册
│   │   ├── agent/                    # sessionManager.ts(query() 生命周期、streaming iterable、
│   │   │                             #   canUseTool 桥、成本累计)、policy.ts(五种权限模式→SDK 选项)、
│   │   │                             #   cliPath.ts(asar.unpacked 路径重写)、audit.ts(agent_audit 写入)
│   │   ├── reminders.ts              # 提醒调度器 → Electron Notification
│   │   └── secrets.ts                # safeStorage 封装
│   ├── src/preload/index.ts          # contextBridge 类型化 API
│   └── src/renderer/
│       ├── src/views/                # Inbox/Today/Calendar/Project/Bucket(Filters/Search 待 M7)
│       │                             #   Someday, Reference, Trash, Completed, Search(cmdk)
│       ├── src/views/                # InboxView, TodayView, ProjectView, MyProjectsView, BucketView…
│       ├── src/agent/                # ChatPane, MessageStream, ToolUseChip, PermissionDialog,
│       │                             #   ConversationList, Composer(粘贴/拖拽)
│       ├── src/                      # TaskRow, TaskCard, TaskDetailModal, ProjectModal, …
│       └── src/state/                # zustand stores、TanStack Query client + gtd:changed 失效
└── .github/workflows/ci.yml          # lint、typecheck、domain/storage 测试、build
```

### 3.2 依赖方向

用 ESLint 分区 `no-restricted-imports` 规则(`eslint.config.mjs`,每个区块一组禁止模式)+ 各包 `package.json` 依赖声明双重强制(M0 实现决定:该方案零解析器配置、行为确定;`eslint-plugin-boundaries` 留作后续可选强化):

```
@gtd/domain  ←  @gtd/storage-sqlite
     ↑       ←  @gtd/agent-tools
     ↑       ←  apps/desktop (main)          renderer → 仅 preload IPC
```

- `@gtd/domain` 只 import TS 标准库(允许 zod,供对外共享校验 schema)。**不依赖** Electron、SQLite、SDK。
- storage、agent-tools、desktop 全部指向内;renderer 与 main 之间只有 IPC,renderer 永不 import 内层包。

### 3.3 包职责

| 包 | 职责 | 不允许 |
|---|---|---|
| `@gtd/domain` | 实体类型与字段语义、`GtdStore`/`Clock`/`IdGen` ports、规则函数(deadline 继承、项目健康/进度、子任务树、能量序、engage 排序、filter 解释器)、use-cases(唯一的写路径,返回 commands + consequences) | 任何 I/O、任何框架依赖 |
| `@gtd/storage-sqlite` | 以 `node:sqlite` 手写 SQL 实现 `GtdStore`(§2.2);`PRAGMA user_version` 迁移、seed 脚本;必须通过 domain 提供的 store-contract 测试套件 | 业务规则(全部上收 domain) |
| `@gtd/agent-tools` | SDK `tool()` 定义(zod 入参)、`createSdkMcpServer` 工厂;handler 只做参数校验 + 调 domain use-case + 组装后果返回 | 直接 SQL、绕过 use-case 写库 |
| `apps/desktop` main | 打开 DB(单连接单写者)、注册 IPC、运行 Agent SDK(sessionManager + policy + audit)、提醒调度器、safeStorage、DB 文件 watcher(§6.7) | — |
| `apps/desktop` renderer | 三栏 UI、任务详情弹窗、聊天面板;完全 sandboxed,经 preload 类型化 API 访问一切 | Node API、直接 DB/SDK 访问 |

### 3.4 Monorepo 降级预案

若 pnpm workspace + electron-builder 对原生模块(better-sqlite3 重建、asarUnpack 与 workspace 符号链接)的摩擦过大,**退化为单包 + `src/domain|storage|agent-tools|main|preload|renderer` 目录边界**,`eslint-plugin-boundaries` 继续以目录为单位强制同样的依赖方向。包边界的设计(接口、职责、测试套件)不变,只是物理形态变化,未来仍可无损拆回多包。

---

## 4. 进程模型与 IPC

### 4.1 Renderer(sandboxed)

`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、严格 CSP、`setPermissionRequestHandler`、`shell.openExternal` 前 URL 校验。renderer 不接触 SQLite、文件系统或 SDK;一切通过 preload 的类型化 API(`contextBridge.exposeInMainWorld('gtd', …)` / `('agent', …)` / `('settings', …)`),内部封装 `ipcRenderer.invoke` 与基于 `ipcRenderer.on` 的订阅助手。`ipcMain.handle` 侧校验 `event.sender`。

### 4.2 Main(单写者)

- 持有唯一的 drizzle/better-sqlite3 连接。better-sqlite3 是同步 API,**main 进程单写者天然串行化 agent 与 UI 的写入竞争**——两个来源的 mutation 走同一批 use-case 函数,一个 mutation 一条代码路径。
- 运行 Agent SDK:`query()` 在 main 调用(v1;升级路径是迁入 Electron `utilityProcess` 做崩溃隔离——renderer 只见事件流,IPC 面不变)。SDK 的 in-process MCP server 直接执行 GTD 工具于同一 store 实例:没有第二个 server、没有第二个 DB 句柄。
- **写路径**:renderer 发起 → main 调 domain usecase → `store.apply` 单事务原子提交命令批(INV-17 修订载体)→ 广播 `gtd:changed`。consequences(项目余活动、子任务计数、继承 deadline 等)随响应返回,由 UI/CLI/agent 以提示形态呈现(INV-14/15)。向导状态机已随 D-21 删除。
- **提醒调度器**(`reminders.ts`):启动时与每次 `gtd:changed` 后重算最近一条未派发提醒的定时器,到点发 Electron `Notification` 并置 `dispatched=1`。
- **actor 标记**:每个 use-case 调用携带 `actor: 'user' | 'agent'`(agent 时附 `conversationId`)。`gtd:changed` 的 payload 带上 actor,renderer 据此对 agent 引起的变更做行高亮 + toast(§7)。

### 4.3 Agent 会话管理

每个会话一条长活的 streaming-input `query()`:`query({ prompt: asyncIterableOfSDKUserMessages, options })`,用户消息推入 iterable;`includePartialMessages: true`;每条 `SDKMessage` 序列化后 `webContents.send('agent:stream', conversationId, message)`。`CLAUDE_CONFIG_DIR` **不重定向**(M1 定案:重定向会切断订阅凭据,见 §6.1);会话以 `cwd = userData` 隔离在 `~/.claude/projects/` 下。细节见 §6。

### 4.4 IPC 通道全表

请求/响应经 `ipcMain.handle`,标注 push 者为 `webContents.send`:

| 通道 | 方向 | 用途 |
|---|---|---|
| `gtd:capture` | R→M | 追加一条或多条文本到 inbox |
| `gtd:inbox.list` | R→M | Inbox 条目 |
| `gtd:tasks.list` / `gtd:tasks.get` / `gtd:tasks.create` / `gtd:tasks.update` / `gtd:tasks.complete` / `gtd:tasks.delete` | R→M | Task CRUD(delete = 软删) |
| `gtd:projects.list` / `gtd:project.view` / `gtd:projects.create` / `gtd:projects.update` / `gtd:projects.complete` | R→M | 项目**平面列表**(D-21:activeCount/doneCount/progress 徽章与进度)、单项目视图(根任务 + 子任务树);改 deadline 前 UI 先以只读规则取继承行动计数并征询,单次 `update` 带或不带 `propagateDeadline`(§5.4) |
| `gtd:task.detail` / `gtd:task.addSubtask` / `gtd:task.comment.add` | R→M | 任务详情弹窗(子任务树 ≤5 层 + 评论 + reminders,D-21/22/INV-25/26);加子任务(继承父的容器/项目/context,支持完整属性集含 labels/reminders);加评论 |
| `gtd:tasks.setLabels` / `gtd:reminders.add` / `gtd:reminders.delete` | R→M | 详情右栏就地编辑既有任务的 labels(diff 式指派)与 reminders(D-22) |
| `gtd:tasks.reopen` | R→M | 撤销完成(done→active,仅当前任务不级联;误点完成圆圈的"再点一下复原",D-22) |
| `gtd:calendar.complete` | R→M | 完成硬边界日历项(Today 行式渲染的完成圈,D-22) |
| `gtd:calendar.list` / `gtd:calendar.create` / `gtd:calendar.complete` | R→M | Calendar 条目 |
| `gtd:today` | R→M | Today 视图复合查询(hard landscape + due,含本地 today 日期与 overdue 预判)——M4 实装,避免 renderer 先取日期再二次查询 |
| `gtd:waiting.list` / `gtd:waiting.create` / `gtd:waiting.resolve` | R→M | Waiting-for |
| `gtd:contexts.list` / `gtd:contexts.add` / `gtd:contexts.remove` | R→M | Contexts(remove 由 domain 强制最后一个 context 不可删、有活跃任务需确认的规则) |
| `gtd:labels.list` / `gtd:labels.crud` / `gtd:filters.list` / `gtd:filters.crud` | R→M | Labels 与保存的 filters |
| `gtd:lists.get` / `gtd:lists.move` | R→M | Someday/Reference/Trash 操作 |
| `gtd:search` | R→M | 跨实体搜索(⌘K 数据源) |
| ~~gtd:flow.*~~ / ~~gtd:orphans.count~~ | — | 已随 D-21 删除(向导 flows 与孤儿机制退役) |
| `gtd:reminders.list` / `gtd:reminders.set` / `gtd:reminders.delete` | R→M | 提醒 CRUD(挂在 task 或 calendar item 上;M5R 起落库,响铃调度 M6) |
| `gtd:tasks.move` | R→M | 容器移动(D-20):Inbox / 项目(树)/ Someday / Reference;挪入有 deadline 项目时对无 deadline 任务静默复制(INV-10 move 版) |
| `gtd:bucket.list` / `gtd:completed.list` | R→M | Someday/Reference 任务列表;Completed(done 任务,最近优先,后续按月归档策略见 ROADMAP) |
| ~~gtd:inbox.clarify*~~ | — | 已随 D-20 容器模型退役(M5R2);理清 = `tasks.update` + `tasks.move` |
| `gtd:changed` | **M→R push** | `{ entities: ['tasks','projects',…], actor: 'user'\|'agent', conversationId? }` — 任何 mutation(UI 或 agent)之后推送;renderer 失效 TanStack Query 缓存,agent 来源触发高亮 + toast |
| `agent:conversation.list` / `agent:conversation.create` / `agent:conversation.resume` / `agent:conversation.fork` / `agent:conversation.delete` | R→M | 会话生命周期(delete 同时删 DB 行与 jsonl transcript) |
| `agent:send` | R→M | 推送用户消息(文本 + 图片 block + 附件路径)进 streaming iterable |
| `agent:interrupt` | R→M | 中断当前 turn(AbortController) |
| `agent:attachments.stage` | R→M | `{ sourcePath } → { stagedPath }`:把拖入文件复制进 `userData/attachments/<uuid>/`(§7) |
| `agent:setPermissionMode` / `agent:setModel` / `agent:setEffort` / `agent:setThinking` | R→M | 会话选项变更(model/effort 走 end-and-resume,§7) |
| `agent:stream` | **M→R push** | 序列化 `SDKMessage`(含 `stream_event` partial) |
| `agent:permission.request` | **M→R push** | `canUseTool` 转发:`{ requestId, toolName, input }` |
| `agent:permission.respond` | R→M | `{ requestId, behavior: 'allow'\|'deny', updatedInput?, alwaysAllow? }` — resolve 被阻塞的 `canUseTool` promise |
| `settings:get` / `settings:set` | R→M | 应用设置 |
| `settings:apiKey.set` / `settings:apiKey.status` | R→M | safeStorage 加密的 key;status 只返回是否存在,永不返回 key 本体 |

---

## 5. 数据模型

SQLite(WAL 模式),全表 UUIDv4 主键。时间戳一律 ISO-8601 TEXT;本地日期为 `YYYY-MM-DD` TEXT(沿用 CLI 语义,见 [./INVARIANTS.md](./INVARIANTS.md))。

### 5.1 完整 schema

```sql
CREATE TABLE contexts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,       -- '@' 前缀,由 domain 强制
  sort_order INTEGER NOT NULL, created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0                   -- "删除 context" = archive(§5.3);
);                                                      --   行不物理删除,历史 FK 引用保持有效

CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY, text TEXT NOT NULL,
  created_at TEXT NOT NULL, position INTEGER NOT NULL   -- FIFO 用 position 保序
);

CREATE TABLE projects (                                 -- 平面列表(D-21,迁移 0004 去 parent_id)
  id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,                                -- 名称即 outcome(GTD 框架)
  deadline TEXT,                                        -- YYYY-MM-DD;copy-on-create 流向行动(INV-10/12)
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','complete')),
  created_at TEXT NOT NULL, completed_at TEXT
);

CREATE TABLE tasks (                                    -- 扁平表,取代 CLI 的 next_actions[ctx] 桶
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  context_id TEXT NOT NULL REFERENCES contexts(id),     -- 恰好一个,必填(GTD)
  estimated_minutes INTEGER NOT NULL DEFAULT 15,
  energy TEXT NOT NULL DEFAULT 'medium' CHECK (energy IN ('low','medium','high')),
  priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
                                                        -- 1=最低 5=最高(GTD 语义)。任何界面
                                                        -- 都不重编号:选择器显示文字
                                                        -- 最高/高/中/低/最低(见 INVARIANTS.md)
  project_id TEXT REFERENCES projects(id),
  deadline TEXT,                                        -- YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'active'                 -- review "不相关" 软删除:
    CHECK (status IN ('active','done','deleted')),      --   与 CLI 的有意差异(见 INVARIANTS.md)
  created_at TEXT NOT NULL, completed_at TEXT, deleted_at TEXT,
  description TEXT NOT NULL DEFAULT '',                 -- 桌面扩展(迁移 0002,INVARIANTS §2.3)
  scheduled_date TEXT,                                  -- 计划哪天做(与 deadline 并存,D-19)
  bucket TEXT NOT NULL DEFAULT 'inbox'                  -- 容器(迁移 0003,D-20):
    CHECK (bucket IN ('inbox','project','someday','reference')),  -- 'project' ⟺ project_id 非空
  parent_task_id TEXT REFERENCES tasks(id),             -- 子任务(迁移 0004,D-21/INV-25):
                                                        --   ≤5 层;子树 bucket/project_id 与根一致
  sort_order INTEGER NOT NULL DEFAULT 0,                 -- 手动排序(迁移 0005,D-24/INV-27):
                                                        --   同级组(bucket+project_id+parent_task_id)
                                                        --   内相对序;拖拽重排/嵌套重编号 0..N-1
  start_time TEXT,                                      -- 日历统一(迁移 0006,D-23/M6a):
                                                        --   HH:MM,NULL=全天/无时间;
                                                        --   带时间任务即日历 block(取代 calendar_items)
  duration_minutes INTEGER                              --   block 时长(分钟);NULL 回退 estimated_minutes
);
CREATE INDEX idx_tasks_context ON tasks(context_id, status);
CREATE INDEX idx_tasks_project ON tasks(project_id, status);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
-- 注:CLI 的 project.action_ids 概念彻底不存在。一切按 project_id 外键查询。

CREATE TABLE task_comments (                            -- 任务评论(迁移 0004,D-21):仅追加展示
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at);

-- calendar_items 表已随 D-23/M6a 日历统一退役(迁移 0006):数据迁为带时间任务
-- (id 复用、提醒随迁),source_task_json 归档快照随实体丢弃(INV-19 退役)。

CREATE TABLE waiting_for (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL, delegated_to TEXT NOT NULL DEFAULT 'someone',
  project_id TEXT REFERENCES projects(id),
  delegated_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0, resolved_at TEXT,
  source_task_json TEXT
);

CREATE TABLE list_items (                               -- someday / reference / trash 三列表
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('someday','reference','trash')),
  text TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE labels ( id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT );
CREATE TABLE task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id), label_id TEXT NOT NULL REFERENCES labels(id),
  PRIMARY KEY (task_id, label_id)
);                                                      -- 自由 label 叠加在必填 context 之上

CREATE TABLE filters (                                  -- 保存的查询;预置 engage 风格 preset
  id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL,
  query_json TEXT NOT NULL                              -- {context?, labels?, energyMax?, maxMinutes?,
);                                                      --  priorityMin?, dueWithinDays?, noProject?...}

CREATE TABLE reminders (                                -- 提醒:挂在一个任务上(迁移 0006 重建,
  id TEXT PRIMARY KEY,                                  --   D-23/M6a:calendar_item_id 分支退役)
  task_id TEXT NOT NULL REFERENCES tasks(id),
  remind_at TEXT NOT NULL,                              -- ISO-8601 本地时间
  dispatched INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_reminders_due ON reminders(dispatched, remind_at);

CREATE TABLE conversations (                            -- SDK 管理的 transcript 之上的索引
  id TEXT PRIMARY KEY,
  sdk_session_id TEXT NOT NULL,                         -- 来自 ResultMessage.session_id;fork 时更新
  title TEXT NOT NULL,                                  -- 首条用户消息截断;可改名
  model TEXT NOT NULL, created_at TEXT NOT NULL, last_message_at TEXT NOT NULL,
  total_cost_usd REAL NOT NULL DEFAULT 0,               -- 累加 ResultMessage.total_cost_usd
  total_input_tokens INTEGER NOT NULL DEFAULT 0, total_output_tokens INTEGER NOT NULL DEFAULT 0,
  forked_from TEXT, archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE agent_audit (                              -- 每次 agent 工具调用一行(§6.8)
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  tool_name TEXT NOT NULL,                              -- 如 'mcp__gtd__create_task'
  input_json TEXT NOT NULL,
  decision TEXT NOT NULL
    CHECK (decision IN ('allowed-auto','allowed-user','denied')),
  result_summary TEXT,                                  -- handler 返回的人类可读摘要;denied 为 NULL
  created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_audit_conv ON agent_audit(conversation_id, created_at);

CREATE TABLE settings ( key TEXT PRIMARY KEY, value_json TEXT NOT NULL );
```

### 5.2 conversations 与 settings 说明

- **transcript 本体不入库**:留在 SDK 的 jsonl 存储(自用构建下位于 `~/.claude/projects/<encoded-userData-path>/`,M1 定案见 §6.1),经 `getSessionMessages()` 读回。`conversations` 表是应用级索引 + 成本账本。删除会话 = 删 DB 行 + 删 jsonl。
- **settings 键**:`theme`、`defaultModel`、`effort`、`thinking`、`permissionMode`、`defaultContextId`、`maxBudgetUsdPerTurn`、`maxTurns`、`alwaysAllowedTools`(审批弹窗 "Always allow" 的持久化)、`globalUsage`(全时段成本账本)、`onboardingDone`。**API key 不在 settings**:safeStorage 加密文件 `userData/secrets.bin`,仅 main 解密。

### 5.3 Context 删除的存储机制

行为语义见 [./INVARIANTS.md](./INVARIANTS.md) INV-24:UI 的"删除 context"在存储层实现为 **archive**(`archived=1`),而非删行——`tasks.context_id` 是 NOT NULL 外键,done/deleted 任务的历史引用必须保持有效。archived context 从一切选择器与列表中隐藏;其 active 任务在确认后软删除进 Trash(保留原 `context_id`);恢复这类任务时,若其 context 已 archived,要求重新指定 context。重名判定包含 archived 行(名称不复用)。

### 5.4 项目 deadline 编辑的传播(D-21 修订:仅项目→行动)

deadline 继承语义是 **copy-on-create/move**(INV-10/INV-12);CLI 没有任何编辑流程,桌面版新增编辑必须显式处理。**单次调用模型(M2 定案,D-21 收窄到行动)**:UI/agent 先以只读规则计算"deadline 与项目旧值相同的行动"数量并**一次性询问**"同步更新 N 个行动的 deadline?",然后**一次**调用 `updateProject`——确认传播则带 `propagateDeadline: true`(同一调用内按旧值圈定并连带更新那批行动),拒绝则不带。绝不静默级联。(子项目已随 D-21 废除。)

---

## 6. Agent 集成

### 6.1 Auth(已裁决:自用构建,2026-08-08)

**决策:本应用为个人自用构建,主认证路径 = 复用本机 Claude Code 的订阅登录**。合规依据:Anthropic 政策仅禁止**第三方分发**的应用提供 claude.ai 登录;个人构建自用不在此列。若将来要对外分发,必须切换到 BYO `ANTHROPIC_API_KEY`——切换点集中在 `sessionManager.ts` 的 `options.env` 构造,不影响其他设计。

- **主路径(默认,M1 已实证 2026-08-08)**:不注入 `ANTHROPIC_API_KEY`,SDK 子进程读取本机 Claude Code 已登录凭据。**实证结论:凭据与 config 目录绑定**——把 `CLAUDE_CONFIG_DIR` 重定向到空的 `userData/claude` 会导致子进程 `Not logged in`;**因此本应用不重定向 `CLAUDE_CONFIG_DIR`**(继承默认 `~/.claude`),订阅登录零配置直接可用。会话隔离由 `cwd = userData` 保证:transcripts 落在 `~/.claude/projects/<encoded-userData-path>/`,与用户 CLI 项目互不混淆;settings 隔离由 `settingSources`(默认不读文件 settings)保证。未登录/凭据失效时,onboarding 引导用户在终端完成 `claude` 登录后重试。
- **备用路径(保留)**:Settings 中可录入 `ANTHROPIC_API_KEY`(safeStorage 加密存 `userData/secrets.bin`,`options.env` 注入),优先级高于主路径。M1 若发现主路径与 CONFIG_DIR 重定向冲突,兜底顺序:(a) 保持凭据可见的 CONFIG_DIR 方案(记录进本节);(b) API key 路径。
- **用量口径**:订阅计费下 `ResultMessage.total_cost_usd` 可能为 0 或缺省,账本(§7)以 **token 计数为主**、成本金额为辅;SDK 无法查询订阅剩余额度。
- 云厂商桥(Bedrock/Vertex/Foundry)保留为将来可选,不在当前范围。

### 6.2 会话管理

- **`CLAUDE_CONFIG_DIR`:不设置**(M1 定案,§6.1)——重定向会切断订阅凭据。transcripts 位于 `~/.claude/projects/<encoded-userData-path>/`(cwd 隔离);代码保留 `CLAUDOIST_CONFIG_DIR_MODE=app` 旋钮供将来 BYO-key 分发形态启用重定向。
- **一会话一长活 query**:streaming-input 模式,`prompt` 为 `AsyncIterable<SDKUserMessage>`;`includePartialMessages: true`。
- **resume/fork**:打开历史会话 → `getSessionMessages(sdk_session_id)` 渲染史前消息,再以 `resume: sdk_session_id` 起新 query;fork → `resume + forkSession: true`,记录 `forked_from`。首启用 `listSessions()` 对账修复索引。
- **每次 `query()` 的护栏**:settings 的 `maxTurns` 与 `maxBudgetUsd`;`AbortController` 接 `agent:interrupt` 与应用退出;`settingSources` 排除 `'user'`(`~/.claude/settings.json` 不得覆盖应用行为);PATH 修复(fix-path 模式,供 agent 自身 Bash 工具使用);env 中防御性剔除宿主泄漏的 `ELECTRON_RUN_AS_NODE`(§9.3,M1 实证)。

### 6.3 MCP 工具面

全部用 SDK 的 `tool(name, description, zodSchema, handler)` 定义,`createSdkMcpServer({ name: 'gtd', tools })` 打包,经 `options.mcpServers.gtd` 传入。完整工具名 `mcp__gtd__<name>`。handler 在 main 进程直连同一 `GtdStore`;每次写触发 `gtd:changed`(actor='agent')。每个 handler 校验输入,返回 `structuredContent` + 人类可读 `content` block。工具总数按设计控制在 ~30 以内(工具 schema 逐 turn 消耗上下文;SDK 默认 tool-search 延迟加载兜底)。

**读工具(始终自动放行):**

| 工具 | 参数 | 返回 |
|---|---|---|
| `list_inbox` | — | inbox 条目(id、text、created) |
| `list_tasks` | `{ status?, contextName?, projectId?, labels?, energyMax?, maxMinutes?, dueBefore?, query?, limit? }` | 匹配任务 + 项目面包屑 |
| `get_task` | `{ id }` | 完整任务 |
| `list_projects` | `{ includeComplete?: boolean }` | 平面项目列表(D-21):deadline + activeCount/doneCount/progress |
| `get_project` | `{ id }` | 项目 + 活跃任务(根任务与子任务树)/calendar/waiting + `hasActiveNextAction`(calendar 与 waiting 计入,见 INVARIANTS.md) |
| `get_task_detail` | `{ id }` | 任务 + 子任务树(≤5 层)+ 评论(D-21) |
| `list_calendar` | `{ fromDate?, toDate?, includeDone? }` | 按日期/时间排序的 calendar 条目 |
| `list_waiting_for` | `{ includeResolved? }` | 委派项(受托人 + 起始日期) |
| `list_contexts` | — | contexts + 活跃任务计数 |
| `list_labels` / `list_filters` | — | labels / 保存的 filters |
| `search` | `{ query, kinds? }` | 跨实体命中(tasks、projects、inbox、someday、reference、done、calendar、waiting) |
| `get_engage_recommendations` | `{ contextName, availableMinutes, energy }` | top-7 候选(min≤time ∧ energy≤user,priority 降序)+ 今日 calendar —— **只读;完成是独立写操作** |
| `get_status_summary` | — | 总览:各区计数 + 摘要(孤儿工具已随 D-21 删除) |

**写工具(权限门控;全部返回 `consequences` 后果字段):**

后果返回约定(评审嫁接项):写工具的 `structuredContent` 一律含 `consequences` 对象,字段命名固定(`parentCompletionCandidate`、`inheritedDeadline`、`projectHasRemainingActivity`、`completedSubtaskCount`、`deletedSubtaskCount`、`followUpCreated`…)。agent 拿到后果后**必须像 CLI 一样征询用户再做下一步写调用**——级联永远是"提问 → 确认 → 单独一次工具调用",绝不自动连锁完成(system prompt 固化,§6.6)。

| 工具 | 参数 | 效果 | 关键 consequences 字段 |
|---|---|---|---|
| `capture` | `{ texts: string[] }` | 追加到 inbox(零摩擦;"提醒我…"的默认动作) | `createdIds` |
| `move_task` | `{ id, to: {bucket} \| {bucket:'project', projectId} }` | 容器移动(D-20/D-21):根任务子树随动;子任务先脱离父;挪入有 deadline 项目静默继承(INV-10 move 版) | `inheritedDeadline`、`detachedFromParent` |
| `add_subtask` | `{ parentTaskId, title, … }` | 建子任务(≤5 层;继承父的容器/项目/context,INV-25) | `inheritedDeadline` |
| `add_comment` | `{ taskId, body }` | 任务评论(D-21) | — |
| `create_task` | 任务字段(context 必填) | 插入活跃任务;所属项目有 deadline 时**无条件**覆盖为项目 deadline 副本(INV-10 静默继承,显式传入值亦被覆盖;M2 按 INVARIANTS 定案) | `inheritedDeadline` |
| `update_task` | `{ id, patch }` | 编辑字段,含 context/label 迁移 | — |
| `complete_task` | `{ id }` | 标记完成;**向下级联完成整棵 active 子树**(D-22/INV-26.1;仅向下,勾子任务不勾父) | `projectHasRemainingActivity`、`parentCompletionCandidate`、`completedSubtaskCount` |
| `reopen_task` | `{ id }` | 撤销完成(done→active,仅当前任务;父缺失/已删则脱离父) | — |
| `delete_task` ⚠ | `{ id }` | 软删(status='deleted');active 子树级联软删,done 后代保留(INV-26.2) | `deletedSubtaskCount` |
| `create_project` | `{ outcome, deadline? }` | 插入平面项目(D-21) | — |
| `update_project` | `{ id, patch, propagateDeadline? }` | 编辑;deadline 改动须先经征询,单次调用带 `propagateDeadline: true` 才连带更新"旧值相同"的行动(§5.4 单次调用模型) | `propagatedTaskCount` |
| `complete_project` | `{ id }` | 标记完成(不改变其任务状态) | `activeTaskCount`(>0 时 agent 应先向用户确认) |
| `create_waiting_for` | `{ description, delegatedTo?, projectId? }` | 新委派 | — |
| `resolve_waiting_for` | `{ id }` | 标记等待项已解决(`resolvedAt=now`);**不触发任何追问**(INV-14 边界),domain usecase 不附带后果 | (handler 如需 `projectHasRemainingActivity` 以只读规则补算) |
| `create_follow_up` | `{ waitingForId }` | 对**未解决**的等待项按 INV-23 模板创建催办任务(`Follow up with X re: Y`、@phone 或 sortOrder 最小 context、5 分钟、low、priority 4、同项目);**不改变** `resolved` 状态(催办对象正是还没回音的委派,见 [./INVARIANTS.md](./INVARIANTS.md) INV-23) | `followUpCreated` |
| `create_calendar_item` | `{ title, date, time?, projectId? }` | hard-landscape 条目 | — |
| `complete_calendar_item` | `{ id }` | 完成 | 同 `complete_task` 的追问 payload |
| ~~move_to_list~~ / ~~activate_someday~~ | — | 已并入 `move_task`(D-20/D-21 容器模型:归档/激活都是 bucket 移动) | — |
| `add_context` | `{ name }` | 自动 @ 前缀、去重 | `normalizedName` |
| `remove_context` ⚠ | `{ name }` | 删除 context(实现为 archive,§5.3);domain 强制:最后一个 context 不可删;含活跃任务时需先确认,确认后这些任务**软删除进 Trash**(INV-24) | `trashedTaskCount` |
| `manage_labels` | `{ create?, assign?: {taskId, labelNames}, remove? }` | label CRUD/指派 | — |

⚠ = **destructive class**(§6.4)。

### 6.4 权限矩阵

五种 UI 模式 × 工具类别。**全部映射在单一模块 `apps/desktop/src/main/agent/policy.ts` 中定义,每种模式有独立集成测试**。工具类别:读工具、普通写工具、destructive 写工具(当前成员:`delete_task`、`remove_context`;判据:不可逆或高影响面)、SDK 内置工具(`Read` 限附件目录,经 `additionalDirectories`;其余内置默认不给)。

| UI 模式 | SDK 选项 | 读工具 | 普通写工具 | destructive 写工具 | 内置 Read(附件目录) | 其他内置工具 |
|---|---|---|---|---|---|---|
| **Manual** | `permissionMode:'default'`;`allowedTools` = 读工具 + 附件 Read | 自动 | `canUseTool` 弹窗 | `canUseTool` 弹窗 | 自动 | 弹窗 |
| **Edit automatically** | `permissionMode:'acceptEdits'`;`allowedTools` += 普通写工具 | 自动 | 自动 | **弹窗(强制)** | 自动 | 文件编辑类自动(acceptEdits 语义),其余弹窗 |
| **Plan** | `permissionMode:'plan'` | 自动 | SDK 拒绝 | SDK 拒绝 | 自动 | 拒绝写类 |
| **Auto** | `permissionMode:'default'`;`allowedTools` += 普通写工具 | 自动 | 自动 | **弹窗(强制)** | 自动 | 弹窗 |
| **Bypass** | `permissionMode:'bypassPermissions'` + `allowDangerouslySkipPermissions: true` | 自动 | 自动 | 自动 | 自动 | 自动 |

规则:

- **destructive class 在 Manual / Edit automatically / Auto 三种模式下必须弹窗**,无论 allowlist 如何配置(policy.ts 保证 destructive 工具名永不进入 `allowedTools`)。
- **"Always allow \<tool\>"**:审批弹窗对普通写工具提供 "Always allow" 选项,经 `agent:permission.respond` 的 `alwaysAllow` 持久化进 `settings.alwaysAllowedTools`,即时并入会话 `allowedTools`(经 `updatedPermissions`)并作用于后续会话。destructive 工具的弹窗默认不提供该选项(仅可在 Settings 高级区显式加入并附警告)。
- **Bypass 仅限 dev**:藏在带警示的二次确认之后,打包构建默认禁用。
- 模式中途切换:`q.setPermissionMode(mode)`;涉及 `allowedTools` 变更的切换(如 → Auto)需 end-and-resume 重启会话(§7)。

### 6.5 审批弹窗(canUseTool 桥)

main 的 `canUseTool: async (toolName, input) => …` 阻塞在 promise 上:推 `agent:permission.request { requestId, toolName, input }` 给 renderer;`agent:permission.respond` 回传 `{ behavior, updatedInput?, alwaysAllow? }` resolve 该 promise。每次决定(含自动放行路径)写入 `agent_audit`(§6.8)。

**弹窗 UI 规格**(2026-08-08 应用户要求补充;M9 步前预告时展示视觉稿供确认):

- **形态**:agent 面板内的模态卡片(不遮全屏,遮罩仅覆盖右栏;中栏保持可见,便于对照数据)。
- **标题行**:工具的人性化动词短语(renderer 维护 `toolName → 显示名` 映射,如 `mcp__gtd__delete_task` → "删除任务"),右侧当前权限模式徽章。
- **正文**:人类可读摘要,由 renderer 侧的每工具 formatter 从 `toolName + input` 生成(必要时经读 IPC 取实体名),如:删除任务『买牛奶』(@errands · P最高 · 项目:周末采购);其下"显示原始参数"可展开区(等宽字体渲染 input JSON)。
- **普通写工具变体**:按钮 **Allow**(主,回车)· **Always allow**(次,附注"以后 `<显示名>` 不再询问",持久化进 `settings.alwaysAllowedTools`)· **Deny**(Esc)。
- **destructive 变体**(⚠ 工具):红色强调边框 + 警示图标;按钮 **确认删除**(红)· **取消**;**无 Always allow**;回车不触发确认(必须显式点击),Esc = 取消。
- **等待态**:弹窗存续期间,聊天流中该工具的 ToolUseChip 显示 "等待你批准…";不设超时,阻塞至用户决定或用户中断整个 turn(`agent:interrupt` 视为 Deny)。
- **队列**:同一 turn 的多个待批请求按到达顺序排队,一次只呈现一个。

### 6.6 System prompt 策略

`options.systemPrompt` 使用自定义 prompt,两部分:

1. **固化的易错不变量**(常量文本,与 [./INVARIANTS.md](./INVARIANTS.md) 同源维护):
   - priority 语义 1=最低、5=最高,永不重编号;
   - engage 能量过滤方向:任务 energy ≤ 用户 energy(精力好的人可做轻松任务,反之不行);
   - calendar 条目与 waiting-for 都算项目的 active action(完成后果提示必须计入);
   - someday 激活必须回 inbox 重新 clarify,绝不直达 tasks;
   - 一切级联(项目完成、deadline 传播、完成后的下一步)必须先向用户提问、拿到确认后再单独调用写工具——收到 `consequences` 字段即视为"该提问了";子任务永不随父完成(INV-26)。
2. **每次会话注入的轻量状态快照**(会话起始时由 main 组装):今天日期、contexts 列表及活跃计数、inbox 条数、各项目未完成计数。让 agent 开口即有正确的日期与全局形势,不必先打一轮读工具。

### 6.7 CLI 操作通道(2026-08-09 用户定案)

`packages/cli`(`@gtd/cli`,依赖方向同 desktop-main:只向内引 domain + storage)提供命令行任务操作,两重用途:**① Claude Code 经 Bash 工具直接操作任务**(M8/M9 MCP 工具之前即可用,之后与 MCP 并存——MCP 走 in-process 实时,CLI 适合脚本/批处理);**② 用户自己的终端操作**。

- **调用**:`pnpm --silent cli <命令> [--json]`(`--silent` 保证 JSON 输出干净)。命令:`capture`、`add`(--desc/--date today|tomorrow|日期/--deadline/--priority/--project/--context/--labels/--remind;**--parent=<任务> 建子任务**,继承父的容器/项目/context,≤5 层,D-21)、`list`、`today`、`show`(含子任务树与评论)、`comment <任务> <文本>`、`move`(根任务子树随动;子任务先脱离父)、`complete`(返回子任务/项目余活动提示)、`delete`(子树级联软删,输出数量)、`update`、`projects`(平面 + 进度)、`project-add` / `project-update`(--name/--deadline,--propagate 触发 §5.4 传播)、`contexts` / `labels` 管理。任务/项目引用 = id / id 前缀 / 名称全等;`--json` 输出含 id,供 agent 消费。
- **DB 定位**:`CLAUDOIST_DB` env > `--db=` > `--prod`/`--dev` > 自动(dev 库存在且 prod 不存在 → dev,否则 prod);输出附带实际路径,杜绝写错库。
- **并发**:同库多进程靠 SQLite WAL;连接统一 `busy_timeout` 2s;写路径仍是 domain usecase(与 UI/未来 MCP 同一套)。
- **应用实时感知外部写入**:main 进程 `fs.watch` DB 与 `-wal` 文件,300ms 防抖后广播 `gtd:changed`(actor='agent')——CLI/agent 改数据,窗口内视图即时刷新。

### 6.8 agent_audit 审计

SDK 无内置审计。`apps/desktop/src/main/agent/audit.ts` 在两处落账:

- **权限决定时**:`canUseTool` resolve 后写 `decision`(`allowed-user` / `denied`);走 `allowedTools` 自动放行的调用在 PostToolUse 时补 `allowed-auto`。
- **执行后**:handler 完成时把人类可读摘要写入 `result_summary`。

每行含 `conversation_id`、`tool_name`、`input_json`、时间戳。用途:问题溯源、行为回放,以及**将来 undo 的基础**(知道 agent 改了什么才谈得上撤销)。

---

### 6.9 Agent Skills:GTD 流程的载体(D-28,2026-08-11 用户定案)

**择事(Engage/Focus)与周回顾(Weekly Review)不做成桌面端的独立功能。** 它们本质上是
一串原子操作的编排(读候选 → 逐条判断 → 完成/移动/软删),把这种编排固化成向导 UI,
等于把"什么时候该怎么想"写死在按钮里;而这恰恰是 agent 该做的事。

- **算法留在 domain,不动**:`rules/engageRanking.ts`(INV-20)、INVARIANTS §4.11 周回顾
  六步、§4.12 择事十步,仍是唯一权威。变的只是**载体**,不是规则。
- **执行载体 = agent skill**:每个流程一个 skill(`engage` / `weekly-review` / `clarify` /
  `decompose`),skill 内容 = 该流程的步骤纪律 + 该调哪些工具 + 何时必须停下来征询用户
  (INV-15)。agent 靠 §6.3 的 MCP 只读/写工具执行;`@gtd/cli` 的同名命令(如
  `pnpm cli engage`)是同一套 domain 规则的另一个出口,skill 可二选一。
- **入口 = composer 下方的一排建议按钮**:右栏聊天输入框下方给"开始周回顾""帮我挑一件事
  做""理清收件箱"等快捷按钮,点击即把对应提示发给 agent(与 §7 的上下文 chip 同区)。
  按钮只是**预置提示**,不是状态机——用户随时可以改口、跳步、中途问别的。
- **因此中栏没有 Focus 面板、没有回顾向导、侧栏没有 Weekly Review 项**;中栏只承载"看和
  改数据"的视图(Inbox / Today / Calendar / 项目 / Search / Filters & Labels)。

> 载体归属:skill 定义与建议按钮属 **M8–M10**(agent 里程碑);M7 只做 Search 与
> Filters & Labels。此前 M7a 已实现的桌面 Focus 面板据本决策**撤除**(domain 规则与 CLI
> `engage` 保留)。

## 7. Agent 面板功能 → SDK API 映射

| 功能 | 实现 |
|---|---|
| **会话历史列表** | `conversations` 表为索引(标题、模型、成本、最近活动)。打开会话:`getSessionMessages(sdk_session_id)` 读 jsonl 渲染史前消息 → `resume: sdk_session_id` 起 live 会话。首启 `listSessions()` 对账修复索引 |
| **新建会话(右上角)** | 插 `conversations` 行,起不带 `resume` 的 `query()`;从首条 `ResultMessage` 捕获 `session_id` 落库 |
| **Fork** | 任意会话上的 fork 按钮:`resume + forkSession: true`,记录 `forked_from`,历史分叉互不影响 |
| **粘贴图片** | Composer `onPaste` 读 `clipboardData` 图片 blob → base64;经 streaming iterable 发出 `SDKUserMessage`,`message.content` 数组含 Messages-API 形状的 `{ type:'image', source:{ type:'base64', media_type, data } }` 与文本并列。**M1 已实证(2026-08-08):pinned SDK 0.3.226 原生支持,模型正确识别测试图,无需兜底** |
| **图片兜底**(评审嫁接项,M1 后仅作保险预案) | 若将来 SDK 升级后图片 content block 回归失败:图片落盘到附件暂存目录(下一行),prompt 中给绝对路径,走 SDK 内置 `Read` 工具读图。功能等价,只多一次工具调用 |
| **拖拽文件附件** | renderer drop handler 经 `webUtils.getPathForFile` 取路径 → `agent:attachments.stage` 把文件**复制**进 `userData/attachments/<uuid>/`;该目录是唯一稳定的 `additionalDirectories` 根(避免逐目录授权)。Composer 显示附件 chip,展开为暂存后的绝对路径,agent 用内置 `Read` 打开。不发明假的 @-mention 语法 |
| **切换模型** | 会话起始经 `options.model`(settings 默认,如 pinned `claude-fable-5` / `claude-sonnet-5` / `claude-haiku-4-5-20251001`)。**中途切换 = end-and-resume**:结束当前 `query()`,立即以 `resume: sessionId` + 新 `model` 重起(非原子但历史保留);面板短暂显示 "switching model…";流式进行中禁用切换控件 |
| **Effort 档位** | 下拉(low/medium/high/xhigh/max)→ `effort` 选项,会话起始应用;中途改动同 end-and-resume。持久化 `settings.effort`。高档位附成本警示文案 |
| **Thinking 三态** | Off → `thinkingConfig: { type:'disabled' }`(完全无 thinking token);On (hidden) → `{ type:'enabled', display:'off' }` + UI 警示"token 仍计费";On (shown) → `{ type:'enabled', display:'on' }`,thinking block 渲染为可折叠灰色区块 |
| **用量账本** | 每条 `ResultMessage` 携带 `total_cost_usd` 与 `usage`(输入/输出/cache token);main 累加进 `conversations` 行与 `settings.globalUsage`。面板页脚:本会话 token(主口径)与成本金额(辅,订阅计费下可能为 0/缺省,§6.1)。SDK 查不到订阅剩余额度 |
| **权限模式选择器** | 五种模式(Manual / Edit automatically / Plan / Auto / Bypass)→ §6.4 矩阵;实现集中在 `policy.ts`。中途切换 `q.setPermissionMode`;涉及 allowlist 的切换走 end-and-resume |
| **审批弹窗** | §6.5 的 `canUseTool` IPC 桥;Allow / Always allow / Deny;destructive 默认无 Always allow |
| **流式渲染** | `includePartialMessages: true`;main 原样转发 `stream_event`。renderer 状态机消费:`content_block_start`(`tool_use` → ToolUseChip 带 spinner + 工具名;`text` → 开文本气泡)、`input_json_delta`(累积并实时渲染工具入参)、`text_delta` / `thinking_delta`(追加)、`content_block_stop`(定稿 chip)、user 角色的 tool_result(结果/错误挂到 chip,可折叠) |
| **actor 标记 + toast**(评审嫁接项) | agent 的 GTD 工具写入触发 `gtd:changed { actor:'agent', conversationId }`:中栏受影响行高亮,并弹 toast(如 "Claude: 更新了 3 个任务")——agent 干活时中栏可见地实时变化,是产品的核心演示 |
| **上下文 chip** | composer 上方一排 chip,可把当前视图(如选中的项目)作为结构化上下文附加到下一条消息 |

---

## 8. 视图规格

业务规则细节(决策树、路由、级联、排序公式)一律以 [./INVARIANTS.md](./INVARIANTS.md) 为准,本节只描述 UI 结构与交互。

- **Add task(全局 "+",⌘N;2026-08-08 M5 反馈定案为 Todoist 式单卡)**:一张卡片 —— Task name + Description 两行输入,下方属性 chip 行:**Date**(Today / Tomorrow / 自选 → `scheduledDate`)、**Deadline**、**Priority**(文字 最高/高/中/低/最低,存储 1–5,1=最低,不重编号)、**Labels**(多选)、**Reminders**(datetime,落 `reminders` 表;响铃调度 M6)、context 选择(内联新建),底部位置选择器(**Inbox ▾** / 任意项目)+ Cancel / Add task。**语义**:位置=Inbox 且未 specify 任何属性 → 纯捕捉(`createInboxItem`,零摩擦);specify 了任意属性或选了项目 → 直接建 Task(相当于已理清)。attachment 并入 M10;location 不做(决策日志)。
- **Search(⌘K,M7a;INV-32)**:自绘命令面板(未引 `cmdk` —— 只需输入框 + 列表 + ↑↓/↵/Esc,一个依赖换不来什么),数据源 `gtd:search` → domain `searchAll`。侧栏 Search 项与 ⌘K 等价。
  - **覆盖**:任务(标题 + 描述,含子任务、someday/reference、Upstream 镜像、已完成归档)与项目。容器模型下这些都是带 `bucket` 的 Task,故同属一组,由 VM 按容器给出二级说明(`Inbox · @home`、`发布 1.0 · @computer`、`已完成 2026-08-11`)。
  - **不列**:软删除项(无恢复入口,点了无处可去,INV-32.3)、等待项(桌面无该视图;CLI `search` 会列)。
  - **导航**:命中即跳到该条目的**容器视图**(而非它恰好出现的 Today/日历),任务再顺手打开详情弹窗;跨视图跳转的详情态由 App 层持有,各视图自己的详情态管不了别人。
  - 原规划里的命令动作("Focus mode"、"Start Weekly Review")**随 D-28 取消** —— 这些是 agent skill 的入口,不是搜索结果。
- **TaskRow(全视图统一行组件)**:完成勾选圈(**complete↔reopen 可切换**:active 圈点击完成、done 圈点击撤销,D-22 误点即可复原)、标题、属性 chip(计划日 / 截止 / 优先级文字 / **label 名**(彩点+名称,不是数量)/ @context);**点击行主体(非勾选框)→ 任务详情弹窗**;右键菜单(完成 / 编辑 / 删除=软删);完成控件 **hover 提示**:带未完成子任务时提示"将连同 N 个子任务一起完成(误点可再点一下撤销)"(D-22 向下级联)。日历项(Today 硬边界)复用同一行式渲染(完成圈 + 标题 + 时间 chip),不再是独立卡片块。
- **任务详情弹窗(D-22 Todoist 式两栏,单击任务打开;与右键"编辑"的 TaskCard 不同)**:**左栏 = 内容** —— 完成圈 + 标题、描述、**子任务区**(直接子任务用 TaskRow 渲染,可右键完成/删除、单击下钻;"+ Add sub-task" 打开与添加任务相同的 TaskCard,默认继承父的位置/context,≤5 层)、**评论区**(时间序 + 输入框;附件 M10);**右栏 = 属性面板** —— Project/位置(可编辑,**Move to** Inbox/Someday/Reference/项目)、Date、Deadline、Priority、Labels、Reminders、@context,逐项点击就地编辑(经 `tasks.update`/`tasks.move`/label·reminder 通道)。下钻子任务时顶部显示返回按钮(标签 = 真实上一层标题,非父链)。
- **Inbox(容器模型,INVARIANTS D-20,2026-08-09 定案)**:`bucket='inbox'` 的**任务列表**(仅根任务成行,子任务在详情内)——task 生在 Inbox,不挪不消失。右键"编辑"展开 TaskCard;**Move to** 选择器(Inbox / 项目 / Someday / Reference)执行容器移动;底部内联 "+ Add task"。理清 = 编辑属性 + Move(或勾完成);想让 Claude 理清就直接在右栏对话——**无专用按钮**。
- **Today(D-21/D-23 日历统一:单一列表,全行式)**:**统一任务列表** = `scheduledDate ≤ 今天` ∪(`deadline ≤ 今天` 且未计划)的 active 任务(someday/reference 不入;过期高亮)。计划段排序:计划日升序 → **全天在前 → startTime 升序**(原 hard-landscape §2.5 排序语义并入,**无独立日程段** —— 带时间任务即日历 block,行上显示 🕐 时间·时长 chip)。TaskRow 渲染与 Inbox 完全一致;底部内联 **"+ Add task"**(默认 `scheduledDate=今天`);拖到底部虚线区 = 推迟到明天。**无 Focus 入口**——择事由 agent skill 承载(§6.9,D-28)。
- **Calendar(M6b,D-23/INV-28;取代原 "Upcoming" 规划)**:周网格 —— 7 列 + 左侧时刻槽 + 顶部**全天段**;上下滚动 24 小时,首屏定位 07:00,今天列显示当前时刻红线。日历 = 任务按 `scheduledDate + startTime` 的投影(**无独立实体、无独立写路径**):
  - **建块**:空白处单击某刻度 → 默认 30 分钟块;按住拖选 → 该区间;全天段单击 → 全天任务。均弹轻量 composer(标题 + 回车创建),走 `quickAddTask`。
  - **改块**:拖动块 = 改 `scheduledDate`(跨列)/`startTime`;拖底边 = 改 `durationMinutes`;拖到全天段 = 清时刻。均走 `updateTask`。
  - **其他**:单击块 = 打开任务详情弹窗;右键 = 完成/撤销完成、移到全天、删除(= 软删任务,INV-22);重叠块并排分栏;**完成的块仍在日历上**(灰显划线,D-23 用户定案)。
  - 吸附/区间/分段口径全部来自 domain `rules/calendarGrid.ts`(INV-28),CLI `calendar` 命令共用,两处不得各写一套。
  - deadline 的双轨可视化(due chip)与拖拽改 deadline 顺延至后续里程碑;当前 deadline 仍在行内 🎯 徽标显示。
- **Filters & Labels**:Labels 区 = 自由 labels + contexts(contexts 置顶、徽章样式、删除受 domain 规则约束)+ 虚拟 **@waiting_for** 视图(由 waiting_for 表支撑;详情面板保留 delegated_to、起始日期、Resolve、Create-follow-up——绝不摊平成普通 label)。Filters 区 = 保存的 `filters` 行,由 domain 的 `filterQuery` 解释器求值;预置:"Low energy · <15 min"、"Due this week"、"No project"、"High priority next"。Filter 编辑器 = query_json 字段表单。
- **My Projects(D-21 平面化,Todoist 对齐)**:侧栏分组头 "My Projects" 带 **+**(新建项目对话框:名称 + 可选 deadline)与**折叠箭头**(toggle 列表);点击分组头文字 → **总览视图**:每个项目一行,名称 + **进度条与百分比**(progress = done/(done+active),active+done=0 时显示 0%)。分组下每个项目一行:# 名称 + **未完成任务数徽章**;右键 → 编辑(改名 / deadline,改 deadline 按 §5.4 征询传播)/ 标记完成;点击 → **单项目视图**:头部(名称、deadline chip),任务列表(根任务成行,带子任务的行显示子任务计数;与 Inbox 同 TaskRow),底部内联 **"+ Add task"**(默认落本项目)。无孤儿徽章、无健康标记、无 Break-down 向导(D-21 退役)。
- **GTD 组(侧栏下方,D-20 精简;Upstream 不入栏,见下)**:仅三项——**Someday/Maybe** 与 **Reference**(各 = 对应 bucket 的任务列表,同 TaskRow 组件,**侧栏带未完成计数徽章**,可 Move 回任意容器;不参与 Today/engage)、**Completed**(done 任务按完成时间倒序,无徽章;随量增长的归档策略——按月分组 + 懒加载——排入后续里程碑)。**Trash 视图与 Weekly Review 侧栏项移除**:删除 = 右键软删(数据层可恢复)。
- **Reminders**:任务与 calendar 条目详情、快速添加对话框均可设提醒;main 调度器到点弹系统通知,点击通知聚焦对应条目。
- **Agent 面板(右栏)**:§7 全部功能。

---

## 9. dev/prod 分离与打包

### 9.1 userData 布局(打包版)

`app.getPath('userData')` = `~/Library/Application Support/Claudoist/`(由 `apps/desktop/package.json` 的 `productName: "Claudoist"` 派生——该字段必须存在,否则 Electron 落回包名 `@gtd/desktop` 产生 `@gtd` 目录,M0 已实证):

```
Claudoist/
├── data/gtd.sqlite3(+ -wal/-shm)   # 唯一数据库
├── attachments/…(见下)           # (SDK 会话 transcripts 不在此:自用构建不重定向
│                                    #  CLAUDE_CONFIG_DIR,transcripts 在 ~/.claude/projects/,§6.1)
├── attachments/<uuid>/…             # 拖拽附件暂存(additionalDirectories 唯一根)
├── secrets.bin                      # safeStorage 加密的 API key
└── logs/
```

不向 userData 根目录直接写文件(Chromium 拥有其中的 Cache、GPUCache 等子目录)。

### 9.2 dev 隔离

- `apps/desktop/src/main/index.ts` 在 `app.whenReady()` 之前:`if (!app.isPackaged) app.setPath('userData', app.getPath('userData') + '-dev')` → `Claudoist-dev/`。dev 与 prod 数据、会话、密钥完全隔离。
- 另支持 `--user-data-dir=` 一次性 profile 与 `GTD_USER_DATA` env 覆盖(测试用)。
- domain/storage 测试用内存 SQLite(`:memory:`),零磁盘状态。
- `pnpm seed`(`packages/storage-sqlite/scripts/seed.ts`,dev-only)向 dev userData 数据库写入演示数据,是视图开发与验收的数据来源。
- **env 处理**:SDK 不加载 dotenv;main 显式构造 `options.env`(fix-path 合并后的 PATH;防御性删除宿主泄漏的 `ELECTRON_RUN_AS_NODE`;备用 API key 路径启用时注入 safeStorage 解密的 `ANTHROPIC_API_KEY`;`CLAUDE_CONFIG_DIR` 不设置,§6.1)。运行时路径上没有 `.env` 文件;`.env.development` 可放 dev key 但被 gitignore。

### 9.3 打包(Agent SDK,M1 实证定稿 2026-08-08)

SDK 0.3.x 以**平台原生二进制**交付(`@anthropic-ai/claude-agent-sdk-darwin-arm64` 内约 267MB 的自包含 `claude` 可执行文件),**不需要任何 JS runtime**——调研阶段针对旧版 cli.js 的 `ELECTRON_RUN_AS_NODE` spawn 覆写方案已过时,实际只需两件事(均已在打包版 + stripped-PATH 下验证通过):

1. **asarUnpack**:`electron-builder.yml` 设 `asar: true` + `asarUnpack: ['**/node_modules/@anthropic-ai/**']`(asar 内的二进制无法被 spawn)。
2. **路径重写**:`cliPath.ts` 用 `require.resolve('@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude')` 解析二进制,把 `app.asar` 重写为 `app.asar.unpacked`,传给 `options.pathToClaudeCodeExecutable`。

两个 M1 实证的坑:
- **SDK tarball 的 `optionalDependencies` 只声明 linux 平台包**,darwin 二进制不会随 `pnpm install` 自动安装——`apps/desktop/package.json` 显式声明 `@anthropic-ai/claude-agent-sdk-darwin-arm64` 为 optionalDependency(SDK 升级时两处版本必须同步)。
- **宿主环境可能泄漏 `ELECTRON_RUN_AS_NODE=1`**(如 VSCode 派生 shell):构造 `options.env` 时防御性删除。

其他:dmg 体积因二进制约 192MB;`install-app-deps` 为 Electron ABI 重建 better-sqlite3(M3 起);macOS hardened runtime + notarization,凭据走 CI secrets 绝不入库。

### 9.4 仓库卫生(gitignore 策略)

- **提交**:全部源码、drizzle `migrations/*.sql`(是源码)、lockfile、CI 配置、docs/。
- **gitignore**:`dist/`、`out/`、`node_modules/`、`*.sqlite3*`、`.env*`、日志与崩溃转储。
- **绝不生成在仓库内**:数据库、会话 transcript、settings、密钥、构建产物——应用只写 userData。

---

## 10. 工程规范

| 项 | 约定 |
|---|---|
| TypeScript | `strict: true` 全仓,`tsconfig.base.json` 统一;不允许 `any` 逃逸(eslint 把关) |
| Lint | ESLint(分区 `no-restricted-imports` 强制 §3.2 依赖方向,违反即 CI 红)+ Prettier(格式零争论) |
| 测试 | Vitest。`@gtd/domain`:[./INVARIANTS.md](./INVARIANTS.md) **每条不变量一个命名 spec**,纯 Node 全绿是 M2 验收;`@gtd/storage-sqlite`:通过 domain 定义的 store-contract 套件;`policy.ts`:五种权限模式各一集成测试;M10 加入教练式评测(scripted coaching evals:录制 clarify/engage/review/decompose 的 agent 会话脚本,对照 playbook 断言,作为 system prompt 与工具序列的回归测试) |
| CI | GitHub Actions:lint + typecheck + domain/storage 测试 + build;打包冒烟测试作为 Electron/SDK 升级的门禁 |
| 提交规范 | Conventional Commits |
| 协作流程 | 按里程碑逐步交付:每步开始前先说明(a)要做什么(b)预期结果/验收标准;完成后用户试用反馈,通过才进下一步。每个里程碑的 Definition of Done 与状态见 [./ROADMAP.md](./ROADMAP.md) |
| 文档 | 三份文档(DESIGN / INVARIANTS / ROADMAP)持续维护、反映真实进度;行为变更必须同步 INVARIANTS.md |

---

## 11. 风险与缓解

| # | 风险 | 缓解 |
|---|---|---|
| 1 | **打包后子进程跑不起来**(asar 路径、spawn 失败) | **已消解(M1,2026-08-08)**:原生二进制 + asarUnpack + 路径重写在打包版 + stripped-PATH 下实测通过,无需系统 Node;残余风险 = SDK 升级(二进制更新可能破坏旧 transcript 兼容性、darwin optionalDependency 需同步 bump)→ 每次升级重跑 `--spike-test` 打包冒烟 |
| 2 | **API 成本失控**(开放式 prompt、Auto 模式、extended thinking) | 每次 `query()` 挂 `maxTurns` + `maxBudgetUsd`;实时成本页脚;thinking/高 effort 的警示文案;Bypass 在打包构建默认禁用 |
| 3 | **图片 content block 在 pinned SDK 上不可用** | **已消解(M1,2026-08-08)**:base64 image source 在 0.3.226 原生可用,模型正确识别测试图;兜底方案(附件目录 + `Read`)保留为 SDK 升级回归时的预案(§7) |
| 4 | **领域移植在微妙不变量上回归**(能量比较方向、calendar/waiting 计入 active action、仅向上且征询式的级联、静默 deadline 继承、someday→inbox) | 每条不变量在 UI 存在之前就是 `@gtd/domain` 的命名 Vitest spec(M2);system prompt 固化同一批易错项(§6.6);M10 coaching evals 覆盖 agent 侧行为 |
| 5 | **INVARIANTS.md 单点权威风险**:Python 源码删除后,规则若记录不全便无处可查 | INVARIANTS.md 必须完备自足(每条规则:规则/理由/验收要点);"规则 ↔ 命名测试" 一一对应,文档漏项会在移植走查(M7 逐条验收)中暴露 |
| 6 | ~~drizzle-kit 与 Electron ABI 冲突~~ | **已消解(M3)**:数据层改用 `node:sqlite` + 手写 SQL,无 drizzle-kit、无原生模块(§2.2);残余风险 = node:sqlite experimental API 变动 → contract 套件作升级门禁 |
| 7 | **agent 与 UI 写冲突、视图过期** | main 单一同步 better-sqlite3 连接串行化一切写入;任何来源的 mutation 都发 `gtd:changed` → TanStack Query 失效;MCP handler 与 IPC handler 共用同一批 use-case,一个 mutation 一条代码路径 |
| 8 | **中途切模型/effort 非原子**(end-and-resume 丢弃进行中的流) | 只在 turn 之间切换;流式进行中禁用控件;短暂 handoff 状态;历史由 `resume` 保留 |
| 9 | **transcript 隐私**(jsonl 明文包含用户的任务人生) | 自用构建下 transcripts 位于 `~/.claude/projects/<encoded-userData>/`(M1 定案:不重定向 CONFIG_DIR 以保订阅凭据,§6.1)——与用户自己的 CLI 数据同级、不进仓库;删除会话同时删 DB 行与对应 jsonl;远期选项:自定义 `sessionStore` 静态加密或 BYO-key 形态下重定向回 userData |
| 10 | **权限模型复杂度**(`tools`/`allowedTools`/`disallowedTools`/`canUseTool`/`permissionMode` 优先级文档不足) | 五种 UI 模式各自映射到唯一一组选项,集中定义在 `policy.ts`,每种模式一个集成测试;destructive 名单永不进 allowlist;`settingSources` 排除 `'user'`;`agent_audit` 让每次放行/拒绝可追溯 |
| 11 | **Electron 8 周更新车** | **原生模块折腾已消解(M3:node:sqlite,零原生依赖)**;剩余关注点 = Electron 升级带来的 Node 版本变动 → contract 套件 + CI 打包冒烟为升级门禁 |
| 12 | **monorepo 与打包工具链摩擦**(workspace 符号链接 × asarUnpack × 原生重建) | §3.4 降级预案:单包 + 目录边界,eslint-boundaries 维持依赖方向,接口与测试不变 |
