# CYRVIS 进度

## 2026-11-15
- [x] 仓库整理：CYRVIS 文档迁入 `doc/`，新增 `README.cyrvis.md`、`doc/README.md`、`doc/roadmap.md`、`doc/development.md`；原始产品愿景归档到 `doc/archive/product-vision-v1.md`。
- [x] 首次提交 `641da6d8` 已推送到 GitHub `main`（SSH）；GitHub 仓库改名 `CYRVIS` 待网页操作/重定向。
- [x] 清理：`mp3-player.ts` → `wav-player.ts`；删除未使用的 lamejs/lame-encoder/raw 类型与依赖；移除本地绝对路径；新增 `.env.example`、`scripts/cyrvis/start-dev.cmd`；`.gitignore` 补齐 secrets/logs/artifacts。
- [x] 修复“多个 AI 同时说话/首中尾错位”：渲染端播放队列只允许在 underrun 时追平，禁止把领先 >2s 的队列重置到当前时间；用户确认“现在连贯”。
- [x] 实现自然打断（barge-in）：助手播报时渲染端仍监听麦克风，连续 250ms 能量超过阈值即停止播放、取消 Qwen 响应、回灌最近 600ms 缓冲语音，用户无需按键。
- [x] 打断链路加固：取消后的 `response.audio.delta` 丢弃；canceled 的 `response.done` 不再重新静音麦克风；新增 `response-stopped` 广播。
- [x] 兜底打断：语音条在播报时显示 Interrupt 按钮；全局快捷键 `Ctrl+Alt+X`（主窗口隐藏时也生效）。
- [x] 改善“要喊几遍才理我”：本地 VAD 阈值 300→250，最短语音 600ms→300ms，端点静音 1200ms→800ms，播放结束后麦克风恢复等待 800ms→150ms。
- [x] 打断检测阈值与主 VAD 对齐：渲染端 1200→350（持续 300ms），避免耳机麦音量偏低时打断失效；取消标志窗口 1000ms→400ms，避免误杀打断后用户的新响应。
- [x] 修复工具调用后麦克风被关 10s：新增 `response-done` 广播，无音频的 tool-call 响应结束时立即开麦，用户可在 GUI 执行中说“停”。
- [x] 增加 “Thinking…” 状态：语音提交后立即显示，避免用户在等待首 token 时误以为没听到而重复说话。
- [x] 打断竞态加固：若 `response.created` 在取消之后才到，立即再次 `response.cancel`，不再播放迟到的响应。
- [x] `pnpm typecheck` 通过；CYRVIS 单测 55/55 通过。
- [x] 无人工语音的打断验证：播放中调用 barge-in，日志出现 `barge-in` → `canceled response done`，旧响应无后续音频；`Ctrl+Alt+X` 全局快捷键注册并触发成功。
- [ ] 真实麦克风验证：播报中直接说话打断、短促 “Hello” 一次唤醒。
- [x] 诊断出真实打断失败根因：播报时 `barge monitor avg=0 peak=0`，麦克风流在播放期间为纯静音，与阈值无关。
- [x] 修复尝试：关闭 AEC/NS、统一采集/播放采样率为设备原生、改用显式物理麦克风 endpoint（不再用 default/communications 别名）。
- [x] 输出切到 Realtek 扬声器后仍为 `avg=0`，排除输出端点冲突；判定为 USB 耳机/驱动层半双工静音。
- [x] 用户改用 AirPods；期间发现 AirPods 断开后应用回退到 ToDesk Virtual Audio，导致空白转写和自取消。
- [x] 已禁止虚拟麦克风回退：无物理麦克风直接报错；设备重新连接时自动切回物理麦克风。
- [x] AirPods 噪声底 260-486、人声 1700-4500：主 VAD 阈值 250→600，重新开启 noiseSuppression；渲染端打断阈值 400。
- [x] TTS 播放改为 `MediaStreamDestination` + `<audio>`；实测仍会归零，改为**普通 MP3 Blob 文件分段播放**（PCM→lamejs MP3→每 0.75s 一个 `<audio>`），绕开 WebAudio/MediaSource 的 AEC 参考。
- [x] 修复 lamejs 在 Vite 下的 `MPEGMode is not defined`：改用 `lame.all.js?raw` + `new Function`。
- [x] 增加 Electron `autoplay-policy=no-user-gesture-required`，保证 IPC 回调里创建的 `<audio>` 能播放。
- [x] 修复 CSP 缺少 `media-src blob:` 导致的 `NotSupportedError`；blob 音频可播放。
- [x] 最终改为 WAV Blob 分段播放；实测普通 WAV 播放期间麦克风可采到测试音，不再被归零。
- [x] 真实用户验证：TTS 分段播放是否有明显卡顿；播报中喊“停”能否触发打断。
- [x] 拆分采集/播放架构成功：隐藏采集窗口（只开麦）+ 主窗口播放；AirPods 重新连接后自动恢复采集。
- [x] 语音打断实测成功：`[cyrvis capture] barge-in { avg: 4110 }`、`{ avg: 4910 }`，转写“停呀。”，播放立即停止。
- [x] 播报期间采集电平 0-10（耳机不漏音），用户说话 3000-16726；阈值 1000/150ms 不会误触发。
- [x] 用户确认分段 WAV 播放无明显卡顿。
- [x] 产出 `doc/voice-architecture.md`，记录最终采集/播放/打断架构、阈值、文件与实测记录。
- [x] 临时输出切到 Realtek 扬声器（调试函数），供外放演示；用户要求后再恢复默认。
- [x] 双模式完成：语音条新增“耳机/外放”切换按钮；耳机模式保留语音打断，外放模式半双工 + 800ms 尾音保护。
- [x] 外放 AEC 实测失败：隐藏采集窗口开 AEC 后播放期间仍收到自外放（`barge-in avg=8640`），无主窗口播放参考；外放模式因此不启用语音打断。
- [ ] 若后续必须“外放 + 语音打断”，需要系统级 loopback 参考/软件 AEC，或独立指向性麦克风。
- [x] 记录“外放 + 语音打断”后续方案：换带杆游戏耳机麦克风，测串音/人声电平后决定阈值；必要时做 TTS 参考的软件 AEC。用户决定先搁置。
- [x] GUI Agent 不执行的根因：Ark/Doubao 返回 **403 overdue balance（账户欠费）**，不是代码问题；语音模型 Qwen 走 DashScope，仍可用。
- [ ] 用户提供新 VLM Key 后已写入 electron-store；Ark 实测返回 **401 AuthenticationError: API key format is incorrect**（新 Key 长度 45，旧 Key 46，疑似少一位/粘贴不完整），等待用户重新提供完整 Key 后再测。
- [x] 定位为 **Plan 接口 Base URL 问题**：新 Key 是 Plan Key，`/api/v3` 报 401，改用 `https://ark.cn-beijing.volces.com/api/plan/v3` 后对 `doubao-seed-2.1-lite` 返回 200。
- [x] 配置已更新：`vlmBaseUrl=https://ark.cn-beijing.volces.com/api/plan/v3`、`vlmModelName=doubao-seed-2.1-lite`；应用已重启，待验证 GUI 任务。
- [x] 修复“桌面创建 txt 未执行”：IntentGate 缺少 创建/新建/写入 等动词，VoiceBrain 把工具调用判为会话并 REJECTED；已补动词 + 用户原话 task 兜底，新增测试，57/57 通过。
- [ ] 任务暂停/取消的延迟：ASR 转写后 GUI 在飞请求最多需 2–3s 才 abort，后续可评估“打断即先暂停”。

## 2026-11-14
- [x] 阅读 `CYRVIS_Technical_Architecture.md`，确认项目目标与范围。
- [x] 克隆 fork 到 `CYRVIS/UI-TARS-desktop`（commit `3ac2cb8`）。
- [x] 安装 pnpm 9.10.0（Node v24.15.0，npm registry 已指向 npmmirror）。
- [x] `pnpm install` 完成（跳过 Puppeteer 自带 Chrome 下载，浏览器 Operator 使用系统 Chrome）。
- [x] `pnpm run dev:ui-tars` 启动成功，窗口标题 `UI-TARS Desktop`，renderer HTTP 200。
- [ ] 配置 GUI VLM，跑通 3 个固定任务。
  - 2026-11-14：用户尝试 Seed 2.1 Lite，模型名填 `doubao-seed-2-1-lite`，报 404；已定位为缺少日期版本后缀/未开通或需用 `ep-` 接入点。
  - 2026-11-14：用户反馈 `doubao-seed-2-1-lite-260915` 速度不错，确定先用它做实验。
- [x] 产出整体框架 `doc/architecture.md`。
- [x] 产出语音实现清单 `doc/archive/voice-implementation-v1.md`（历史；当前见 `doc/voice-architecture.md`）。
- [x] 产出早期语音方案 `doc/archive/voice-plan-v1.md`（历史，保留背景）。
- [x] Controller / ProactivityPolicy / ElectronGUIAdapter 实现完成，16 个单元测试通过，node typecheck 通过。
- [x] Qwen3.8-Omni-Flash-Realtime 端到端接通：通用 DashScope 端点即可用，无需 Workspace ID；ASR、TTS、Function Calling 均验证通过。
- [x] Controller/VoiceBrain/IntentGate/Proactivity/Qwen Provider/音频桥/widget 语音条完成，50 个单测通过，typecheck 通过。
- [x] 端到端测试（test mode + 合成 WAV）：唤醒词 → ASR → start_gui_task → GUI Agent → task_done → 主动播报“完成了”，全链路跑通。
- [x] 发现并修复 GUI Agent 不输出 `finished()` 的问题：Doubao 1.5 prompt 增加“必须输出 Action，完成时输出 finished()”；任务可正常结束。
- [x] 增加完成声明拦截：GUI 执行中语音模型若说“已打开/已完成”，会取消 TTS 并改说“正在执行，请稍等”。
- [ ] 真麦克风：Chromium 只看到 ToDesk Virtual Audio，未见 Realtek/Logitech 实体麦克风；需用户插好并在 Windows 声音设置选为默认输入。
- [ ] 主动播报节流已调到 15s；后续按真实体验再调。
- [ ] 语音 Key 已在本地 `.env`（gitignored）；演示后建议轮换。
- [ ] 记录成功配置与失败原因，形成 Go/No-Go 结论。

## 已知非阻塞问题
- 启动日志有 `TypeError: installExtension is not a function`（`electron-devtools-installer` 兼容问题），仅影响 DevTools 扩展安装，应用正常。
- `origin` 当前指向 `gh-proxy.com` 代理地址，`git push` 前需要改回真实 GitHub 或配置可用代理。

## 环境快照
| 项 | 值 |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| GPU | NVIDIA RTX 5060 |
| 显示器 | 单屏 2560×1440 |
| Node | v24.15.0 |
| pnpm | 9.10.0 |
| 浏览器 | Chrome、Edge 已安装 |
| GitHub 直连 | 不通，使用 gh-proxy.com 克隆 |
