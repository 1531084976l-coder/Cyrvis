# CYRVIS Voice 内嵌实现清单（归档 v1）

> **归档说明（2026-11-15）**：这是首版语音任务清单与排期，已完成/已调整。
> 当前实现见 [../voice-architecture.md](../voice-architecture.md)；
> 后续重点见 [../roadmap.md](../roadmap.md)。

> 日期：2026-11-14  

## 0. 三个必须达成的目标

| 目标 | 明天的最低验收 | 不能接受的伪实现 |
|---|---|---|
| 流畅跟用户交流 | 说完 → 首段语音 p50 < 1.5s；可打断；执行中不长时间静默 | 只能文字输入；TTS 播报完才继续 |
| 充当大脑跟 Controller/GUI 交流 | 20 句固定语料指令准确率 ≥ 90%；能 start/status/cancel；不虚报完成 | 语音模型直接调 GUI；Controller 不校验 |
| 主观能动性 | 至少 3 类主动行为：即时确认、停滞提醒、完成/失败汇报、歧义追问 | 只会被动回答；或不停刷屏 |

## 1. 明天的最小闭环

```text
按住说话（PTT）或 VAD
  → ASR
  → 意图编译（严格 JSON）
  → Controller 校验
  → GUIAgent.run(instruction)
  → 事件：task_started / step_update / task_done / task_failed
  → TTS 播报
  → 用户可随时说“停”或点停止
```

必须有的 UI 状态：

```text
Listening → Thinking → Executing → Speaking → Done / Failed / Cancelled
```

## 2. 两条实现路线（同一个 Controller，Provider 可替换）

| 路线 | 组成 | 优点 | 风险 | 明天建议 |
|---|---|---|---|---|
| A. 端到端 | Seeduplex / Qwen-Omni Realtime | 自然、打断好、链路短 | 开通资格、FC 稳定性、音频成本 | 有权限就上，作为增强 |
| B. 级联 | 流式 ASR + 意图编译 + 流式 TTS | 可控、工具调用准、易调试 | 需要自己处理 VAD/打断 | **明天保底主线** |

**关键决策：明天 Demo 不能把成败押在“今天能否开通端到端语音”上。**  
先做 B 保底；A 通过 `RealtimeVoiceProvider` 并行接入，接口不变。

## 3. Provider 决策门

| 时间点 | 检查 | 决策 |
|---|---|---|
| 今天 22:00 前 | 是否有豆包语音（Seeduplex）或阿里百炼（Qwen-Omni）权限 | 有 → 明天并行接端到端；没有 → 走 B |
| 明天 11:00 前 | ASR 是否能返回中文转写 | 不能 → 换本地 faster-whisper |
| 明天 14:00 前 | TTS 是否能播报中文 | 不能 → 换 Windows SAPI / edge-tts |
| 明天 17:00 前 | 端到端 FC 是否稳定 | 不稳定 → 关闭端到端，只演示级联 |

### Provider 备选

| 方案 | 接入 | 明天可用性 | 备注 |
|---|---|---|---|
| 豆包流式 ASR + 豆包 TTS | 豆包语音控制台，API Key/Resource ID | 中 | 中文好、国内低延迟；需开通 |
| 阿里百炼 Paraformer ASR + CosyVoice TTS | DashScope API Key | 中 | 国内直连；需开通 |
| 本地 faster-whisper + Windows SAPI | Python 侧车 + 系统语音 | 高（无需云权限） | 需要下载模型；音色一般 |
| edge-tts | npm/Python 包，微软在线 | 中 | 免费、音色好；依赖外网 |
| Seeduplex / Qwen-Omni Realtime | 独立实时语音 API | 低（权限不确定） | 端到端增强，不作为保底 |

## 4. 主观能动性设计

### 4.1 主动策略表

| 触发 | 条件 | 语音示例 | 优先级 | 冷却 |
|---|---|---|---|---|
| 任务开始 | `task_started` | “好，我来打开 Chrome 搜索 UI-TARS” | P1 | 每任务一次 |
| 步骤停滞 | 5s 无新进度 | “这一步有点慢，我还在处理” | P2 | 8s |
| 需要确认 | 高风险/歧义 | “你是指 Chrome 窗口吗？” | P0 | 每次确认一次 |
| 任务失败 | `task_failed` | “没成功，原因是……要我重试吗？” | P1 | 每任务一次 |
| 任务完成 | `task_done` | “完成了，还需要我做什么吗？” | P1 | 每任务一次 |
| 用户空闲 | 完成后 10s 无输入 | 可选建议，默认关闭 | P3 | 30s |

### 4.2 什么时候不许说

- 用户正在说话（VAD 检测到语音）。
- TTS 正在播放，且新消息优先级不高于当前播报。
- 距离上一次主动播报 < 3s（P2/P3）。
- 当前任务处于高风险确认，必须等用户回答。
- 语音 Provider 未连接/断线。

### 4.3 主动但不越权

- 可以主动：确认、追问、提醒、建议、汇报。
- 不可以主动：删除文件、发消息、支付、修改系统设置。
- 所有执行仍必须经过 Controller 的 `start_gui_task` 工具和校验。

## 5. 任务清单

### P0（明天必须完成）

| ID | 任务 | 文件 | 验收 | 估时 |
|---|---|---|---|---|
| V0 | Controller 骨架 + 事件总线 + GUI Adapter | `main/cyrvis/controller.ts`、`events.ts`、`gui-adapter.ts` | 文本模式 start/status/cancel 跑通 | 2h |
| V1 | 音频采集/播放 + 麦克风权限 + widget 状态 | `renderer/.../CyrvisVoice/useVoiceAudio.ts`、`VoiceWidget.tsx` | 按住说话有波形；TTS 能播放 | 2h |
| V2 | ASR + PTT 链路 | `main/cyrvis/voice/cascade/asr.ts` | 说一句话返回中文转写 | 2h |
| V3 | 意图编译 + Tool Schema + Controller 校验 | `main/cyrvis/voice/cascade/intent.ts` | 20 句中简单指令正确触发 start/cancel/status | 2h |
| V4 | TTS + 确认/完成/失败播报 | `main/cyrvis/voice/cascade/tts.ts` | 能听到“好，我来处理”“完成了”“没成功” | 1.5h |
| V5 | 语音/按钮取消 | Controller + widget | 说“停”或点停止，后续动作不再派发 | 1h |
| V6 | 主动播报：开始确认 + 停滞提醒 + 完成/失败 | `main/cyrvis/proactivity.ts` | 至少 3 类主动行为可演示 | 1.5h |
| V7 | 测试集 + 演示脚本 | `doc/voice-testset.md`（可内嵌） | 3 个固定场景可重复 | 1h |

### P1（明天有余力再做）

| ID | 任务 | 验收 |
|---|---|---|
| V8 | VAD 常听 + barge-in | 用户插话，TTS 立即停止 |
| V9 | 端到端 Provider（Seeduplex/Qwen-Omni） | 同一套 Controller 工具可被端到端模型调用 |
| V10 | 多轮上下文（“刚才那个”“再搜一下”） | 能正确指代当前任务/上一个应用 |
| V11 | 完成后主动建议 | “要不要我顺便打开官网？”可开关 |

### P2（后续）

- 眼动 hint 接入 `TaskRequest.gazeHint`。
- 声纹识别/个性化音色。
- 任务队列与多任务调度。

## 6. 明天时间表

| 时间 | 工作 | 产出 |
|---|---|---|
| 09:00–10:00 | Controller 骨架 + 文本模式 | start/status/cancel 可测 |
| 10:00–11:30 | 音频采集/播放、widget 状态、麦克风权限 | 能录音、能播放测试音 |
| 11:30–13:00 | ASR + PTT | 一句话转中文文本 |
| 13:00–14:00 | 意图编译 + Tool Schema | 语音 → `start_gui_task` |
| 14:00–15:30 | TTS + 确认/完成/失败 | 完整语音闭环 |
| 15:30–16:30 | 取消 + 主动播报 | 说“停”可停；至少 3 类主动行为 |
| 16:30–17:30 | 固定场景联调 | 3 个场景可重复 |
| 17:30–18:30 | 演示脚本 + 录屏 | 明天可演示 |
| 18:30–20:00 | 缓冲/修复 | 处理现场问题 |

## 7. 测试集

### 7.1 简单指令（应触发 start_gui_task）

| # | 用户说法 | 期望 instruction |
|---|---|---|
| 1 | 打开记事本输入 hello | `Open Notepad and type "hello"` |
| 2 | 打开 Chrome 搜索 UI-TARS | `Open Chrome and search for "UI-TARS"` |
| 3 | 打开设置 | `Open Windows Settings` |
| 4 | 帮我打开浏览器查一下 CYRVIS | `Open Chrome and search for "CYRVIS"` |
| 5 | 打开计算器 | `Open Calculator` |

### 7.2 控制指令

| # | 用户说法 | 期望工具 |
|---|---|---|
| 6 | 停 | `cancel_gui_task` |
| 7 | 取消 | `cancel_gui_task` |
| 8 | 等一下 | `pause_gui_task` |
| 9 | 继续 | `resume_gui_task` |
| 10 | 现在到哪一步了 | `get_gui_status` |

### 7.3 歧义/追问（不应直接执行）

| # | 用户说法 | 期望 |
|---|---|---|
| 11 | 打开那个 | 追问“你是指哪个应用？” |
| 12 | 把刚才那个关掉 | 结合上下文追问/确认 |
| 13 | 点左边那个 | 语音-only 下追问；有眼动时用 gazeHint |
| 14 | 搜一下它 | 追问“它是指什么？” |
| 15 | 不是这个，是另一个 | 取消当前 + 追问 |

### 7.4 多步任务

| # | 用户说法 | 期望 |
|---|---|---|
| 16 | 打开浏览器搜索 UI-TARS 然后保存 PDF | 一条多步 instruction |
| 17 | 打开设置找到蓝牙 | 一条 instruction，由 GUI Agent 分步执行 |
| 18 | 打开记事本输入日期再保存 | 一条 instruction；失败则拆任务 |

### 7.5 闲聊/主动交互

| # | 用户说法 | 期望 |
|---|---|---|
| 19 | 你好 | 自然回应，不启动任务 |
| 20 | 谢谢 | 简短回应；完成后可主动问“还需要我做什么” |

## 8. 验收标准

| 项目 | 目标 |
|---|---|
| 语音识别 | 5 句简单指令至少 4 句正确 |
| 指令准确率 | 20 句固定语料 ≥ 90% |
| 首音延迟 | p50 < 1.5s（明天保底） |
| 取消 | 说“停”后不再派发新动作 |
| 主动行为 | 开始确认、停滞提醒、完成/失败汇报至少 3 类 |
| 虚报完成 | 0 次 |
| UI | 主窗口隐藏时 widget 可见、可停止、不进入截图 |

## 9. 需要你提供/确认

1. **语音 Provider 权限**：豆包语音（Seeduplex/流式 ASR/TTS）或阿里百炼（Qwen-Omni/Paraformer）是否可开通？
2. **明天用 PTT 还是 VAD 常听**：建议 PTT 保底，VAD 作为增强。
3. **麦克风/耳机**：演示时建议耳机，避免 TTS 回声。
4. **主动交互默认级别**：只播报任务关键事件，还是允许完成后的建议？
5. **是否允许修改** `widget` 页面与 `agentRoute` 代码（语音接入需要）。

## 10. 风险与降级

| 风险 | 影响 | 降级 |
|---|---|---|
| 语音 API 开不通 | 无法语音输入 | 本地 faster-whisper + Windows SAPI/edge-tts |
| ASR 中文识别差 | 指令传错 | PTT + 慢速清晰说话 + 确认/追问 |
| 端到端 FC 不稳定 | 指令不准 | 关闭端到端，走级联 + 指令编译器 |
| TTS 延迟高 | 对话卡顿 | 流式 TTS / 先播短确认语 |
| 回声误触发 | 打断频繁 | 耳机 + echoCancellation + VAD 阈值 |
| 主动播报过多 | 用户烦 | 优先级 + 冷却 + 默认保守 |
| widget 进入截图 | GUI 看错屏幕 | 已 content protection；实测并加截图遮罩兜底 |
