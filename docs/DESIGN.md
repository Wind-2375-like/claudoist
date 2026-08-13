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
│   │   │   │                         #   inboxItem.ts, label.ts, filter.ts, reminder.ts(context.ts 随 D-30 删除)
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
| `gtd:task.detail` / `gtd:task.addSubtask` / `gtd:task.comment.add` | R→M | 任务详情弹窗(子任务树 ≤5 层 + 评论 + reminders,D-21/22/INV-25/26);加子任务(继承父的容器/项目,支持完整属性集含 labels/reminders);加评论 |
| `gtd:tasks.setLabels` / `gtd:reminders.add` / `gtd:reminders.delete` | R→M | 详情右栏就地编辑既有任务的 labels(diff 式指派)与 reminders(D-22) |
| `gtd:tasks.reopen` | R→M | 撤销完成(done→active,仅当前任务不级联;误点完成圆圈的"再点一下复原",D-22) |
| `gtd:calendar.complete` | R→M | 完成硬边界日历项(Today 行式渲染的完成圈,D-22) |
| `gtd:calendar.list` / `gtd:calendar.create` / `gtd:calendar.complete` | R→M | Calendar 条目 |
| `gtd:today` | R→M | Today 视图复合查询(hard landscape + due,含本地 today 日期与 overdue 预判)——M4 实装,避免 renderer 先取日期再二次查询 |
| `gtd:waiting.list` / `gtd:waiting.create` / `gtd:waiting.resolve` | R→M | Waiting-for |
| `gtd:labels.list` | R→M | 标签 + 活跃任务计数(D-30:contexts 通道随情境合并删除) |
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
-- contexts 表随 D-30 删除(迁移 v11):情境并入 labels

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
  -- context_id 随 D-30 删除(迁移 v11):情境已并入 labels
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
  duration_minutes INTEGER,                             --   block 时长(分钟);NULL 回退 estimated_minutes
  -- (v12–v14 的外部日历列 time_zone / external_id / external_calendar_id /
  --  pushed_event_id / pushed_fingerprint 见迁移注释)
  repeat_unit TEXT,                                     -- 循环(迁移 v18,D-37/INV-36):
  repeat_every INTEGER,                                 --   六列一体存结构化规则(不用 RRULE:
  repeat_from TEXT,                                     --   表达不了 based-on-completed,UNTIL 与
  repeat_weekdays INTEGER,                              --   INV-03 冲突,解析失败=静默不推进)。
  repeat_until TEXT,                                    --   repeat_unit IS NULL ⟺ 不循环;
  repeat_anchor TEXT,                                   --   跨列 CHECK 钉死「全有或全无」;
                                                        --   anchor 只由人写,月末/闰日不漂移的载体
  series_id TEXT                                        -- 系列身份:完成史按系列分组;关闭循环不清
);
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
);                                            -- D-30 起 label 是唯一的标签维度

CREATE TABLE filters (                                  -- 保存的查询;预置 engage 风格 preset
  id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL,
  query_json TEXT NOT NULL                              -- D-32/v13 起存**查询原文**(INV-33),
);                                                      --  而非结构化 JSON(列名沿用,改名要重建表)

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
  sdk_session_id TEXT,                                  -- 可空(迁移 v14):会话行须先于 query() 插入
                                                        --   (流式期间 audit 与 stream 都要挂 conversation_id),
                                                        --   session_id 要等 system/init 才知道;fork 时更新
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

〔退役 D-30〕本节原描述 context 的 archive 机制;情境已并入 label(INV-24 退役),标签删除只解除关联、不影响任务,因此不再需要 archive 这一层。

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

### 6.3 MCP 工具面(M9 实现定稿)

`packages/agent-tools/src/toolCatalog.ts` 里一张 `SPECS` 表,**同时**用来:注册工具、
判定权限类别(§6.4)、渲染用户可见的「工具参考」手册(§6.13)。三者若各写一份,迟早对不上
—— 而权限那份对不上是安全问题:少标一个 destructive,`delete_task` 就在自动模式下直通了。

工具名 `mcp__gtd__<name>`,handler 在 main 直连同一 `GtdStore`;写工具走
`packages/agent-tools/src/writeTools.ts` → domain usecase → `store.apply(commands, 'agent')`,
与 UI/CLI 是同一条写路径。共 33 个(14 读 + 19 写),留在"逐 turn 上下文可接受"的量级内。

**只读工具(14)**

| 工具 | 参数 | 返回 |
|---|---|---|
| `get_now` | — | 此刻/今天/星期/时区/UTC 偏移/地区(§6.12) |
| `list_inbox` | — | Inbox 根任务(排除外部镜像) |
| `list_bucket` | `{ kind: someday\|reference }` | 孵化容器里的任务 |
| `list_today` | — | Today 三段口径(INV-20/D-19) |
| `list_calendar` | `{ fromDate, days }` | 区间内全天/定时任务 |
| `list_projects` | — | 活跃项目 + 进度 + `hasActiveNextAction` |
| `get_project` | `{ projectId }` | 项目 + 根任务 |
| `get_task_detail` | `{ taskId }` | 子任务树 + 评论 + 活跃后代数(**完成/删除前必调**) |
| `list_labels` | — | 标签 + 活跃计数(D-30) |
| `list_filters` | — | 保存的过滤器(名 + 查询原文) |
| `list_waiting_for` | — | 未解决的等待项 |
| `search` | `{ query, limit? }` | 跨实体命中(INV-32;不含软删) |
| `run_filter` | `{ query }` | **唯一的条件查询入口**(INV-33) |
| `get_engage_recommendations` | `{ labelName?, availableMinutes, energy }` | calendarFirst + top-7 候选(INV-20) |

所有任务投影都带 `when`/`due` 两个**相对此刻**的字段(§6.12)。

**写工具(19)** —— 全部返回 `{ ok, changed, ...consequences }`

`changed: false` 是合法返回(空 patch、同名标签):usecase 成功但一条命令都没发,
**等于什么都没改**。工具层如实回报,否则 agent 会对用户说"已改好"。

| 工具 | 效果 | 关键 consequences |
|---|---|---|
| `capture` | 逐条丢进 Inbox(INV-16 零判断) | `createdIds` |
| `create_task` | 建任务;挂进有 deadline 的项目会**静默继承**(INV-10) | `taskId`、`inheritedDeadline` |
| `add_subtask` | 建子任务(≤5 层,继承父的容器,INV-25) | `taskId`、`depth`、`inheritedDeadline` |
| `create_project` | 建项目(outcome 写成结果) | `projectId` |
| `update_task` | 改属性;日期传 null = 清除;镜像任务拒改标题与时间(INV-29) | `taskId` |
| `move_task` | 换容器;子任务会**脱离父任务**(INV-25.4) | `inheritedDeadline`、`detachedFromParent` |
| `set_task_labels` | 覆盖式设标签集合 | `taskId` |
| `update_project` | 改名/改 deadline;**默认不传播** | `tasksWithInheritedDeadline`、`propagated` |
| `complete_task` | 完成;**向下级联整棵活跃子树**(INV-26.1) | `completedSubtaskCount`、`parentCompletionCandidate`、`projectBreadcrumb` |
| `reopen_task` | 撤销完成(**不级联**) | `taskId` |
| `complete_project` ⚠ | 完成项目;**不动它下面的行动** | `activeTaskCount` |
| `delete_task` ⚠ | 软删;级联软删活跃子树(INV-26.2) | `deletedSubtaskCount` |
| `restore_task` | 从回收站恢复(**不级联**) | `taskId` |
| `create_waiting_for` | 记一条委派 | `waitingForId` |
| `resolve_waiting_for` | 标记已回音;**不建后续任务**(INV-23/INV-14 边界) | (无) |
| `create_follow_up` | 给未解决的等待项建催办行动(INV-23) | `followUpCreated` |
| `add_comment` | 追加评论(D-21) | `commentId` |
| `create_label` | 建标签(同名幂等) | `labelId`、`created` |
| `create_filter` | 保存过滤器(语法错拒绝) | `filterId` |

⚠ = 静态 destructive(§6.4);`complete_task` 是**动态** destructive。

**两条工具层纪律**(`writeTools.ts` 顶注):

- **agent 面前不出现 uuid**:项目/标签按名字传,在工具层解析。**解析不到就报错并列出现有
  选项,绝不顺手新建** —— 否则一个错别字会静默造出 `@erands`,用户按 `@errands` 过滤时
  永远看不到那条任务。
- **越界值挡在 zod schema**,而不是靠 domain 兜底:domain 对若干字段是**静默回退**
  (`estimatedMinutes` 非法 → 15、`priority` 越界 → 3、quickAdd 的 `energy` 完全不校验)。
  靠兜底的话 agent 填错了也不知道,于是把"我设成了 p9"说给用户听。

### 6.4 权限矩阵(M9 实现定稿)

五种模式 × 四类工具。判定表只此一处:`packages/agent-tools/src/permissionPolicy.ts`
(放在 agent-tools 而非 desktop,是为了**不依赖 Electron**,五格 × 四列能被单元测试逐格断言:
`packages/agent-tools/test/permission-policy.spec.ts`)。

**工具类别**(`CLASS_BY_TOOL`,与工具定义同源):

| 类别 | 成员 |
|---|---|
| `read` | 14 个只读工具 + 内置 `Skill`/`Read`(未知工具按只读处理) |
| `create` | capture、create_task、add_subtask、create_project、create_waiting_for、create_follow_up、create_label、create_filter |
| `edit` | update_task、move_task、set_task_labels、update_project、add_comment、reopen_task、restore_task、resolve_waiting_for、complete_task\* |
| `destructive` | delete_task、complete_project、**complete_task(目标有活跃子任务时)** |

\* `complete_task` 是**动态**分类:平时只是改状态(还能 reopen),但目标有活跃子任务时会
**级联完成整棵子树**(INV-26.1),而级联数量只在返回值里 —— 事后才知道。所以 `classify()`
按当前快照判断,有活跃后代就升级为 destructive,并把"会连带完成 N 个子任务"作为
`escalation` 一路带到审批弹窗上。

| UI 模式 | SDK `permissionMode` | read | create | edit | destructive |
|---|---|---|---|---|---|
| **只读**(plan) | `'plan'` | allow | **deny** | **deny** | **deny** |
| **逐条确认**(manual,默认) | `'default'` | allow | ask | ask | ask |
| **自动改已有**(acceptEdits) | `'default'` | allow | ask | allow | ask |
| **自动**(auto) | `'default'` | allow | allow | allow | ask |
| **全部放行**(bypass) | `'default'` | allow | allow | allow | allow |

规则:

- **放行一律经 `canUseTool`,不用 `allowedTools`,也不用 `bypassPermissions`**(D-33)。
  那两条路径会让调用绕过 `canUseTool`,于是不进 `agent_audit` —— 审计缺了自动放行的一半
  就等于没有审计。"全部放行"因此实现为 `canUseTool` 一律返回 allow,连
  `allowDangerouslySkipPermissions` 都不需要。
- **只读模式下写工具根本不注册**(`createGtdServer` 只在拿到 `write` deps 时才挂写工具)。
  纵深防御:即使判定表写错了,工具也不存在。冒烟对此有断言(`writeToolsAbsentInPlan`)。
- **"始终允许 \<tool\>"** 持久化在 `settings['agent.alwaysAllow']`,把 ask 变成 allow,
  **对 destructive 同样生效** —— 那是用户对具体工具的显式选择,比默认的谨慎更有权威。
  但它**捅不穿只读模式**:选了只读就是只读。
- **Bypass 打包版禁用**(`isModeAvailable(mode, app.isPackaged)`);设置里残留旧值也会被
  降级回默认,而不是照单执行。
- 模式切换即时生效(判定每次调用现读 settings);但**只读 ↔ 可写会改变工具面本身**,
  需要新建会话才完全生效,UI 会提示。

### 6.5 审批弹窗(canUseTool 桥)

`apps/desktop/src/main/agent/permissions.ts`:判定 → 需要时问渲染层 → 结果落审计。
推 `agent:permission.request { id, tool, input, toolClass, escalation?, reason, mode }`,
渲染层经 `agent:permission.respond` 回 `{ behavior, always? }` resolve 那个 promise。

**失败一律关闭(fail-closed)**。三种"问不到人"都判 deny:没有窗口、会话被中断
(`options.signal` abort)、渲染层 10 分钟不答。理由很直接:SDK 明说 permission prompt
**没有超时**,一个悬而未决的审批会让 agent 永久挂起;而"默认放行"会把一次窗口崩溃变成
一次静默的数据修改。宁可让 agent 收到"被拒绝"再重来。

**弹窗 UI**(`renderer/src/PermissionPrompt.tsx`):

- 面板内模态卡片(遮罩只覆盖右栏,中栏保持可见,便于对照数据)。
- 标题 = 人性化动词短语(`TOOL_LABEL` 映射,如 `delete_task` → "Claude 想删除任务")+ 类别徽章。
- destructive:红色边框 + `escalation` 单独一行醒目显示(**是数据算出来的**"会连带完成 3 个
  子任务",不是泛泛的"此操作有风险")。
- 入参逐字段列出(用户要能看出它到底要改哪一条,而不是只看见工具名)。
- 三个按钮:**拒绝**(Esc)· **允许这一次** · **始终允许 \<tool\>**。
- **回车什么都不做,允许只能点击;Esc = 拒绝**(初版规格里"回车 = Allow"被推翻两次)。
  弹窗可能在用户正打字时冒出来,回车放行删除不可接受;但"回车 = 拒绝"同样不行 —— 实测
  踩到:用户敲的那个回车本意是发消息,却静默否掉了一次审批,他还以为 agent 自己放弃了。
  误触的代价应当是"什么都没发生"。
- **队列**:一轮里可能连来两个审批,按到达顺序排队,一次只呈现一个(后来的不挤掉前一个)。
- 会话销毁 / 本轮中断 → 所有挂起审批立即打回 deny,不吊着。

### 6.6 System prompt 策略

`options.systemPrompt` 使用自定义 prompt,两部分:

1. **固化的易错不变量**(常量文本,与 [./INVARIANTS.md](./INVARIANTS.md) 同源维护):
   - priority 语义 1=最低、5=最高,永不重编号;⚠ 2026-08-11 曾按 D-29 翻转又当日被 D-31 撤回,**当前且永远是 5=最高**;过滤器语法 `p5` 也是最高,**与 Todoist 的 p1=最高相反** —— 用户说「p1」时先确认他指哪一头;
   - engage 能量过滤方向:任务 energy ≤ 用户 energy(精力好的人可做轻松任务,反之不行);
   - 带时间的任务本就是 Task(D-23 日历统一,不再有独立日历实体);**waiting-for** 仍单独计入项目的 active action(完成后果提示必须计入,INV-05);
   - someday/reference 是孵化容器,不进 Today 与 engage;**激活 = 用户显式移到任意其他容器**(Inbox 或直接进项目均可,移动本身就是理清,INV-21/D-20)—— **不是**「必须回 inbox 重走 clarify」;系统永不自动把它们移出;
   - 一切**跨实体**级联(项目完成、deadline 传播、完成后的下一步)必须先向用户提问、拿到确认后再单独调用写工具——收到 `consequences` 字段即视为"该提问了";
   - 但**同一任务子树内**的移动/软删/完成是单次动作的完整语义,**不需额外征询**(INV-15 例外):移动带子任务的任务 = 子树随动;软删 = active 子树级联软删;**完成父任务 = 连同其整棵 active 子树一并完成**(D-22/INV-26.1,返回 `completedSubtaskCount`)。方向仅向下 —— 完成子任务绝不改变父任务状态;
   - 只读阶段(M8)遇到"帮我做完/改掉"必须**明说自己没有写权限**,不得含糊带过或声称已完成。
2. **每次会话注入的轻量状态快照**(会话起始时由 main 组装):今天日期、标签列表及活跃计数(D-30)、inbox 条数、各项目未完成计数、今天的计划任务数(D-19 Today 口径)。让 agent 开口即有正确的日期与全局形势,不必先打一轮读工具。

### 6.7 CLI 操作通道(2026-08-09 用户定案)

`packages/cli`(`@gtd/cli`,依赖方向同 desktop-main:只向内引 domain + storage)提供命令行任务操作,两重用途:**① Claude Code 经 Bash 工具直接操作任务**(M8/M9 MCP 工具之前即可用,之后与 MCP 并存——MCP 走 in-process 实时,CLI 适合脚本/批处理);**② 用户自己的终端操作**。

- **调用**:`pnpm --silent cli <命令> [--json]`(`--silent` 保证 JSON 输出干净)。命令:`capture`、`add`(--desc/--date today|tomorrow|日期/--deadline/--priority/--project/--labels/--remind;**--parent=<任务> 建子任务**,继承父的容器/项目,≤5 层,D-21)、`list`、`today`、`show`(含子任务树与评论)、`comment <任务> <文本>`、`move`(根任务子树随动;子任务先脱离父)、`complete`(返回子任务/项目余活动提示)、`delete`(子树级联软删,输出数量)、`update`、`projects`(平面 + 进度)、`project-add` / `project-update`(--name/--deadline,--propagate 触发 §5.4 传播)、`labels` / `label-add` 管理(D-30:contexts 命令随情境合并退役)。任务/项目引用 = id / id 前缀 / 名称全等;`--json` 输出含 id,供 agent 消费。
- **DB 定位**:`CLAUDOIST_DB` env > `--db=` > `--prod`/`--dev` > 自动(dev 库存在且 prod 不存在 → dev,否则 prod);输出附带实际路径,杜绝写错库。
- **并发**:同库多进程靠 SQLite WAL;连接统一 `busy_timeout` 2s;写路径仍是 domain usecase(与 UI/未来 MCP 同一套)。
- **应用实时感知外部写入**:main 进程 `fs.watch` DB 与 `-wal` 文件,300ms 防抖后广播 `gtd:changed`(actor='agent')——CLI/agent 改数据,窗口内视图即时刷新。

### 6.8 agent_audit 审计

SDK 无内置审计。落账分两步,都在 `apps/desktop/src/main/agent/`:

- **审批时**(`permissions.ts`)写一行:`tool_name`、`input_json`、`decision`
  (`allowed-auto` / `allowed-user` / `denied`)、`conversation_id`、时间。因为放行全部经
  `canUseTool`(§6.4),**自动放行的调用同样有行** —— 这正是不用 `allowedTools` 的原因。
- **结果回来时**(`bookkeeping.ts`)回填 `result_summary`:审批发生在执行**之前**,结果只能
  等 `tool_result` 回灌时按 `toolUseID → 审计行 id` 的映射补上。

IPC handler 与无头冒烟走**同一段**桥接代码(`bookkeeping.ts`)。M8 的冒烟自建过一套简化
canUseTool,那验的是"我写的假桥能跑" —— 权限这种一处漏就全盘失效的东西,冒烟必须打在
生产路径上。

用途:问题溯源、行为回放,以及**将来 undo 的基础**(知道 agent 改了什么才谈得上撤销)。
UI 在 Agent 设置的「权限与审计」页,可切"本会话 / 全部会话"。

---

### 6.11 prompt 的三层:哪些用户能改

按 Claude Code 的标准做法分层。**加载机制不是我们自己拼字符串**:会话 `cwd = userData`、
`settingSources` 含 `'project'`,SDK 自动读取 `<cwd>/CLAUDE.md`。

| 层 | 内容 | 谁能改 | 为什么 |
|---|---|---|---|
| **固化不变量**(`agent/systemPrompt.ts`) | priority 方向、energy 过滤方向、计划日/截止日之分、级联规则、单一口径纪律 | **不可改** | 这些不是偏好而是正确性约束 —— 改了 agent 就会给出与界面不一致的答案。每条标 INV 编号,`pnpm check-prompt` 在 CI 里断言其仍然有效 |
| **启发式总纲**(同上,`COACHING_CLAUSE`) | 一次一个问题、不替用户决定、先报数量再摊开 | **不可改** | D-28 的产品定位 |
| **`<userData>/CLAUDE.md`** | 称呼、语气、作息时段、默认可用分钟、个人 GTD 习惯 | **用户随意改** | 本来就该由用户定;agent 面板标题栏 ⚙ 直接打开 |
| **会话状态快照** | 此刻/时区/地区、各容器计数 | 自动 | 每次开会话由 main 组装 |

`CLAUDE.md` 与 skill 文件的关键差别:skill **每次启动重写**(内容随版本走),CLAUDE.md
**只在缺失时创建一次**,此后再不触碰 —— 它是用户的文件。模板里明写了"哪些改这里没用",
免得用户以为可以在这儿改优先级方向。

### 6.14 「账号与用量」与零 token 探针(D-34,2026-08-12,M11-A)

**目标**:把这一页做成 Claude Code `/usage` 对话框那样 —— 账号(登录方式/邮箱/组织/订阅)、
订阅额度(Session 5 小时 / Weekly 7 天 / Weekly ·<模型>,带重置倒计时)、
以及「什么在消耗你的额度」(近 24 小时 / 近 7 天 × 行为特征 + skill/MCP/子代理归因)。

#### 零 token 探针

这三样数据都挂在 `Query` 上,而此前应用里只有"用户发过消息才有 Query"。于是有两个
荒谬的限制:没聊过天看不到用量,**也换不了模型**。

破解点:SDK 那句 "only supported when streaming input/output is used" 说的是
**prompt 必须是 `AsyncIterable`**,不是"必须先发过一条消息"。给它一个**永不 yield**
的 AsyncIterable —— 子进程照常起来、控制通道照常可用,而**模型一次都不会被调用**
(实测 `session.total_cost_usd === 0`、`model_usage === {}`,端到端 0.8–1.7s)。

`apps/desktop/src/main/agent/probe.ts` 的选路:

```
onQuery(fn)
  ├─ 有活会话 && 不忙  →  蹭活会话(~285ms,不起进程)
  └─ 否则             →  起一次性探针(~1s),读完立刻 abort
```

**三条硬纪律**(违反任何一条 = 用户正在进行的对话被踢掉):

1. 探针用**自己的** `AbortController`;
2. **绝不**调 `startSession()` / `destroySession()`(前者开头就把 live 销毁了);
3. `finally` 里只 abort 自己那一个。

忙的时候**不蹭**活会话:"turn 进行中调 `usage()` 会不会打断这一轮"没验证过,而探针与
长驻会话并存是**实测安全**的(两个独立子进程,同 cwd 不冲突)。探针的 options 极简:
`tools: []`、`settingSources: []`、不注入 GTD MCP —— 它连数据库都不碰。

⚠ 探针**绝不能**设 `CLAUDE_CONFIG_DIR`:一设凭据就不可见(M1 实证),会误报"未登录"。

#### 三层取数与降级

| 层 | 来源 | 能给什么 |
|---|---|---|
| L1 | 活会话 | 全部,最快 |
| L2 | 零 token 探针 | 全部 |
| L3 | `~/.claude.json`(`oauthAccount` + `cachedUsageUtilization`) | 账号 + 额度窗口;**没有**消耗归因 |
| L4 | 什么都没有 | 只显示"取不到",**不显示 0%**(0% 会被误读成"还没用量") |

L3 有三道校验,任何一道不过就当缓存不存在:JSON 合法 / `accountUuid` 与
`oauthAccount.accountUuid` **一致**(否则换账号后会拿上一个账号的额度糊弄用户)/
写入时刻在 1 小时内。缓存里的 uuid 只用于**比对**,绝不进 VM、绝不进日志。

**断网时 SDK 会静默返回磁盘缓存,且响应体里没有任何 stale 标记** —— 分辨不出实时还是缓存。
所以面板顶部那条"实时 · 更新于 HH:mm"说的是**我们发起请求的时刻**,不声称是服务端实时值。

#### 数据的三个坑(都在 `usageModel.ts` 里挡住)

1. **运行时字段远多于 sdk.d.ts 声明的**:`rate_limits` 里还有 `limits[]`、`spend`,以及
   `tangelo` / `nimbus_quill` / `cinder_cove` 这类代号桶。代号桶**拿不到显示名,一律忽略** ——
   硬编码成产品名既没依据也会随发布轮换而错。`limits[]` 只在 `model_scoped` 缺席时作为
   fallback 读四个字段(`kind`/`percent`/`resets_at`/`scope.model.display_name`,CLI 自己的
   缓存 schema 校验过这四个);`severity`/`is_active` 不读 —— 颜色我们自己按百分比算。
2. **同一概念两个来源两种形态**:`account.subscriptionType` 已经是展示串(`'Claude Max'`),
   `usage.subscription_type` 是原始枚举(`'max'`)。混用必错。
3. **`behaviors[].key === 'cron'` 与定时任务毫无关系** —— 它的原文是
   "sessions active for 8+ hours"。按 key 名直译成"定时任务"是这份数据最容易犯、
   也最难被发现的错。

`usageModel.ts` 全程 `unknown` + 逐字段 typeof 校验,**任何形状不符一律降级,绝不 throw**
(那个接口名字里就写着 `EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`)。
19 条单测专门打畸形输入。

#### 两处必须写清楚的口径

- **「什么在消耗你的额度」是全机器口径**:它扫的是本机全部 Claude Code transcript,
  包含用户自己在终端里的用量。不写清楚,用户会把终端里的量算到这个 GTD 应用头上
  (实测本机 99% 来自 subagent 密集会话 —— 而本应用根本不给 subagent 工具)。
  另外这些特征**彼此重叠、不是占比拆分**,加起来可以超过 100%,所以**禁止画成堆叠条或饼图**。
- **订阅额度与本应用花费是两回事**:后者是按 API 标价折算的**估值**,订阅用户不会被扣。
  两块分开显示并明说,否则用户会以为自己在烧钱、或以为调高预算就能突破配额。

#### 护栏(可调)

`maxTurns` / `maxBudgetUsd` 是 `query()` **起进程时的 CLI flag**,控制通道里没有对应方法:

- `Options` 里有、`Settings` 里没有;控制请求 subtype 全表无 `set_max_turns`/`set_max_budget`;
- ⚠ **`applyFlagSettings({maxTurns: N})` 会返回成功但什么都不做** —— flag 层对未知键无校验
  直通,`effective` 里连编造的假键都在,只有 `applied` 才是真正采纳的集合。这是个静默陷阱。

所以改完只能重起会话。**刻意不自动重起**:设置页是模态弹层,用户可能只是随手拖了一下滑杆,
静默销毁会话是不可逆的;正在回复时重起还会把那一轮丢掉。给显式按钮 + 琥珀提示条,
走 `resume`(不 fork)保留上下文。

两处文案改写(原来的会误导):

- ~~「每会话最多轮次」~~ → **「单条消息内最多工具往返」**。到上限会停,发「继续」就接着跑。
- ~~「每会话预算上限 $5」~~ → **「单次会话工作量刹车」**,并明说"你是订阅用户,这笔钱不会被扣;
  真正的配额是上面那几条进度条"。

**`maxBudgetUsd` 的下限必须 > 0**:判定是"累计成本 ≥ 上限",传 0 会让会话一开口就熄火。
「不限」映射成**不传该选项**,不是 0。

超限时的 UI(在聊天区):`error_max_turns` 渲染成灰色内联提示(会话仍活着);
`error_max_budget_usd` 渲染成红色 + 「重起会话」按钮 —— **这个状态是粘住的**,
判定是只增不减的进程累计成本,一旦触发之后每条消息都会立刻返回同样的错、一个 token 都不跑。
不专门识别它,用户只会对着一条看不懂的红字反复发消息。

#### 模型直接可改

`agent:models` 走探针,不再要求活会话(界面上那句「先发一条消息,再回来切换模型」删掉)。
切模型是**双写**:先落盘(保证下次起会话用它),再热切(保证当前会话立刻变)——
只做一半都会出 bug。`ModelInfo` 的 id 字段叫 **`value`**(不是 `model`/`id`)。
换模型会改变 effort 档位的可用性,所以切完要让模型缓存失效并重取。

探针结果在主进程缓存 **60 秒**,面板同时要账号/用量/模型也只起一个子进程;点「刷新」强制重取。
**不做轮询** —— `usage()` 每次都真发一个 HTTPS 请求。

---

### 6.13 Agent 面板的账号/用量/模型/Skills(2026-08-11 用户反馈后补)

- **用量不挂在 composer 下面**。原先 footer 常驻 `4→431 tok · 缓存写入 6992 · ≈$0.0877` ——
  既看不懂也没人一直盯着。改为标题栏的**账号按钮**(绿点 + 邮箱前缀)打开三页弹窗:
  **账号与用量 / 我的偏好 / Skills**。用量累计保存在**主进程**,渲染层重挂载或切视图都不会把账清零。
- **模型切换**用 `Query.supportedModels()` + `setModel()`(仅 streaming-input 可用,故需活会话;
  选择落 `settings.agent.model`,下次开会话沿用)。
- **CLAUDE.md 在应用内编辑**,不跳外部编辑器。
- **Skills 可增删改**:
  - 内置 5 个随应用发布;**用户改过的不再被覆盖** —— 判据是文件内容哈希是否仍等于我们上次
    写下的(哈希存 `settings.agent.skillHash.<name>`)。改过的行显示"已被你修改"并提供**恢复默认**。
  - 用户可新建自己的 skill(名字即目录名与调用名,限小写字母/数字/连字符);内置的删不掉。
  - `options.skills` 取**目录里的全部** skill(含用户自建),不再是硬编码名单。
  - **早先的实现是每次启动 `rm -rf` 整个 skills 目录再重写** —— 只有内置 skill 时没问题,
    一旦允许用户自定义就会删掉用户的东西。这类"为了保证干净而清空"的做法,代价总是落在用户身上。
  - 同步时机在**应用启动**(而非会话启动):否则用户没聊过天就点开 Skills 会看到空列表。

### 6.12 时间、时区与"空间"(2026-08-11 用户反馈后补)

**问题实录**:此前只注入 `today`(一个日期)。agent 看到一条 8/18 的会议,既不知道现在
几点、也不知道 8/18 离今天多远,于是把**下周的会议**当成"现在能做的候选"并建议去完成。

三处补齐:

1. **每条用户消息前置 `[此刻 …]`**:时刻 + 星期 + IANA 时区 + UTC 偏移 + 地区,单独一个
   content block。只在会话开头注入一次不够 —— 长会话跨几小时甚至隔夜,模型对"现在"的
   印象会停在开场那一刻。
2. **每个任务带相对时间**:工具返回的 TaskView 上补 `when`(如"3 天后(2026-08-14 10:00)"、
   "今天 15:00,还有 2 小时 10 分钟"、"正在进行")与 `due`(如"已逾期 2 天")。与其指望模型
   自己算日期差(它常算错),不如直接给。
3. **`get_now` 工具**:长会话里可主动重新校时。

system prompt 相应加了两条:时间以这些字段为准、不要自己算;**排在几天后的日程不是此刻的
候选**,用户问"现在做什么"时不要建议他去"完成"一个还没发生的会议。

> "空间":本仓不建模任务级 location(决策日志已定不做)。给 agent 的是**时区与地区** ——
> 对排程而言这正是可用的空间近似(用户在哪个时区、几点算工作时间)。真需要按地点过滤时,
> 用标签(`@office` / `@home`)表达。

### 6.10 M8 实现要点(2026-08-11 落地,以下为**实测结论**)

| 事实 | 依据 |
|---|---|
| `allowedTools` 只是"免确认自动放行"名单;**收窄工具面靠 `tools`** | `sdk.d.ts:1399/1455`;冒烟实测 `tools: []` 后 `system/init.tools` 里内置工具清零 |
| `tools: []` 会**连 `Skill` 一起关掉**,skill 就加载了也调不动 | 冒烟第一轮实测:`builtins: []` 且 agent 无法进入 skill。故取 `tools: ['Skill']` |
| `system/init` 回报 `skills` 是**发现**到的(含用户 `~/.claude/skills`),`options.skills` 是**启用过滤器** | 冒烟实测发现 20 个、启用 1 个;未列出的对模型隐藏且 Skill 工具拒绝。再加上不给 Read/Bash,用户私人 skill 既看不到也调不动 |
| `env` 一旦设置就**整体替换** `process.env`,不合并 | `sdk.d.ts:1475`;必须先 spread,否则 PATH/HOME 全丢 |
| `maxBudgetUsd` 确实存在 | `sdk.d.ts:1707`,超限返回 `error_max_budget_usd` |
| 控制方法(`interrupt`/`setModel`/`setPermissionMode`)**仅 streaming-input 可用** | `sdk.d.ts:2358-2377` |

**M8 有意留白**(不在本里程碑做,避免验收标准与实现对不上):

- `conversations` 表与 `agent_audit` **不写**。M8 只维持一条会话,续接靠 settings 里的
  `agent.lastSessionId`;会话列表/fork/删除是 M10,而只读期所有工具都自动放行、没有权限
  决定可记,audit 会话行只会产生噪音。迁移 v14 已把 `sdk_session_id` 改可空,M9/M10 接上即可。
- 模型/effort/thinking 切换、图片以外的附件:M10。

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
- **一律启发式**(2026-08-11 用户定案):agent 提问、给选项与各自的代价,让用户**自己**判断。
  GTD 的价值恰恰在那些判断上 —— 直接给答案会把整个过程抽掉,清单是齐了,脑子里那本账没建
  起来。具体纪律(每个 skill 都带一份、system prompt 也固化一份):一次只问一个问题、不替
  用户决定、工具返回一大堆时先报数量再摊开两三条、事实作补充而非结论。
- **五个 skill**:`gtd-engage`(挑一件事做)、`gtd-today`(今天什么最紧)、`gtd-plan-day`
  (规划今日行程)、`gtd-clarify`(理清收件箱)、`gtd-weekly-review`(开始周回顾)。M8 全部
  走到"该你决定了"为止,落笔动作由用户在界面上做;M9 补上写工具后只需去掉各 skill 末尾的
  降级说明,**步骤本身不变**。
- **入口 = composer 下方的一排建议按钮**(顺序即上面五个),点击即把对应提示发给 agent
  (与 §7 的上下文 chip 同区)。按钮只是**预置提示**,不是状态机——用户随时可以改口、跳步、
  中途问别的;流式进行中禁用。
- **因此中栏没有 Focus 面板、没有回顾向导、侧栏没有 Weekly Review 项**;中栏只承载"看和
  改数据"的视图(Inbox / Today / Calendar / 项目 / Search / Filters & Labels)。

**落地机制(2026-08-11 勘察实证)**:SDK 有 `options.skills?: string[] | 'all'`
(`sdk.d.ts:2010`),skill 因此有真实载体,不必自己发明发现机制。三条约束:

- **不走 `~/.claude` 发现**:`CLAUDE_CONFIG_DIR` 按 M1 定案不重定向(§6.1),若让 skill
  经用户 config 目录发现,应用的 skill 会污染用户自己的 Claude Code 环境,反之亦然。
- **打包**:skill 文件若打进 asar,子进程读不到(§9.3 的 `asarUnpack` 同理)。**M8 必须先做
  一次加载冒烟**(dev + 打包版各一次),与 M1 的 CONFIG_DIR 冒烟同性质 —— 机制没验证前
  不写 skill 内容。
- **skill 在应用内一律走 MCP 只读工具,不走 CLI**:走 CLI 需要开内置 `Bash`,而 Bash 能跑
  `pnpm cli complete` 这类写命令,与 M8「只读版无写路径」直接冲突。**`@gtd/cli` 出口只供
  用户自己的终端与外部 Claude Code 会话**(§6.7)。另注:`review` / `weekly-review`
  **没有** CLI 命令,"同名命令"只对 `engage` 成立。

**skill 与单一口径**:skill 的典型失败模式是"自己 `list_tasks` 再筛一遍"。INV-20.6 /
INV-32.6 / INV-33.9 点名 **agent skill 也在约束内** —— 择事必须走
`get_engage_recommendations`、条件查询必须走 `run_filter`,不得自行重写过滤。

**按能力切分到里程碑**(原先四个 skill 全堆在 M10,M8 的"只读部分"没有落点):

| 里程碑 | skill 交付 |
|---|---|
| **M8(只读)** | 加载机制冒烟;`engage` 的**推荐半程**(到"top-7 + 今天的计划"为止,INV-20.5 明确推荐是只读、完成是独立写操作);建议按钮的**壳**(按钮在、点击发预置提示;需要写权限的按钮明确降级说明) |
| **M9(写)** | `clarify`、`decompose`、`engage` 的完成动作、`weekly-review` 的 Step 1–5 —— 全部依赖写工具与征询纪律,随写工具一起验收 |
| **M10** | skill 全集打磨 + coaching evals(回归测试) |

> 载体归属:M7 只做 Search 与 Filters & Labels。此前 M7a 已实现的桌面 Focus 面板据本决策
> **撤除**(domain 规则与 CLI `engage` 保留)。

### 6.15 对话渲染与「复制出 Markdown 原文」(2026-08-12)

用户反馈三条:对话里的文字选不中、agent 回复没渲染、没有复制按钮,并且明确要求
**选中 + Cmd/Ctrl+C 复制到的应当是 Markdown 原文片段**。

**选不中的根因不在对话区**:`App.tsx` 根节点上挂着 `select-none`,整个应用的文本都选不了。
把它收窄到真正需要的地方 —— 可拖拽的任务行(选中文本会跟 HTML5 拖拽打架)与日历网格
(拖拽建块)。

**渲染器手写,不引库**,两条硬约束逼出来的:

1. **绝不 `dangerouslySetInnerHTML`**。这里渲染的是模型输出,当 HTML 塞进 DOM 等于开一条
   注入通道。渲染器只产出 React 节点,文本一律走 React 转义。
2. **复制要还原原文**,而渲染成 HTML 之后浏览器默认复制的是**可见文字**(`**粗体**` 变成
   `粗体`,粘回去就不是 Markdown 了)。要还原就得在渲染时记下**每个叶子对应的源码区间** ——
   现成的库很少直接给这个映射。

做法:每个叶子 `<span>` 带 `data-ms`/`data-me`(源码区间)。纯文本叶子的渲染文本与源码
**逐字符对应**,选区偏移可精确换算;带标记的叶子(粗体/行内代码/链接)渲染文本比源码短,
标 `data-mx="1"`,复制时**整段取用** —— 宁可多带上它自己的 `**`,也不能给出一段少了标记、
粘回去不成立的 Markdown。`copy` 事件在消息容器上被接管;选区不在气泡里时原样交回浏览器。

实测(dev 通道 `--screenshot-eval`,真实 Electron 里跑):选中渲染后的 `粗体` → 复制得
`**粗体**`;跨叶子选 `是粗体和` → 得 `是**粗体**和`;纯文本内部分选 `这` → 得 `这`。

另有每条回复右上角的「复制」按钮,复制整条原文。

---

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

- **Add task(全局 "+",⌘N;2026-08-08 M5 反馈定案为 Todoist 式单卡)**:一张卡片 —— Task name + Description 两行输入,下方属性 chip 行:**Date**(Today / Tomorrow / 自选 → `scheduledDate`)、**Deadline**、**Priority**(文字 最高/高/中/低/最低,存储 1–5,1=最低,不重编号)、**Labels**(多选)、**Reminders**(datetime,落 `reminders` 表;响铃调度 M6),底部位置选择器(**Inbox ▾** / 任意项目)+ Cancel / Add task。**语义**:位置=Inbox 且未 specify 任何属性 → 纯捕捉(`createInboxItem`,零摩擦);specify 了任意属性或选了项目 → 直接建 Task(相当于已理清)。attachment 并入 M10;location 不做(决策日志)。
- **Search(⌘K,M7a;INV-32)**:自绘命令面板(未引 `cmdk` —— 只需输入框 + 列表 + ↑↓/↵/Esc,一个依赖换不来什么),数据源 `gtd:search` → domain `searchAll`。侧栏 Search 项与 ⌘K 等价。
  - **覆盖**:任务(标题 + 描述,含子任务、someday/reference、Upstream 镜像、已完成归档)与项目。容器模型下这些都是带 `bucket` 的 Task,故同属一组,由 VM 按容器给出二级说明(`Inbox · @home`、`发布 1.0 · @computer`、`已完成 2026-08-11`)。
  - **不列**:软删除项(无恢复入口,点了无处可去,INV-32.3)、等待项(桌面无该视图;CLI `search` 会列)。
  - **导航**:命中即跳到该条目的**容器视图**(而非它恰好出现的 Today/日历),任务再顺手打开详情弹窗;跨视图跳转的详情态由 App 层持有,各视图自己的详情态管不了别人。
  - 原规划里的命令动作("Focus mode"、"Start Weekly Review")**随 D-28 取消** —— 这些是 agent skill 的入口,不是搜索结果。
- **TaskRow(全视图统一行组件)**:完成勾选圈(**complete↔reopen 可切换**:active 圈点击完成、done 圈点击撤销,D-22 误点即可复原)、标题、属性 chip(计划日 / 截止 / 优先级文字 / **标签**(写作 `@名字`,D-30 起情境即标签));**点击行主体(非勾选框)→ 任务详情弹窗**;右键菜单(完成 / 编辑 / 删除=软删);完成控件 **hover 提示**:带未完成子任务时提示"将连同 N 个子任务一起完成(误点可再点一下撤销)"(D-22 向下级联)。日历项(Today 硬边界)复用同一行式渲染(完成圈 + 标题 + 时间 chip),不再是独立卡片块。
- **任务详情弹窗(D-22 Todoist 式两栏,单击任务打开;与右键"编辑"的 TaskCard 不同)**:**左栏 = 内容** —— 完成圈 + 标题、描述、**子任务区**(直接子任务用 TaskRow 渲染,可右键完成/删除、单击下钻;"+ Add sub-task" 打开与添加任务相同的 TaskCard,默认继承父的位置/context,≤5 层)、**评论区**(时间序 + 输入框;附件 M10);**右栏 = 属性面板** —— Project/位置(可编辑,**Move to** Inbox/Someday/Reference/项目)、Date、Deadline、Priority、Labels、Reminders、@context,逐项点击就地编辑(经 `tasks.update`/`tasks.move`/label·reminder 通道)。下钻子任务时顶部显示返回按钮(标签 = 真实上一层标题,非父链)。
- **Inbox(容器模型,INVARIANTS D-20,2026-08-09 定案)**:`bucket='inbox'` 的**任务列表**(仅根任务成行,子任务在详情内)——task 生在 Inbox,不挪不消失。右键"编辑"展开 TaskCard;**Move to** 选择器(Inbox / 项目 / Someday / Reference)执行容器移动;底部内联 "+ Add task"。理清 = 编辑属性 + Move(或勾完成);想让 Claude 理清就直接在右栏对话——**无专用按钮**。
- **Today(D-21/D-23 日历统一:单一列表,全行式)**:**统一任务列表** = `scheduledDate ≤ 今天` ∪(`deadline ≤ 今天` 且未计划)的 active 任务(someday/reference 不入;过期高亮)。计划段排序:计划日升序 → **全天在前 → startTime 升序**(原 hard-landscape §2.5 排序语义并入,**无独立日程段** —— 带时间任务即日历 block,行上显示 🕐 时间·时长 chip)。TaskRow 渲染与 Inbox 完全一致;底部内联 **"+ Add task"**(默认 `scheduledDate=今天`);拖到底部虚线区 = 推迟到明天。**无 Focus 入口**——择事由 agent skill 承载(§6.9,D-28)。
- **Calendar(M6b,D-23/INV-28;取代原 "Upcoming" 规划)**:周网格 —— 7 列 + 左侧时刻槽 + 顶部**全天段**;上下滚动 24 小时,首屏定位 07:00,今天列显示当前时刻红线。日历 = 任务按 `scheduledDate + startTime` 的投影(**无独立实体、无独立写路径**):
  - **建块**:空白处单击某刻度 → 默认 30 分钟块;按住拖选 → 该区间;全天段单击 → 全天任务。均弹轻量 composer(标题 + 回车创建),走 `quickAddTask`。
  - **改块**:拖动块 = 改 `scheduledDate`(跨列)/`startTime`;拖底边 = 改 `durationMinutes`;拖到全天段 = 清时刻。均走 `updateTask`。
  - **其他**:单击块 = 打开任务详情弹窗;右键 = 完成/撤销完成、移到全天、删除(= 软删任务,INV-22);重叠块并排分栏;**完成的块仍在日历上**(灰显划线,D-23 用户定案)。
  - 吸附/区间/分段口径全部来自 domain `rules/calendarGrid.ts`(INV-28),CLI `calendar` 命令共用,两处不得各写一套。
  - deadline 的双轨可视化(due chip)与拖拽改 deadline 顺延至后续里程碑;当前 deadline 仍在行内 🎯 徽标显示。
- **Filters & Labels(M7b,INV-33)**:两段式,对齐 Todoist 的同名页面。
  - **My Filters**:保存的 `filters` 行,每行显示名称、**查询原文**与命中数;语法错误直接标红在行上(而不是等点进去才炸)。新建 = 名称 + 查询两个输入框,下方可展开**语法速查表** —— 一个没人记得住写法的查询语言等于没有。点行 → 查询结果页。
  - **Labels**:标签 + 活跃任务计数,可新建 / 改名 / 删除(删除只解除关联,不动任务);点行 → 该标签的结果页(`@名字`)。D-30 后情境即标签,故原"contexts 置顶"一说作废。
  - **查询结果页**:顶层逗号分段 → 每段一个列表,段标题即该段查询原文。引用到不存在的标签/项目时给黄色提示条而非报错(INV-33.8)。
  - **⌘K 也认标签与过滤器**:输入 `@home` / 过滤器名即出对应条目,回车进结果页(Todoist 同款)。
  - **过滤器可就地编辑**(名称 + 查询同时改,回车保存 / Esc 取消;2026-08-11 用户反馈补)。
- **导航历史(2026-08-11 用户反馈)**:点进过滤器/标签/项目后必须退得回来。中栏顶部常驻
  `‹ ›` 按钮(仅在有历史时出现),另支持 **⌘[ / ⌘]** 与**鼠标侧键**(Chromium button 3/4,
  须 preventDefault 掉默认的页面级导航)。实现为**栈 + 游标**而非只记上一个,故连续下钻
  多层也退得回;原地重复点同一项不入栈,否则会出现点了后退却不动。
  - 虚拟 **@waiting_for** 视图仍未实现(waiting_for 表当前无 UI 入口),保留为后续里程碑;绝不摊平成普通 label。
  - 预置过滤器:"Low energy · <15 min"、"Due this week"、"No project"、"High priority next"、"该排期了"(`deadline before: +7 days & no date`)。
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
