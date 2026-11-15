# CYRVIS 调研发现

## 基座代码事实
| 位置 | 事实 |
|---|---|
| `apps/ui-tars/src/main/services/runAgent.ts` | 根据 settings 选择 Operator，构造 `GUIAgent`，`model` 来自 `vlmBaseUrl/vlmApiKey/vlmModelName` |
| `apps/ui-tars/src/main/ipcRoutes/agent.ts` | `GUIAgentManager` 持有单例；`stopRun` 执行 `abortController.abort()` + `guiAgent.stop()` |
| `packages/ui-tars/sdk/src/GUIAgent.ts` | 循环顶部检查 `signal.aborted` / `isStopped`；取消不会回滚已执行的点击，也不会打断正在执行的单步动作 |
| `apps/ui-tars/src/main/agent/operator.ts` | Windows `type` 走剪贴板粘贴；截图仅主显示器 |
| `apps/ui-tars/src/main/store/setting.ts` | 配置存 electron-store `ui_tars.setting`，也可用环境变量 `VLM_*` 初始化 |
| `apps/ui-tars/src/main/store/types.ts` | VLM Provider 仅 4 个枚举：HF UI-TARS-1.0/1.5、火山 Doubao-1.5-UI-TARS、Doubao-thinking-vision-pro |

## 结论
1. 必须配置兼容 UI-TARS 动作协议的 VLM，普通聊天模型不能直接用。
2. Remote Operator 免费服务已于 2025-08-20 停止，试跑只能用 Local Computer/Browser Operator + 自备模型。
3. 取消机制是“停止后续步骤”，不能宣称回滚已执行操作；CYRVIS 的取消验收按此标准。
4. 单显示器限制与当前环境一致（2560×1440 单屏），适合先做受控 Demo。
5. 安装时 Puppeteer 会从 Google 下载约 170MB Chrome，国内极慢；已用 `PUPPETEER_SKIP_DOWNLOAD=1` 跳过。Browser Operator 使用系统 Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`），不影响本地试跑。
6. 克隆走 `gh-proxy.com`，因此 `origin` 被写成代理 URL；只影响 push，不影响本地开发。
7. Electron 启动时 `installExtension` 报错来自 `electron-devtools-installer` 新版 API 不兼容，非阻塞。
8. 火山方舟模型 ID 有两套：普通按量 API 用日期版本 ID（如 `doubao-seed-2-1-lite-260915`）；Coding/Agent Plan 用点号 ID（如 `doubao-seed-2.1-lite`），两者不可混用。填 `doubao-seed-2-1-lite` 会报 404 `InvalidEndpointOrModel.NotFound`。
9. `checkModelAvailability` 只做一次 `chat.completions`（`return 1+1=?`），通过只证明接口可用，不证明模型能输出 UI-TARS 动作格式。
10. GUI 任务执行时主窗口会隐藏（`beforeAgentRun`），同时显示 400×400 widget 和屏幕水波纹；结束后恢复。widget 与预测标记都设置了 `setContentProtection(true)`，不会进入 VLM 截图；水波纹是 `false`，但只在屏幕边缘。
11. 语音 UI 应放在 widget 窗口，避免新开大窗口污染截图；widget 当前 `focusable:false`，需要加 `backgroundThrottling:false` 并处理麦克风权限。
12. 豆包实时语音 3.0（Seeduplex）支持全双工、动态判停、Function Calling/MCP，但截至 2026-11-14 仍是**邀测**，未见公开 GA 公告；需豆包语音控制台开通，独立于 Ark 模型 Key。公开目录价（第三方估算）音频输入约 ¥80/M、输出约 ¥300/M，成本高。
13. Qwen3.8-Omni-Flash-Realtime 在阿里云百炼**北京地域可自助开通**：模型 `qwen3.8-omni-flash-realtime`，1M 免费 tokens（90 天），音频输入 ¥6/M、输出 ¥12/M，text/image/video 输入 ¥1.5/M、输出 ¥4.5/M；支持 Function Calling/MCP、`server_vad`/`semantic_vad`/`semantic_vad_ec`，WebSocket 需业务空间专属域名 `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=...`，鉴权 `Authorization: Bearer <API_KEY>`，输入 16kHz PCM、输出默认 24kHz PCM。
14. Qwen-Omni 的 `conversation.item.create` 文档只列出 Function Calling 结果/MCP 审批，未列出任意文本消息；主动播报可能需要 `session.update.instructions` + `response.create`，或单独 TTS 兜底，需实测。
15. Controller/ProactivityPolicy/ElectronGUIAdapter/VoiceBrain/Qwen Provider/音频桥/widget 语音条已实现于 `apps/ui-tars/src/main/cyrvis/` 与 renderer；50 个单元测试通过，node/web typecheck 通过。
16. Qwen realtime 用 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=...` + `sk-ws-...` Key 可直接连；不强制 Workspace ID。输入 16k PCM16，输出 24k PCM16；manual 模式 + 本地能量 VAD 比 server VAD 更可控。
17. 合成语音 “Hello CYRVIS” 被 Qwen ASR 识别为 “Hello, service.”；唤醒匹配已兼容 service/sirvis/cervis/sirius，以及中文“赛维斯/瑟维斯”。
18. Qwen 对 `start_gui_task` 的工具结果是“已启动”，会倾向直接说“I've opened...”；已加 Tool result 明确提示 + VoiceBrain 完成声明拦截。
19. 当前机器 Chromium 只枚举到 “ToDesk Virtual Audio” 输入设备，未枚举到 Realtek/Logitech 实体麦克风；真语音交互需用户插好麦克风并设为默认输入。
20. Doubao 1.5 prompt 增加“必须输出 Action、完成时输出 finished()”后，Seed 2.1 Lite 的 Notepad 任务可正常以 `finished()` 结束。
21. 播放错位的根因在渲染端调度：Qwen 推流快于实时，队列可能领先 >2s；旧逻辑把领先队列重置到 `currentTime`，多个 chunk 同时 start，听起来像不同 AI 说首/中/尾。正确做法是只在 underrun（`nextPlayTime < now`）时追平。
22. 半双工静音会从物理上阻止打断，因此 barge-in 必须在渲染端做本地能量检测：播报时音频不送 ASR，但仍计算能量；触发后先 `bargeIn` 再回灌预录缓冲，主进程顺序处理 IPC。
23. 打断后必须同时处理三件事，否则会“取消后又说话/又聋掉”：丢弃旧响应的 audio delta；canceled `response.done` 不设置 `micMuteUntil`；清空 Qwen 输入缓冲。
24. “喊几遍才理”的主要原因是端点判定过严：最短语音 600ms 会丢掉短促 “Hello”，阈值 300 对耳机麦偏高；已降到 300ms / 250，端点静音 1200ms→800ms，播放结束静音尾 800ms→150ms。合成音频实测平均能量仅 254-348，渲染端打断阈值因此从 1200 降到 350。环境底噪高时需再回调阈值。
25. 工具调用型响应没有音频，渲染端若只靠“最后一个 audio source 结束”开麦，会把麦克风关到 10s 看门狗；必须监听 `response.done`，在无播放源时立即开麦，否则 GUI 任务执行中用户说“停”会被吞。
26. 打断存在竞态：用户取消时服务端可能尚未发出 `response.created`，此时 `response.cancel` 无对象可取消；必须在 `response.created` 到达时识别 `cancelRequested` 并再次取消，否则迟到的响应会照常播报。
27. 播放中打断的自动化验证可通过 CDP 调 `bargeIn()` 并观察日志：正常路径应出现 `canceled response done`、`audio done { bytes: 0 }`，且取消后无新的 `first audio delta`；真实“说话打断”仍依赖耳机麦能量阈值（渲染端 350/300ms）。取消标志窗口必须小于端点静音时间（400ms < 800ms），否则会把打断后用户的新响应再次取消。
28. 真实打断失败的关键证据：`barge monitor` 在播报期间持续输出 `avg=0 peak=0`，而 `sources` 正常递减——麦克风数据在播放期间是**纯静音**，不是阈值问题。用户连续喊“停止”也无效，说明渲染端根本没拿到人声。
29. 已尝试的修复方向：关闭 `echoCancellation`/`noiseSuppression`（Chrome 双讲抑制可能压掉近端人声）；把采集与播放 AudioContext 统一为设备原生采样率（原先 16k 采集 + 24k 播放可能触发 USB 设备重配置）；不再使用 Windows 的 `default`/`communications` 别名，改为显式物理麦克风 deviceId。
30. 进一步排除：把 TTS 输出切到 Realtek 扬声器（`setSinkId`）后，播报期间仍是 `avg=0 peak=0`，`trackMuted=false`、`capture=running`。说明不是 USB 播放端点冲突，也不是浏览器 AEC/采样率；更像是耳机/驱动/Windows DSP 在系统层对麦克风做了半双工静音。该现象与 WebRTC 社区报告的“设备自带增强在播放时压低/静音麦克风”一致。
31. 决策：先用另一套麦克风（AirPods）验证是否为该 USB 耳机硬件问题。若 AirPods 全双工正常，则保留耳机作为输出、AirPods 作为输入，或直接使用 AirPods；若仍为 0，则 Windows 蓝牙 HFP 也有同样限制，需要独立麦克风或仅保留 `Ctrl+Alt+X` 打断。
32. AirPods/蓝牙实测：环境噪声底为 260-486，真实说话为 1700-4500；原 250 阈值把噪声当语音，产生空转写并触发 VoiceBrain 的“空转写取消回复”，形成连续自取消。已把主 VAD 阈值提到 600，并重新开启 `noiseSuppression`（保留 `echoCancellation:false`）。渲染端打断阈值相应调到 400。
33. 另一个关键缺陷：没有物理麦克风时，`getUserMedia` 会回退到 Windows 默认的 ToDesk Virtual Audio。该虚拟设备会收到系统播放声，导致空转写、8 秒长语音和自取消。已禁止虚拟设备回退，无物理麦克风时直接报错并停止语音。
34. 播放路径改为 `MediaStreamDestination` + `<audio>` 元素：Sokuji 在 Electron/Windows 的实测指出，`AudioContext.destination` 播放会被 Chrome AEC 当作参考信号，把麦克风压到约 -96dB；`<audio>`/MediaStream 播放只到约 -29dB，不会把麦克风归零。此方案需在真实 AirPods 上再验证。
35. 实测 `<audio>` 播放 **WebAudio MediaStream** 仍会把麦克风归零；但播放**普通 WAV 文件**（Audio 元素 + blob URL）时，主 VAD 能收到 5430 的能量——说明 AEC 参考只覆盖 WebAudio/MediaSource 路径，普通媒体文件不受影响。
36. 因此最终改为“PCM→MP3→独立 Blob 文件→`<audio>` 顺序播放”：每约 0.75s 一个 MP3 段，避免 WebAudio 与 MediaSource；段间可能有几十毫秒间隙。`lamejs` npm 入口在 Vite 下报 `MPEGMode is not defined`，必须用 `lame.all.js?raw` + `new Function` 取 `lamejs.Mp3Encoder`（CSP 已允许 unsafe-eval）。
37. 另加 Electron `autoplay-policy=no-user-gesture-required`：TTS 的 `<audio>` 在 IPC 回调里创建，不在用户手势栈内，否则 `play()` 会被拒绝。
38. 渲染页 CSP 缺少 `media-src`，`default-src 'self'` 会拦截 `blob:` 音频，表现为 `NotSupportedError: Failed to load because no supported source was found`。已在两个 CSP meta 中加入 `media-src 'self' blob:`。
39. 最终播放方案：PCM→**每 0.75s 一个 WAV Blob 文件**→`<audio>` 顺序播放。实测普通 WAV 文件播放期间麦克风仍能采到声音（440Hz 测试音期间 `__cyrvisMicAvg` 有非零值），而 WebAudio/MediaSource 播放期间为 0。代价是段间可能有几十毫秒间隙，需要真实听感确认。
40. **拆分采集/播放是最终解**：隐藏 BrowserWindow 只做 `getUserMedia` 采集，PCM 经本地 WebSocket 送主进程；主窗口只负责 TTS 播放。播放期间隐藏采集窗口仍能收到用户语音（barge-in avg 4110/4910），而同一渲染进程边播边采时始终为 0。结论：Chrome 的 AEC/采集归零是**按渲染进程/音频会话**的，不是系统全局。
41. 主进程打断检测：阈值 1000、持续 150ms；播报期间耳机漏音仅 0-10，用户人声 3000-16726，区分度足够。AirPods 断开/重连由 `devicechange` 自动重启隐藏采集窗口，日志确认 19:54:09 重新 ready。
42. 仍需注意：隐藏采集窗口使用独立本地 HTTP/WS 服务（127.0.0.1 随机端口），生产打包时需确保端口/权限可用；TTS 分段 0.75s 的听感需用户确认。
43. GUI Agent 不执行的根因（2026-11-15 20:27）：火山方舟/Doubao 返回 `403 The request failed because your account has an overdue balance`，即 Ark 账户欠费；与 CYRVIS 代码无关。语音链路走 Qwen/DashScope，仍正常。处理：充值 Ark 或更换可用的 VLM API Key/模型；无需改代码。
44. 采集 WebSocket 的 PCM 二进制块可能以 `{` 字节开头；之前用文本前缀判断控制消息，会误把 PCM 当 JSON 解析并丢弃。已改为使用 ws 的 `isBinary` 标志，控制消息走文本、PCM 走二进制。
45. VLM Key 存放位置：`%APPDATA%\ui-tars-desktop\ui_tars.setting.json` 的 `vlmApiKey`（electron-store `ui_tars.setting`），不是 `.env`。替换 Key 后直接调 Ark `/chat/completions` 验证。
46. **Ark 普通推理与 Plan 接口不是同一个 Base URL**：普通按量接口是 `https://ark.cn-beijing.volces.com/api/v3`；Coding/Agent Plan 的 OpenAI 兼容接口是 `https://ark.cn-beijing.volces.com/api/plan/v3`（Responses 为 `/api/plan`）。用户的新 Key 是 Plan Key：用 `/api/v3` 报 401 invalid，用 `/api/plan/v3` 对 `doubao-seed-2.1-lite` 和 `doubao-seed-2-1-lite-260915` 都返回 200。当前配置已改为 plan/v3 + `doubao-seed-2.1-lite`。
47. “创建桌面 txt”未执行的根因不是 GUI 模型，而是 **IntentGate 误拒**：模型在 21:18:19 已调用 `start_gui_task`，指令“在桌面新建一个txt文件，并将《沁园春·雪》全文写入其中”不含当时 TASK_VERBS 中的任何词（打开/搜索/给我/把…），`classifyIntent` 判为 ambiguous，VoiceBrain 直接回 `REJECTED`，Controller 根本没启动（日志无 `runAgent`）。已补充 创建/新建/写入/生成/编辑/复制/删除/重命名 等文件操作动词，并在 VoiceBrain 中增加兜底：若模型改写后的指令不含已知动词，但用户原话是 task，则允许启动。新增 2 个测试，57/57 通过。
