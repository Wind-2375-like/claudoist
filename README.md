# Claudoist

Todoist 风格的 macOS 桌面 GTD 应用,内嵌 Claude agent:左栏导航 / 中栏内容 / 右栏 agent 聊天面板。agent 通过 MCP 工具与 UI 读写同一份 GTD 数据,变更实时联动、可审计、可控权限。

> 项目处于按里程碑逐步开发阶段,当前进度见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 文档

| 文档                                     | 内容                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [docs/DESIGN.md](docs/DESIGN.md)         | 架构设计:技术选型、monorepo 结构、进程模型与 IPC、数据模型、Agent 集成(MCP 工具面、权限矩阵、审计)、视图规格、打包与 dev/prod 分离 |
| [docs/INVARIANTS.md](docs/INVARIANTS.md) | GTD 业务规则**唯一权威**:实体语义、编号不变量(INV-xx)、流程规格、与原 CLI 的有意差异、禁止复刻的 bug                               |
| [docs/ROADMAP.md](docs/ROADMAP.md)       | 里程碑(M0–M11)、验收标准、协作流程、决策日志、变更记录                                                                             |

## 技术栈

Electron + electron-vite + electron-builder · React 19 + Tailwind · pnpm workspaces(`@gtd/domain` 纯 TS 领域核心 / `@gtd/storage-sqlite` / `@gtd/agent-tools` / `apps/desktop`)· `node:sqlite`(零原生依赖,手写 SQL + user_version 迁移)· [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)(main 进程,in-process MCP server)

## 开发

```bash
pnpm install        # 依赖(pnpm 版本由 packageManager 字段钉死,corepack 自动管理)
pnpm dev            # 启动开发窗口(数据在 "~/Library/Application Support/Claudoist-dev/")
pnpm lint           # ESLint(含依赖方向检查)+ Prettier
pnpm typecheck      # 全部包 tsc --noEmit
pnpm test           # Vitest
pnpm dist           # 构建并打包未签名 dmg(apps/desktop/release/)
```

> 注意:在由 VSCode 扩展派生的终端里,环境可能泄漏 `ELECTRON_RUN_AS_NODE=1`,导致 Electron 以纯 Node 模式启动而报 `Cannot read properties of undefined (reading 'isPackaged')`。普通终端无此问题;必要时用 `env -u ELECTRON_RUN_AS_NODE pnpm dev`。

## CLI

与 App 操作同一数据库(设计见 docs/DESIGN.md §6.7);CLI 写入后开着的 App 自动刷新。主要供 Claude Code 经 Bash 操作任务,人工使用亦可:

```bash
pnpm --silent cli help                                  # 全部命令
pnpm --silent cli capture "一个想法" "另一个想法"          # 零判断捕捉进 Inbox
pnpm --silent cli add 写周报 --date=today --deadline=tomorrow --priority=1
pnpm --silent cli add "写 release notes" --parent=<任务>  # 建子任务(≤5 层,继承父的位置)
pnpm --silent cli comment <任务> "记得配截图"             # 评论;show 显示子任务树+评论
pnpm --silent cli list inbox --json                     # JSON 输出(含 id)
pnpm --silent cli move <id前缀|标题> someday             # 也可挪到项目(名称/id;子树随动)
pnpm --silent cli complete <id前缀|标题>                 # 子任务/项目余活动以提示返回
pnpm --silent cli projects                              # 平面项目 + 进度条
```

DB 定位:`CLAUDOIST_DB` 环境变量 > `--db=` > `--prod`/`--dev` > 自动(dev 库存在且 prod 库不存在则用 dev)。

## 原则

- 源码仓库不含任何用户数据;运行数据全部在系统 userData 目录(dev 环境自动使用 `-dev` 后缀目录)。
- 业务规则先写文档、再写测试、后写实现;`@gtd/domain` 对 INVARIANTS.md 的每条不变量有同名测试。
- agent 与 UI 共用同一批 use-case;一切级联操作必须征询用户,绝不自动连锁。

本项目的前身是一个单文件 Python GTD CLI(见 git 历史 `get_things_done.py`),其全部行为已固化进 INVARIANTS.md。
