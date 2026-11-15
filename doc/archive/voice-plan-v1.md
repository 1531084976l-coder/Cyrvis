# CYRVIS Voice Layer 方案（归档 v1）

> **归档说明（2026-11-15）**：本文是早期方案对比与背景材料，已不再维护。
> 当前语音实现见 [../voice-architecture.md](../voice-architecture.md)；
> 整体框架见 [../architecture.md](../architecture.md)。

> 日期：2026-11-14  
> 范围：语音交互 + Voice/Controller/GUI Agent 协同；眼动后续接入，本期不实现。

## 1. 结论

**Voice Agent 不做“唯一的脑子”，而是“对话脑 + 意图脑”；Controller 是“任务脑”；GUI Agent 是“执行手”。**

推荐链路：

```text
用户语音
  ↕ 全双工音频 / VAD / 打断
Voice Agent（端到端语音模型 + Function Calling）
  ↕ 结构化工具调用 / 任务事件
CYRVIS Controller（main 进程，唯一任务权威）
  ├─ 任务状态机 / 单任务互斥 / 取消 / 安全确认
  ├─ GUI Adapter → GUIAgent（@ui-tars/sdk）
  └─ 事件摘要 → Voice Agent
        ↕ 截图 / 键鼠
Windows 桌面
```

这样既能保持语音对话的流畅，又不会让语音模型臆测 GUI 执行状态。

## 2. 为什么不是 Voice Agent 直接驱动 GUI Agent

| 设计 | 问题 |
|---|---|
| Voice Agent 直接调用 GUI Agent | 语音模型看不到截图，无法做视觉 grounding；容易和 UI-TARS 的规划冲突 |
| Voice Agent 兼任任务状态机 | 语音模型会幻觉“已完成”，无法可靠取消/确认 |
| Controller 夹在中间 | 任务 ID、状态、取消、安全策略都有唯一权威，语音层只负责说和听 |

Voice Agent 的职责：
- 听用户说话、判断意图、追问/确认；
- 调用 `start_gui_task / cancel_gui_task / get_gui_status` 等工具；
- 把 Controller 的任务事件转成自然语言反馈；
- 处理 barge-in（用户打断）。

Controller 的职责：
- 单任务互斥、任务状态机、超时、错误处理；
- 真正触发 `AbortController.abort()` + `guiAgent.stop()`；
- 高风险动作确认策略；
- 向 Voice Agent 发送节流后的状态摘要。

## 3. 语音方案对比

| 方案 | 类型 | 首音延迟 | Function Calling | 国内接入 | 成本 | 结论 |
|---|---|---|---|---|---|---|
| 豆包实时语音 3.0 / Seeduplex | 端到端全双工 | 低（动态判停） | 支持工具/MCP | 豆包语音控制台，需确认邀测/开通 | 音频输入约 ¥80/M、输出约 ¥300/M（第三方估算） | 首选评估，生态一致 |
| Qwen3.8-Omni-Flash-Realtime | 端到端 | 低 | 支持 Function Calling/MCP | 阿里云百炼，国内直连 | 音频输入约 $0.93/M、输出约 $1.87/M | 首选落地/备选，成本低一个量级 |
| OpenAI gpt-realtime-2.1-mini | 端到端 | p50 ~1.1s / p95 ~1.9s（第三方实测） | 支持 | 需代理，国内稳定性一般 | 音频输入 $10/M、输出 $20/M | 不建议作为国内 Demo 主选 |
| 流式 ASR + LLM + 流式 TTS | 级联 | 全流式约 0.8–1.2s | 原生 tool call，最可控 | 国内成熟 | 低 | 保底方案，不是“慢”的代名词 |

关键判断：
- “ASR→LLM→TTS 一定卡顿”只在**非流式、回合制**时成立；全流式级联可以边识别边生成边播报，首音也能做到 1s 左右。
- 端到端语音模型的优势是自然、打断体验好；风险是工具调用稳定性和国内开通/成本。
- GUI 执行本身每步 1–3s，语音层只要能**即时回应 + 持续播报进度**，用户就会觉得流畅。

## 4. 推荐路线

### 4.1 先做一天 Spike（不要直接押注）

用同一组 5 句话 + 3 个任务，对比 2 个候选：

| 测试项 | 指标 |
|---|---|
| 首音延迟 | 用户说完 → 第一段语音 |
| 工具调用准确率 | 是否正确触发 start/cancel/status |
| 打断体验 | 用户插话后 TTS 是否立即停止 |
| 中文自然度 | 主观 1–5 分 |
| 成本 | 每分钟音频费用 |

固定测试语料：
1. “打开浏览器搜索 UI-TARS”
2. “现在到哪一步了？”
3. “停”
4. “取消，改打开记事本”
5. “屏幕上是什么？”

### 4.2 推荐优先级

1. **Seeduplex**：如果你能拿到豆包语音的开通/邀测资格，优先评估。全双工、动态判停、Function Calling 都与需求吻合。
2. **Qwen3.8-Omni-Flash-Realtime**：如果 Seeduplex 开通受阻，用这个落地。端到端 + Function Calling，国内直连，成本低。
3. **流式级联**：如果端到端工具调用不稳定，保留为保底；用流式 ASR + Seed 2.1 Lite/2.0 Mini + 流式 TTS。

## 5. 交互协议

### 5.1 Voice → Controller 工具

```ts
type VoiceTool =
  | { name: 'start_gui_task'; args: { instruction: string; require_confirmation?: boolean } }
  | { name: 'cancel_gui_task'; args: { task_id?: string } }
  | { name: 'pause_gui_task'; args: {} }
  | { name: 'resume_gui_task'; args: {} }
  | { name: 'get_gui_status'; args: {} }
  | { name: 'confirm_action'; args: { task_id: string; approved: boolean } };
```

### 5.2 Controller → Voice 事件

```ts
type ControllerEvent =
  | { type: 'task_started'; taskId: string; instruction: string }
  | { type: 'step_update'; taskId: string; step: number; summary: string }
  | { type: 'needs_confirmation'; taskId: string; question: string; risk: 'high' }
  | { type: 'task_done'; taskId: string; resultSummary: string }
  | { type: 'task_failed'; taskId: string; error: string }
  | { type: 'task_cancelled'; taskId: string };
```

### 5.3 策略

- **单任务互斥**：同一时间只允许一个 GUI 任务。
- **新任务到来**：默认询问“当前任务还在执行，要取消并开始新的吗？”，不自动取消。
- **取消优先**：说“停/取消”不需要二次确认；Controller 立即 abort，停止后续动作。
- **高风险确认**：删除文件、发送消息、支付等由 Controller 强制确认，不能只靠语音模型判断。
- **不得虚报完成**：Voice Agent 只能依据 `task_done/task_failed` 事件说话，不能自己宣布成功。
- **状态摘要节流**：每 3–5 秒或每 N 步播报一次，避免每一步都说话。

## 5.4 Voice → Controller 的指令正确性

核心原则：**Voice Agent 不把原始语音/转写直接丢给 GUI Agent，而是产出结构化的 `start_gui_task`，其中 `instruction` 是已经规范化的一段任务描述。**

```text
用户：“打开 Chrome 搜一下 UI-TARS 桌面版”
  → Voice Agent 工具调用：
     start_gui_task({
       instruction: 'Open Chrome and search for "UI-TARS Desktop"',
       confidence: 0.93
     })
  → Controller 校验：非空、长度、无危险动作、无正在执行任务
  → 创建 task_id，调用 GUIAgent.run(instruction)
  → 语音确认：“好，我来打开 Chrome 搜索 UI-TARS 桌面版”
```

### 典型例子

| 用户说法 | Voice Agent 动作 | Controller 处理 |
|---|---|---|
| “打开浏览器搜 UI-TARS” | `start_gui_task({instruction: "Open Chrome and search for UI-TARS"})` | 校验后启动 |
| “停” | `cancel_gui_task({})` | 立即 abort，不二次确认 |
| “现在到哪一步了？” | `get_gui_status({})` | 返回当前步骤摘要，不启动新任务 |
| “把刚才那个关掉” | 先查上下文；不确定就追问“是指 Chrome 窗口吗？” | 澄清后再启动 |
| “不是这个，是左边那个” | 取消当前任务 + 追问/等待确认 | 不直接派发模糊指令 |
| “打开浏览器搜索 X，然后保存 PDF” | 可合并成一条多步 instruction | 交给 GUI Agent 逐步执行；失败再拆任务 |

### 保证正确性的 6 条机制

1. **严格 Tool Schema**：`instruction` 必填，`intent` 枚举，禁止自由文本直接进入执行层。
2. **Controller 校验/规范化**：应用名白名单、URL/搜索词提取、危险动作拦截；非法指令直接拒绝。
3. **缺槽位先追问**：目标不明确、置信度低时，Voice Agent 先问，不猜。
4. **高风险二次确认**：删除、发消息、支付等必须读回确认；Controller 强制执行。
5. **单任务 + task_id**：避免重复派发；新任务先取消/排队，不并发抢鼠标。
6. **日志与评测**：记录 transcript、tool call、最终 instruction、GUI 状态，用固定语料测准确率。

### 两种实现

| 方式 | 延迟 | 指令准确率 | 复杂度 | 建议 |
|---|---|---|---|---|
| 语音模型原生 Function Calling | 最低 | 中 | 低 | 简单指令、取消、状态查询 |
| 语音转写 + 快速文本 LLM“指令编译器” | +200–500ms | 高 | 中 | 复杂/多步/歧义指令默认走这条 |
| 混合路由 | 低/中 | 高 | 高 | 后续优化 |

推荐：**先用“语音模型原生 FC + Controller 校验”跑通简单指令；复杂指令加一个快速文本 LLM 编译器（Seed 2.0 Mini / 2.1 Lite），它只输出严格 JSON，不参与对话。** 用户会先听到“好，我来处理”，编译器 300ms 内产出 instruction，GUI 第一步本来就要 1–3s，这点延迟用户感知不到。

重要边界：**“指令正确”不等于“任务成功”**。Voice/Controller 能保证传对任务，但 UI-TARS 的视觉定位仍可能失败；所以必须有 `task_done/task_failed` 事件，Voice Agent 不得自行宣布完成。

## 6. UI 行为

当前基座行为（已确认）：
- 任务开始时 `beforeAgentRun` 隐藏主窗口，显示 400×400 悬浮 widget + 屏幕水波纹；
- 任务结束 `afterAgentRun` 恢复主窗口；
- widget 已设置 `setContentProtection(true)`，不会出现在 VLM 截图里；
- 主窗口隐藏前也设置了 content protection。

这是有意设计：避免 Agent 截到/点到自己的窗口，保持截图干净。

语音 UI 放在 **widget 窗口**：
- 麦克风状态、波形、当前任务、简短 transcript、停止按钮；
- 不新开大窗口，避免遮挡和截图污染；
- 给 widget 加 `backgroundThrottling: false`，避免隐藏/后台时音频定时器被节流；
- 如后续需要更大的语音面板，新开 BrowserWindow 并 `setContentProtection(true)`，再用 `desktopCapturer` 实测确认不进入截图。

麦克风权限：
- Windows 设置 → 隐私 → 麦克风，允许桌面应用；
- Electron main 增加 `session.defaultSession.setPermissionRequestHandler` 允许 `media`；
- 演示时建议戴耳机，避免 TTS 回声触发 VAD。

## 7. 工程落点

```text
apps/ui-tars/src/main/cyrvis/
├── controller.ts          # 状态机、单任务互斥、取消
├── events.ts              # 类型化事件总线
├── gui-adapter.ts         # 包装 runAgent / GUIAgentManager
├── voice/
│   ├── provider.ts        # 统一语音 Provider 接口
│   ├── seeduplex.ts       # 豆包实时语音 3.0
│   ├── qwen-omni.ts       # Qwen-Omni Realtime
│   ├── cascade.ts         # 流式 ASR + LLM + TTS 保底
│   └── audio-bridge.ts    # main ↔ renderer 音频 IPC
└── voice-ipc.ts

apps/ui-tars/src/renderer/src/components/CyrvisVoice/
├── VoiceWidget.tsx        # widget 语音 UI
└── useVoiceAudio.ts       # 麦克风采集 / 播放 / VAD / 打断
```

音频路径：
- Renderer 采集 16kHz mono PCM16，20ms 分片；
- 通过 IPC 送到 main，main 维持与语音 Provider 的 WebSocket；
- TTS 音频从 main 回传 renderer，Web Audio 队列播放；
- 用户插话时立即清空播放队列并发送 cancel。

## 8. 两周排期（语音优先）

| 时间 | 工作 | 验收 |
|---|---|---|
| Day 1–2 | Controller + 事件总线 + GUI Adapter；文本模式验证 start/status/cancel | 文本输入能启动、查询、取消任务 |
| Day 3–4 | 语音 Provider Spike；麦克风/扬声器/权限；选定方案 | 5 句话首音延迟和工具调用数据 |
| Day 5–7 | 语音工具调用、barge-in、确认策略 | 说话→执行→语音反馈；说“停”能停止后续动作 |
| Day 8–9 | widget 语音 UI、状态播报、错误处理 | 执行中可看到语音状态并打断 |
| Day 10–11 | 联调固定场景、延迟/成本指标 | 3 个场景可重复 |
| Day 12–14 | 稳定性、降级到文本/PTT、演示脚本 | Demo 可重复，不虚报结果 |

## 9. 验收指标

| 指标 | 目标 |
|---|---|
| 用户说完 → 第一段语音 | p50 < 1.0s，p95 < 1.5s |
| 任务确认语 | < 500ms |
| 说“停” → 停止派发后续动作 | < 500ms |
| 状态播报 | 每 3–5 秒或每步一次，不刷屏 |
| 工具调用 | 固定 20 句话准确率 ≥ 90% |
| 任务成功 | 3 个固定场景可重复 |
| 成本 | 记录每分钟音频 + 每个 GUI 任务的 tokens |

## 10. 风险

| 风险 | 处理 |
|---|---|
| Seeduplex 邀测/开通不确定 | 先确认资格；同时准备 Qwen-Omni 备选 |
| 端到端模型 Function Calling 不稳定 | 关键动作二次确认；保底切流式级联 |
| 回声触发误打断 | 耳机 + echoCancellation + 本地 VAD 双保险 |
| 语音模型虚报完成 | Controller 事件为唯一事实；禁止模型自行宣布成功 |
| widget 仍进入截图 | 实测 `desktopCapturer`；必要时在截图函数里遮罩语音 UI 区域 |
| 音频成本 | 记录 tokens/分钟；状态播报节流 |
