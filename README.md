# dsh-plugin-update-check

[![npm version](https://img.shields.io/npm/v/@ab-png123/dsh-plugin-update-check.svg)](https://www.npmjs.com/package/@ab-png123/dsh-plugin-update-check)
[![license](https://img.shields.io/npm/l/@ab-png123/dsh-plugin-update-check.svg)](./LICENSE)

DeepSeek Harness（DSH）启动后自动检查当前 profile 里已安装的插件是否有新版本；有更新时弹系统通知、写 Dock 角标，并生成一份可读报告。

> A DeepSeek Harness bundle plugin that checks installed plugins for updates on startup and notifies you via native notification, Dock badge, and a Markdown report.

npm 包名：`@ab-png123/dsh-plugin-update-check`（仓库名保持不变）。

## 功能

- 启动后 8 秒做第一次检查（避开 DSH 自身启动高峰），之后每 6 小时复查一次，应用一直开着也不会漏。
- 每次启动后的第一次检查**一定提示**；应用运行期间的复查对同一组更新在 24 小时内只再提示一次。
- 支持 npm 包和 `github:owner/repo` 依赖；本地 `file:` 包会标注为「跳过」。
- 报告写到 `~/.dsh/plugin-update-check/report.md`，同时维护 `status.json`、`state.json` 与 `run.log`。
- 纯启动钩子，不依赖其他 DSH 服务；检查失败只记日志，不影响 DSH 启动。

## 环境要求

- DSH `>= 0.2.0-rc.1`（已在 `0.2.1-rc.3` 上实测）
- Node.js `>= 20`（DSH 自带运行时，无需单独安装）
- macOS / Linux / Windows；系统通知与 Dock 角标能力因平台而异

## 安装（npm）

```bash
cd ~/.dsh/profiles/desktop
dsh plugin --profile desktop add @ab-png123/dsh-plugin-update-check
```

装完**重启 DSH** 才会加载。包内声明了 `dsh.bundle`，DSH 会自动把它加入 `dsh.profile.bundles`。

如果你的 profile 不叫 `desktop`，把命令里的 `desktop` 换成实际名称（例如 `web`）。

升级到最新版：

```bash
cd ~/.dsh/profiles/desktop
dsh plugin --profile desktop add @ab-png123/dsh-plugin-update-check@latest
```

升级后同样需要重启 DSH。

卸载：

```bash
cd ~/.dsh/profiles/desktop
dsh plugin --profile desktop remove @ab-png123/dsh-plugin-update-check
```

## 手动检查

不重启 DSH 也能手动跑一次检查：

```bash
node ~/.dsh/profiles/desktop/node_modules/@ab-png123/dsh-plugin-update-check/lib/check.mjs
```

可选参数：

| 参数 | 作用 |
| --- | --- |
| `--json` | 输出完整结果 JSON |
| `--no-notify` | 只写报告，不弹提示 |
| `--no-badge` | 不写 Dock 角标 |
| `--force-notify` | 忽略提示冷却，强制提示 |
| `--profile <dir>` | 指定要检查的 profile 目录 |

## 配置

可选文件 `~/.dsh/plugin-update-check/config.json`（不存在时全部使用默认值）：

```json
{
  "firstDelayMs": 8000,
  "intervalHours": 6,
  "prompt": "notification",
  "notify": true,
  "notifyCooldownHours": 24,
  "badge": true
}
```

| 字段 | 说明 |
| --- | --- |
| `firstDelayMs` | 启动后延迟多少毫秒做第一次检查 |
| `intervalHours` | 复查间隔（小时）；设为 `0` 表示只在启动时检查一次 |
| `prompt` | `notification` 系统通知（默认）／`dialog` 原生弹窗／`none` 不提示 |
| `notify` | 设为 `false` 时只写报告、不提示 |
| `notifyCooldownHours` | 应用运行期间复查的提示冷却时间；启动检查不受此限制 |
| `badge` | 是否把可更新数量写到 Dock 角标（需要 Electron `app` 对象） |

临时关闭：启动 DSH 时设置环境变量 `DSH_PLUGIN_UPDATE_CHECK_DISABLE=1`。

## 检查规则

- **npm**：读取 `node_modules/<包>/package.json` 的版本，与 registry 的 `dist-tags.latest` 比较；本地是预发布版本时会额外查询全量 `versions`，避免错过新的 rc。
- **github**：从 `pnpm-lock.yaml` 读出安装时锁定的 commit，与 GitHub API 上默认分支（或 `#ref` 指定分支）的最新 commit 比较。`github:...#<40 位 sha>` 或 `#v1.2.3` 这类固定引用视为「已固定」，不提示。
- **本地包**（`file:`）：没有远端版本可比，报告中标注「跳过」。
- 私有/已下架的 npm 包、GitHub API 限流、网络超时都会记入报告的「无法检查」，不影响其他插件。

## 通知与报告

- 通知优先走 Electron 原生 `Notification`（通知中心显示为 DeepSeek Harness）；拿不到 Electron API 时在 macOS 上退回 `osascript`。
- Dock 角标只在能拿到 Electron `app` 对象时生效，否则跳过。
- 如果系统关闭了 DeepSeek Harness 的通知权限，提示仍会体现在 Dock 角标（可用时）和报告中。
- 数据目录：`~/.dsh/plugin-update-check/`

| 文件 | 内容 |
| --- | --- |
| `report.md` | 人类可读的检查报告 |
| `status.json` | 最近一次检查的结构化结果 |
| `state.json` | 提示冷却/去重状态 |
| `run.log` | 运行日志 |

## 限制

- 只检查 profile `dependencies` 里的插件；插件市场里没装进 profile 的插件不在范围内。
- GitHub 未登录 API 每小时 60 次；两个 github 依赖每次检查约用 3～4 次。
- 升级命令由报告给出（`dsh plugin add <包>@<版本>`）；升级后仍需重启 DSH 才会加载新版本。

## 开发

```bash
git clone https://github.com/AB-png123/dsh-plugin-update-check.git
cd dsh-plugin-update-check

# 语法检查
node --check lib/check.mjs
node --check lib/index.js

# 本地跑一次检查（不提示）
node lib/check.mjs --no-notify --json

# 打包后安装到本地 profile
npm pack
cd ~/.dsh/profiles/desktop
dsh plugin --profile desktop add /path/to/ab-png123-dsh-plugin-update-check-0.1.4.tgz
```

## License

[MIT](./LICENSE) © 2026 AB-png123
