# CYRVIS 进度

## 2026-11-16
- [x] GUI Agent Action Batching：`GUIAgent` 已支持同轮执行多个 `parsedPredictions`；给 `DOUBAO_1_5_15B` 提示词加入受限多动作规则（2–4 个、空行分隔、仅限可预测序列）。
- [x] 增加 `[GUIAgent] action batch {count, types}` 日志与批内 200ms 动作间隔。
- [x] 无执行探针验证：安全序列“输入后回车”返回 2 条动作；打开命令面板的序列仍只返回 1 条。
- [x] 端到端验证：日志确认单轮执行 `type` + `hotkey(enter)`，总循环 3 次（逐条约 4 次）；但目标窗口焦点错误，文本未落盘，模型误报完成。
- [x] 收紧提示词：click+type 仅在截图中已见文本光标时允许；`finished` 前必须核对最新截图。
- [x] parser 26/26 测试通过；新增 SDK 单测“一次响应 2 个动作只截 1 次图”，GUIAgent 5/5 通过；App main typecheck 通过；SDK 已重新构建。
- [x] 干净复测通过：记事本已聚焦、光标在末尾、不点击；模型一轮返回 `type` + `hotkey(enter)`，总 `loopCnt=2`，截图确认 `PRE batch test`、光标到第 2 行第 1 列。任务未要求保存，文件标题仍带 `*`。
- [x] 制定 GUI 加速实验方案 `doc/gui-acceleration-plan.md`：第一批只跑 4 个任务——L1 记事本（批量友好）、L4 本地搜索→新标签→详情（状态依赖）、L5 跨应用读码→保存（跨窗口）、R1 携程上海→巴黎机票（真实长任务）。L2/L3/L6/L7/R2/R3 进候选池。按分组汇报，避免只用 batch-friendly 任务。MCP/直连本轮不做。
- [ ] 可选下一步：把 `loopIntervalInMs` 1000→300 做对比；或增加“输入后保存文件”的任务验证带对话框的批量边界。
- [x] 开始 ShowUI-2B 接入：模型下载到 `D:\Desktop\project\CYRVIS\models\ShowUI-2B`，Python 环境 `D:\Desktop\project\CYRVIS\showui-env`；侧车 `scripts/cyrvis/showui-server/app.py`、`run-showui.ps1`、映射 README 已写。
- [x] Benchmark harness 初版：`scripts/cyrvis/bench/`（本地站点 server、L1/L4/L5/R1 setup、CDP run-task、README）。
- [x] 基线 B0（Seed 2.1 Lite，每任务 1 次）：L1 成功 6 轮/48.6s/0 批量；L4 成功 11 轮/104.5s/1 次批量（type+Enter）；L5 成功 4 轮/29.4s/0 批量；R1 携程超时失败 27 轮/300s/20.5 万 tokens（卡在目的地下拉/日期选择）。结果记录在 `doc/benchmark-results.md`。
- [x] CUDA PyTorch 2.11.0+cu128 在 RTX 5060 上验证可用（`torch.cuda.is_available()=True`）；ShowUI-2B 下载完成（约 4.2GB）。
- [x] ShowUI-2B 侧车跑通：BF16 占用 4.12GB，2.3–3.4s/步，1MP 输入；L4 网页任务成功 5 轮/35.4s（Seed 11 轮/104.5s）；L1/L5 桌面任务失败，原因是动作空间没有 `hotkey`/`Ctrl+S`/跨应用能力，模型卡在 `SCROLL`。
- [x] 修复侧车坐标异常：`1<v<=100` 按百分比归一化（45→0.45），>100 按像素；修复后 L4 通过。侧车 keep-alive 改为 120s，待复测连接错误。
- [ ] 恢复 App 的 Ark 配置并重启；ShowUI 侧车保留为可选的网页任务后端。下一步评估“按任务类型路由”（浏览器→ShowUI，桌面→Seed）或给侧车加快捷键桥接。
- [x] 修复“暂停/取消”双回复与截断：控制事件不再触发主动播报；工具结果/主动播报在 `playbackBusy` 时排队，等渲染端真正播完再发；`ttsSpeaking` 保持到 `playback-idle`；渲染端不再在新响应开始时无条件 `stopPlayback()`；确定性控制与工具调用去重。57/57 测试通过。
- [x] 修复外放/耳机路由：去掉硬编码 `扬声器 (Realtek`；耳机模式显式选耳机设备，不再只用 `default`；外放模式动态找扬声器（优先模拟/HDMI，排除 Digital Output/ToDesk/耳机）；语音条新增输出设备下拉框；模式和设备持久化。当前机器只枚举到 Realtek 扬声器/NVIDIA/ToDesk，没有耳机输出（需把耳机作为输出设备连接）；默认已从错误的 Realtek Digital Output 改为 `扬声器 (Realtek High Definition Audio)`。
- [x] 解耦“输出设备”和“语音模式”：选择扬声器不再自动切语音模式；输出由下拉框独立控制。
- [x] 外放模式改为**语音打断**：播放期间保留麦克风能量检测，阈值 2000 / 180ms（`CYRVIS_SPEAKER_BARGE_THRESHOLD` 可覆盖），600ms 预录回灌，播放后仅 100ms 尾音保护；`Ctrl+Alt+X` 继续兜底。外放不再半双工丢麦。57/57 测试通过，node/web typecheck 通过。
- [ ] 真机复测外放打断：需要入耳麦连接；观察 `[cyrvis capture] level { playing: true, avg/peak }` 与 `barge-in { mode: 'speaker', threshold: 2000 }`；若外放串音误触发，调高阈值。
- [x] 两种模式自动化：**耳机模式** = 蓝牙耳机麦 + 蓝牙耳机输出；**外放模式** = 蓝牙耳机麦 + 主机 Realtek 扬声器。模式按钮现在自动切 Windows 默认端点（`scripts/cyrvis/audio/set-default-output.ps1`，PolicyConfig）、切 App `<audio>.setSinkId`、重启采集但保持耳机麦。实测双向：耳机→默认/输出 Bluetooth，外放→默认/输出 Realtek。
- [x] 修复“说不出话”根因：13:52 语音处于 sleep，ASR 把“哈喽，塞维斯”转成文本但旧唤醒词不匹配（缺“哈喽/塞维斯/Zawis”），回复文本生成了但 `awake=false` 导致音频被丢弃。已补唤醒词变体、睡眠时输出 `asleep; transcript ignored` 日志；当前 `awake=true`。
- [x] 修复外放“我一直我在”自听循环：日志显示外放时麦克风串音 3933–13183，远高于阈值 2000；barge-in 把助手自己的“我在”送进 ASR，模型自问自答。已加自听转写过滤（“我在/我来/我”等直接丢弃）、每次回复 600ms 串音探测（>1500 自动禁用本次语音打断，`Ctrl+Alt+X` 仍可用），并补单测；58/58 通过。
- [x] **Qwen 语音切到 Token Plan**：新 `sk-sp-…` Key 在公共 DashScope 返回 401；Token Plan host 为 `token-plan.maas.qianwenaiapi.com`，模型列表含 `qwen-audio-3.0-realtime-plus`（无 flash）。Realtime WS `wss://token-plan.maas.qianwenaiapi.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus` 用 App 兼容 `session.update` 实测 `session.updated` 成功；`.env` 已设 `QWEN_MODEL/QWEN_VOICE/QWEN_REALTIME_URL`，App 重启后日志 `qwen session ready`、`qwen connected`、`wake`。
- [x] 蓝牙耳机 `cc ultimate` 已重新连接，采集 `ready`；App 当前外放模式（耳机麦 + Realtek 扬声器）。
- [x] 修复外放“只回 Hello 就断”：旧串音探测从 `response.created` 起算 600ms，但首段音频约 800ms 后才到，测到的是静音；播放后串音 11158 误触发 barge，取消回复。现改为**首段音频开始测 1200ms**，同时看平均/峰值；检测到串音或自听则 60 秒内关闭外放语音打断。实测：`high speaker leakage { avg: 1060, max: 4488 }` 后无 `barge-in`，回复完整播完；日志 0 次误 barge。
- [x] 修复 Token Plan plus 的 **30 秒输入缓冲上限**：空闲噪声持续 append 但不 commit，服务端报 `Input audio buffer exceeded maximum duration (30s)` 并刷屏。已加每 15 秒空闲 `input_audio_buffer.clear`，服务端 `error` 时关闭旧连接并重连。实测 3 次 trim、0 次 30 秒错误。
- [ ] 测试音频 `hello-cyrvis.wav` 实际内容是 “Hello service, open Notepad and type hello”，复测时误触发了一个记事本任务（已结束）；后续自动化测试改用纯唤醒词 WAV。
- [x] 修复冷却期“完全打断不了”：原来 `speakerBargeSuppressed` 直接 return 60 秒；改为自适应门槛（500ms 能量窗口中位数×3，冷却期最低 2500）。外放朗读时句子间说“停”仍可打断，`Ctrl+Alt+X`/界面 Interrupt 继续兜底。
- [ ] **蓝牙耳机再次断开**：20:45:24 采集 ready，约 20:45:30 后 `cc ultimate` 从 Windows 消失，采集重试 3 次后停止；需重新连接耳机后复测“朗读中说话打断”。
- [x] 21:00 复测发现模式按钮歧义：旧按钮显示当前模式，点一下切到另一个；用户实际在耳机模式（日志 `mode: 'headset'`），21:01:01 的 `barge-in avg=3875` 证明耳机模式语音打断有效。已改为“耳机 / 外放”两个并列按钮；已通过 IPC 切到外放并确认采集 ready。
- [x] 明确外放物理上限：串音 3933–13183 > 用户人声 3000–4500，助手大声说话时纯阈值无法可靠区分；自适应门槛只能利用句子停顿打断。要“随时打断”需 AEC 或指向性/带杆麦克风。
- [ ] 重启 App 后让用户复测：暂停/取消语音是否只播一遍且完整；选择外放/耳机设备后是否路由正确；外放模式下“语音打断”是否仍按半双工策略工作。

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

## PR #1 合并（本地集成分支）
- [x] 备份本地修改：`backup/local-voice-fixes-20261116`，patch `D:/temp/cyrvis-local-voice-fixes.patch`。
- [x] 在 `merge/pr-1` 上合并组员 PR #1（reference-aware echo gating + 浮动语音工作区 + 记忆）；保留 Token Plan 端点、15 秒输入缓冲清理、断线重连、耳机/外放显式按钮。
- [x] 验证：node/web typecheck 通过；CYRVIS + shared 测试 75/75；wav-player/widgetOverlay/store 测试 9/9；`UI_TARS_APP_PRIVATE_KEY_BASE64=dummy pnpm --filter ui-tars-desktop build:dist` 通过。
- [ ] 真机外放打断复测：合并后启动 App，切到外放时蓝牙耳机 `cc ultimate` 从 Windows 消失（只剩 ToDesk 虚拟麦），采集重试 3 次后停止；需重新连接耳机后测试，通过后再 push main。
- [x] 修复合并后“耳机/外放都打断不了”：播放参考 PCM 之前是在 `audio.play()` 返回后按 `currentTime` 截取，实际只剩 206–4258 字节，主进程经常 `ref: 0` 并 fail-closed。改为**播放前发送完整 0.75s 参考**，只有暂停恢复才发送剩余段；实测参考恢复为 36000 字节。
- [x] 外放串音相关性实测 0.69–0.76，原 `likelyEcho >= 0.72` 让大量片段落入 ambiguous，反复暂停 700ms 做无效探针；阈值调整为 0.65。
- [x] 合成“停”音频从 Realtek 播放并注入麦克风：日志 `direct interrupt detected { avg: 7490, corr: 0.147 }` → `barge-in`，外放打断链路验证通过。
- [x] 修复 barge 后误重连：cancel 竞态的服务端 error 被当成致命错误，导致每次打断后 `sleep`/重连；现只对 `input buffer exceeded`/session 失效重连，其他 error 仅记录。
- [x] 重连后重新触发 `onReady` 并 `wake`，修复“耳机模式转写了但 asleep 忽略、无声音”。
- [ ] 蓝牙耳机在多次重启/切模式后又从 Windows 消失，当前采集无法启动；重新连接后再做一次真人“停”复测。
- [x] 减少蓝牙麦掉线：外放模式不再把 Windows 三个默认角色全部切到 Realtek；roles 0/1（普通/多媒体）切扬声器，role 2（通信）保留在 `cc ultimate` 耳机，避免 Windows 拆掉 HFP 麦克风。脚本实测外放 target=Realtek、role 0/1 hr=0；耳机存在时应额外输出 `role=2 (comm/headset)`。
- [x] 修复“喊停后停一下又继续”：日志显示 barge 成功后模型又生成“好的，已暂停当前任务”并播放。新增 bare stop 抑制：识别“停/停止/暂停/别说了”等短指令后取消当前响应，并在 2 秒内不再播放模型确认语；新增单测（19/19）。
- [x] 探针时序从 220ms decay + 140ms confirm 改为 80ms + 100ms，避免 200–300ms 的“停”被全部丢弃；外放探针现在能确认更短的口令。
- [x] 修复 barge 后长语音丢失：日志显示 22:34:38 barge 成功后只捕获 200ms 就 commit，随后 22:34:39–42 用户继续说的长段（avg 1859/7087/4143）因 `awaitingResponse` 半双工被丢弃，22:35:01 只转写出 “Ok.”。已加 post-barge 静音窗口 1600ms，给用户继续说完的机会，避免 800ms 就把短停顿当成本轮结束。
- [ ] 模型质量：Token Plan 只有 `qwen-audio-3.0-realtime-plus`；`qwen3.8-omni-flash-realtime` 在 Token Plan 返回 `Model not exist`。当前 ASR 误识别明显（Hello CYRVIS → Hello service，长段 → Ok.），要回到 qwen3.8 需要公共 DashScope 的付费/额度 Key。
- [x] ASR 模型对比（Token Plan，同一段 3.8s 测试音频）：`fun-asr` 与 `qwen3-asr-flash-realtime` 转写完全一致：“Hello service，请给我背诵一首长诗。”；说明 “Hello CYRVIS → Hello service” 是声学/发音问题，不是 ASR 模型选择问题。Token Plan 无 `qwen3.8-omni-flash-realtime`（返回 Model not exist），只有 `qwen-audio-3.0-realtime-plus`；要回到 qwen3.8 需要公共 DashScope 付费/额度 Key。
- [x] 长语音被 8 秒硬切：`trackLocalVad` 在连续说话 8s 时强制 commit，随后 `awaitingResponse` 丢掉后半段；改为 25s 安全阈值，正常由 800ms（barge 后 1600ms）静音端点决定。
- [x] 外放误打断：speaker 模式探针恢复 220ms decay / 140ms confirm，避免把扬声器混响尾音确认成人声；headset 模式仍用 80/100ms 以识别短“停”。
- [x] “停一下”未匹配：bare-stop 正则补充 `停一下/停一停/先停/先停一下`。
- [x] 任何确认的 barge 都调用 `markUserStop()`：取消当前响应并静音模型 2 秒，不再依赖 ASR 一定听清“停”；ASR 返回空/误识别也不会再生成“好的，请问…”的确认语。
