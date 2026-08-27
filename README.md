# Claudoist

<p align="center"><img src="apps/desktop/build/icon.png" width="128" alt="Claudoist icon"></p>

Todoist 风格的 macOS 桌面 GTD 应用,内嵌 Claude agent:左栏导航 / 中栏内容 / 右栏 agent 聊天面板。agent 通过 MCP 工具与 UI 读写同一份 GTD 数据,变更实时联动、可审计、可控权限、可回滚。

主要能力:捕捉与理清(Todoist 式快速添加)、平面项目 + 子任务树、日历(本地周视图 + Google 日历双向)、循环任务(含 custom repeat)、过滤器查询语言、⌘K 搜索、主题(内置 Solarized)与分部位中英文字体自定义、agent 写入审批 / 审计 / 对话分叉与数据回滚。

> 项目按里程碑逐步开发,进度见 [docs/ROADMAP.md](docs/ROADMAP.md)。

---

## 安装(普通用户)

**前置条件(重要):**

1. **macOS(Apple Silicon)**。Intel 机器需自行从源码构建(见下,`--x64`)。
2. **Claude 订阅 + Claude Code 登录**:agent 面板复用本机 [Claude Code](https://claude.com/claude-code) 的登录凭据 —— 先安装 Claude Code 并运行 `claude` 完成一次登录。没有订阅也可以在应用设置里录入 Anthropic API key 作为备用(safeStorage 加密保存,按量计费)。
3. (可选)Google 日历同步需要**你自己的** Google OAuth client(下述)。

**步骤:**

1. 从 [Releases](../../releases) 下载 `Claudoist-x.y.z-arm64.dmg`。
2. 打开 dmg,把 `Claudoist.app` 拖进「应用程序」。
3. **首次启动**:构建未经 Apple 签名/公证,Gatekeeper 会拦。两种放行方式任选:
   - 右键点击 app → 打开 → 再点「打开」(有时要来两次);或
   - 终端执行 `xattr -dr com.apple.quarantine /Applications/Claudoist.app`
4. 启动后右栏 agent 面板应显示你的 Claude 账号;数据存放在 `~/Library/Application Support/Claudoist/`(源码仓库与应用包不含任何用户数据)。

**Google 日历(可选):** 私人应用不能内置开发者凭据,需要一次性自备 OAuth client:Google Cloud Console → 新建项目 → 启用 Google Calendar API → OAuth client(类型 Desktop app)→ 下载凭据 JSON → 应用内 Settings · Calendars 导入。凭据用 Electron safeStorage 加密落盘,永不入库、永不进渲染进程;向 Google **写入**(推送任务到专用日历)默认关闭、需显式开启,写入范围仅 `calendar.app.created`。

---

## 从源码构建

前置:macOS,Node ≥ 22.5(`node:sqlite` 需要;建议 23+),corepack(pnpm 版本由 `packageManager` 字段钉死)。

```bash
git clone https://github.com/Wind-2375-like/claudoist.git
cd claudoist
corepack enable
pnpm install
pnpm dist          # 构建未签名 dmg + zip → apps/desktop/release/
# Intel 机器:pnpm --filter @gtd/desktop exec electron-builder --mac --x64
```

装好后同样按上面的 Gatekeeper 放行步骤打开。

**签名 + 公证版(维护者,可选):** 需要钥匙串里的 Developer ID Application 证书与 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 环境变量,然后 `pnpm --filter @gtd/desktop dist:signed`(配置在 `apps/desktop/electron-builder.signed.yml`,凭据永不入库)。签名公证后的 dmg 用户可直接双击打开,无需放行步骤。

---

## 发布新版本(维护者)

```bash
# 1. 升版本号(apps/desktop/package.json 的 version)
# 2. 打包
pnpm dist
# 3. 建 GitHub Release 并附上产物(需 gh CLI:brew install gh && gh auth login)
git push origin main
gh release create v0.1.0 \
  apps/desktop/release/Claudoist-0.1.0-arm64.dmg \
  apps/desktop/release/Claudoist-0.1.0-arm64-mac.zip \
  --title "Claudoist 0.1.0" --notes "改动见 docs/ROADMAP.md 变更记录"
```

`apps/desktop/release/` 已在 .gitignore,产物只进 Release 不进 git。图标改动后用 `pnpm --filter @gtd/desktop icon:build` 从 `build/icon.svg` 重新生成 icns。

---

## 文档

| 文档                                     | 内容                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [docs/DESIGN.md](docs/DESIGN.md)         | 架构设计:技术选型、monorepo 结构、进程模型与 IPC、数据模型、Agent 集成(MCP 工具面、权限矩阵、审计、回滚)、视图规格、外观系统、打包 |
| [docs/INVARIANTS.md](docs/INVARIANTS.md) | GTD 业务规则**唯一权威**:实体语义、编号不变量(INV-xx)、决策表(D-xx)、流程规格、与原 CLI 的有意差异、禁止复刻的 bug                 |
| [docs/ROADMAP.md](docs/ROADMAP.md)       | 里程碑(M0–M11)、验收标准、协作流程、决策日志、变更记录                                                                             |

## 技术栈

Electron + electron-vite + electron-builder · React 19 + Tailwind 4 · pnpm workspaces(`@gtd/domain` 纯 TS 领域核心 / `@gtd/storage-sqlite` / `@gtd/agent-tools` / `apps/desktop`)· `node:sqlite`(零原生依赖,手写 SQL + user_version 迁移)· [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)(main 进程,in-process MCP server)

## 开发

```bash
pnpm install        # 依赖(pnpm 版本由 packageManager 字段钉死,corepack 自动管理)
pnpm dev            # 启动开发窗口(数据在 "~/Library/Application Support/Claudoist-dev/")
pnpm lint           # ESLint(含依赖方向检查)+ Prettier
pnpm typecheck      # 全部包 tsc --noEmit
pnpm test           # Vitest
pnpm dist           # 构建并打包未签名 dmg(apps/desktop/release/)
```

> 注意:在由 VSCode 扩展派生的终端里,环境可能泄漏 `ELECTRON_RUN_AS_NODE=1`,导致 Electron 以纯 Node 模式启动而报 `Cannot read properties of undefined (reading 'isPackaged')`,**打包版同样中招**(表现为静默退不出窗口)。普通终端无此问题;必要时用 `env -u ELECTRON_RUN_AS_NODE …`。

开发数据(`Claudoist-dev/`)与安装版数据(`Claudoist/`)相互独立。要把 dev 数据带进安装版:退出两边应用后整体拷贝 `data/` 目录(`gtd.sqlite3` 连同 `-wal`、`-shm` 一个都不能少 —— WAL 模式下漏拷会拿到旧数据)。

## CLI

与 App 操作同一数据库(设计见 docs/DESIGN.md §6.7);CLI 写入后开着的 App 自动刷新。主要供 Claude Code 经 Bash 操作任务,人工使用亦可:

```bash
pnpm --silent cli help                                  # 全部命令
pnpm --silent cli capture "一个想法" "另一个想法"          # 零判断捕捉进 Inbox
pnpm --silent cli add 写周报 --date=today --deadline=tomorrow --priority=5
pnpm --silent cli add 写周会纪要 --date=today --repeat=weekly:wed --repeat-until=2026-12-31
pnpm --silent cli add "写 release notes" --parent=<任务>  # 建子任务(≤5 层,继承父的位置)
pnpm --silent cli comment <任务> "记得配截图"             # 评论;show 显示子任务树+评论
pnpm --silent cli list inbox --json                     # JSON 输出(含 id)
pnpm --silent cli move <id前缀|标题> someday             # 也可挪到项目(名称/id;子树随动)
pnpm --silent cli complete <id前缀|标题>                 # 循环任务自动生成下一次并回显日期
pnpm --silent cli filter "recurring & done"             # 过滤器查询语言(INV-33)
pnpm --silent cli projects                              # 平面项目 + 进度条
```

DB 定位:`CLAUDOIST_DB` 环境变量 > `--db=` > `--prod`/`--dev` > 自动(dev 库存在且 prod 库不存在则用 dev)。

## 原则

- 源码仓库不含任何用户数据与凭据;运行数据全部在系统 userData 目录(dev 环境自动使用 `-dev` 后缀目录),Google OAuth token 与 API key 经 safeStorage 加密、永不进 SQLite、永不进渲染进程。
- 业务规则先写文档、再写测试、后写实现;`@gtd/domain` 对 INVARIANTS.md 的每条不变量有同名测试。
- agent 与 UI 共用同一批 use-case;一切级联操作必须征询用户,绝不自动连锁;agent 的每次写入记逆命令日志,可整轮回滚。

本项目的前身是一个单文件 Python GTD CLI,其全部行为已固化进 INVARIANTS.md。

## 许可与免责声明

**本项目绝大部分代码由 [Claude Code](https://claude.com/claude-code) 编写**(人类负责提需求、做裁决、试用验收),按里程碑流程逐步开发,过程与决策记录在 [docs/ROADMAP.md](docs/ROADMAP.md)。

本仓库内所有代码的授权方式为 [The Unlicense](LICENSE)(公有领域)。但是,**我不对本仓库内代码的正确性负责**。

**非官方、非商业**:这是一个个人业余项目,不销售、不收费、不提供任何形式的商业服务,与 Anthropic 和 Doist(Todoist)均**无关联、未获授权或背书**。"Claude" 名称与标志是 Anthropic 的商标,本项目仅在描述兼容性时使用("内嵌 Claude agent"= 通过官方 [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 调用你自己的 Claude 订阅或 API key);"Todoist 风格"仅指交互范式的致敬。使用本应用产生的 Claude 用量计入你自己的订阅/账单,与本项目无关。
