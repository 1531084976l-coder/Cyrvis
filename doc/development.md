# CYRVIS 开发与运行指南

## 1. 环境

| 项 | 本项目验证值 |
|---|---|
| OS | Windows 11 Pro 26200 |
| Node | v24.15.0 |
| pnpm | 9.10.0 |
| GPU | RTX 5060（GUI VLM 走云端，不依赖本地 GPU） |
| 浏览器 | Chrome / Edge（Browser Operator 用系统 Chrome） |

## 2. 安装

```bash
git clone <your-fork-url> UI-TARS-desktop
cd UI-TARS-desktop
PUPPETEER_SKIP_DOWNLOAD=1 pnpm install
```

- `PUPPETEER_SKIP_DOWNLOAD=1` 避免下载 170MB 自带 Chrome；Browser Operator 使用系统 Chrome。
- 国内网络如需代理，GitHub 可用 `gh-proxy.com`；注意 `origin` 若写成代理地址，push 前要改回真实地址。
- 依赖安装后运行 `pnpm --filter ui-tars typecheck` 确认环境。

## 3. 密钥与配置（不要提交）

### 3.1 语音（Qwen Realtime）

复制 `apps/ui-tars/.env.example` → `apps/ui-tars/.env`，填写：

```env
QWEN_API_KEY=...
QWEN_WORKSPACE_ID=
QWEN_MODEL=qwen3.8-omni-flash-realtime
# 可选：dev 专用 test-audio IPC 使用的本地 WAV
CYRVIS_TEST_WAV=
```

`.env` 已被 `.gitignore` 忽略；不要提交、不要贴到文档/Issue。

### 3.2 GUI VLM（火山方舟）

VLM 配置优先存于 electron-store：

`%APPDATA%\ui-tars-desktop\ui_tars.setting.json`

也可用环境变量覆盖默认值：`VLM_API_KEY`、`VLM_BASE_URL`、`VLM_MODEL_NAME`、`VLM_PROVIDER`。

**注意接口类型**：

| Key 类型 | Base URL | 模型 ID 示例 |
|---|---|---|
| 普通按量 | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-2-1-lite-260915` |
| Coding/Agent Plan | `https://ark.cn-beijing.volces.com/api/plan/v3` | `doubao-seed-2.1-lite` |
| Plan Responses | `https://ark.cn-beijing.volces.com/api/plan` | - |

用错 Base URL 会得到 401 `API key ... invalid`；账户欠费会得到 403 `overdue balance`。

## 4. 启动

```bash
pnpm run dev:ui-tars
```

或双击 `scripts/cyrvis/start-dev.cmd`（Windows；从仓库根启动）。

首次启动需要：

- 允许麦克风权限；
- 在设置页选择 GUI VLM Provider/模型/Key（或使用环境变量）；
- 确认 Windows 默认输入是物理麦克风（应用会拒绝 ToDesk 虚拟麦）。

## 5. 测试

```bash
# 类型检查（node + web）
pnpm --filter ui-tars typecheck

# CYRVIS 单测（Controller / VoiceBrain / IntentGate / Proactivity）
pnpm --filter ui-tars exec vitest run src/main/cyrvis

# 全量单测（可选）
pnpm test
```

基线：57 个 CYRVIS 单测通过（2026-11-15）。

## 6. 日志

| 日志 | 位置 |
|---|---|
| 应用主日志 | `%APPDATA%\ui-tars-desktop\logs\main.log` |
| dev 启动输出 | 启动命令重定向的 `dev-ui-tars.log`（不要提交） |
| 语音关键行 | `[cyrvis voice]`、`[cyrvis capture]`、`[cyrvis provider]` |
| GUI 关键行 | `runAgent`、`[GUIAgent]`、`[UITarsModel]` |

常见排查顺序：

1. `[cyrvis capture] ready/error`：有没有物理麦克风；
2. `transcript`：ASR 是否听到；
3. `tool call start_gui_task`：VoiceBrain 是否发起任务；
4. `runAgent` / `[GUIAgent]`：Controller 是否真正启动；
5. `[UITarsModel] error`：VLM 鉴权/欠费/模型 ID/Base URL。

## 7. 语音双模式

| 模式 | 输出 | 语音打断 | 备注 |
|---|---|---|---|
| 耳机 | AirPods/默认耳机 | ✅ | 隐藏采集窗口 + 主进程打断检测 |
| 外放 | 扬声器 | ❌（半双工） | 防自问自答；用 `Ctrl+Alt+X` |

细节见 [voice-architecture.md](./voice-architecture.md)。

## 8. 常见故障

| 现象 | 原因/处理 |
|---|---|
| `No physical microphone found` | 只枚举到 ToDesk 虚拟麦；连接物理麦，应用会自动重启采集 |
| AirPods 断连 | Windows 蓝牙省电；重连后 `devicechange` 自动恢复；演示建议 USB 麦 |
| 外放一直“你好” | 扬声器回声被麦克风收进去；使用外放模式（半双工），不要开语音打断 |
| 说“停”没反应 | 检查当前是否外放模式；耳机模式才支持语音打断；快捷键 `Ctrl+Alt+X` 始终可用 |
| GUI 任务不执行 | 看日志是 `REJECTED`（IntentGate）还是 `UITarsModel` 鉴权错误；创建/新建/写入已加入任务动词 |
| VLM 401 | Key 类型与 Base URL 不匹配（Plan vs 普通） |
| VLM 403 | Ark 账户欠费，充值或换 Key |
| 应用多开/多声音 | 单实例锁；若仍多开，检查残留 Electron 进程 |

## 9. 提交前检查

1. `git status` 不包含 `.env`、`*.log`、`*.wav`、`.tmp-*`、`node_modules`、`dist`、`out`；
2. `git grep -nE 'ark-[0-9a-f]{8}-|sk-ws-|sk-[A-Za-z0-9]{20,}'` 无结果（或都是示例占位符）；
3. 文档中没有真实 Key、Cookie、个人路径；
4. `pnpm --filter ui-tars typecheck` 与 CYRVIS 单测通过；
5. 不在默认分支直接开发，按 `roadmap.md` 的 `feat/*` 分支协作。

### GitHub 上传范围

- **只上传 `UI-TARS-desktop/` 这个 git 仓库**；仓库根是 `package.json`/`apps/`/`doc/`。
- 不要上传父目录 `CYRVIS/` 的 `dev-ui-tars.log`、`pnpm-install.log`、`.tmp-research/`、`Start-CYRVIS.cmd`（本地启动器）——日志里可能含模型配置/Key。
- `apps/ui-tars/.env` 与 `%APPDATA%\ui-tars-desktop\ui_tars.setting.json` 都在仓库外/已忽略，**永远不要**复制进仓库。
- `origin` 目前是 `gh-proxy.com` 代理地址；push 前改为真实 GitHub 地址（或使用可写的代理），例如：
  ```bash
  git remote set-url origin https://github.com/<your-account>/UI-TARS-desktop.git
  git remote -v
  ```
- 组员从同一仓库 fork/clone，按 `feat/*` 分支开发；文档与模块边界见 `roadmap.md`。
