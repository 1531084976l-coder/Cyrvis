# CYRVIS 当前架构

> 最后更新：2026-11-15
> 本文是**当前实现**的整体架构；语音细节以 [voice-architecture.md](./voice-architecture.md) 为准。
> 2026-11-14 的 v1 设计已归档到 [archive/architecture-v1.md](./archive/architecture-v1.md)。

## 1. 一句话定义

**CYRVIS = UI-TARS GUI Agent（执行手） + Controller（任务脑） + Voice Agent（对话脑） + Gaze（规划中）。**

Voice Agent 不直接驱动鼠标键盘，也不直接调用 GUI Agent；所有任务经过 Controller。

## 2. 运行时拓扑

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ 主窗口 Renderer             │        │ 隐藏采集窗口 Renderer        │
│ - 语音条 / 工作台 UI        │        │ - 仅 getUserMedia            │
│ - WAV 分段播放 TTS          │        │ - 不播放声音                 │
│ - 不采集麦克风              │        │ - PCM → 本地 WebSocket       │
└──────────────┬──────────────┘        └──────────────┬───────────────┘
               │ IPC                                  │ ws://127.0.0.1:<port>
               ▼                                      ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Electron Main                                                          │
│  VoiceService                                                          │
│   ├─ CaptureService：隐藏窗口 + 本地 HTTP/WS + PCM 回调                 │
│   ├─ 打断检测：播报中能量阈值 1000 / 150ms / 600ms 预录                 │
│   ├─ QwenOmniProvider：Realtime ASR/TTS、Function Calling、本地 VAD     │
│   ├─ VoiceBrain：意图路由、唤醒、确定性控制、主动播报                   │
│   ├─ ProactivityPolicy：任务事件 → 主动播报                             │
│   └─ CyrvisController → ElectronGUIAdapter → UI-TARS GUIAgent           │
└───────────────────────────────────────────────────────────────────────┘
```

关键点：**采集与播放分进程**。同进程边播边采时，Chrome/Windows 的 AEC 会把麦克风采样归零，
语音打断无法工作；拆分后播放期间采集窗口仍能收到用户语音。

## 3. 模块职责

| 模块 | 位置 | 职责 |
|---|---|---|
| VoiceService | `main/cyrvis/voice-service.ts` | 单例、IPC、采集启动/热插拔、打断检测、双模式 |
| CaptureService | `main/cyrvis/capture-service.ts` | 隐藏采集窗口、本地 HTTP/WS、物理麦选择 |
| QwenOmniProvider | `main/cyrvis/voice/qwen-omni.ts` | Qwen Realtime WebSocket、ASR/TTS/工具、取消、VAD |
| VoiceBrain | `main/cyrvis/voice-brain.ts` | 意图路由、唤醒、工具校验、确定性控制、主动播报 |
| CyrvisController | `main/cyrvis/controller.ts` | 单任务状态机、暂停/恢复/取消、stall、事件总线 |
| ElectronGUIAdapter | `main/cyrvis/gui-adapter.ts` | 包装 `runAgent` / `GUIAgentManager`，映射任务事件 |
| ProactivityPolicy | `main/cyrvis/proactivity.ts` | 优先级、冷却、静音门控、主动话术 |
| Renderer | `components/CyrvisVoice/`、`CyrvisUI/`（规划） | 语音条、播放器、工作台 |

## 4. 核心链路

### 4.1 语音任务

```
用户语音
  → CaptureService PCM（16k/20ms）
  → QwenOmniProvider.sendAudio
  → 本地 VAD 提交（800ms 静音）
  → Qwen ASR / Function Calling
  → VoiceBrain：意图门控 + 工具校验
  → Controller.startTask → GUIAgent.run
  → 事件 task_started / step_update / task_done
  → ProactivityPolicy → Provider.speak
  → 主窗口 WAV 播放
```

### 4.2 语音打断（耳机模式）

```
播报中采集 PCM
  → 能量 > 1000 持续 150ms
  → provider.bargeIn()（response.cancel + 丢弃残留音频 + 开麦）
  → 广播 response-stopped → 主窗口停播
  → 回灌最近 600ms PCM → 转写“停/取消”
  → VoiceBrain 确定性控制 → Controller 暂停/取消
```

外放模式为半双工：播放期间丢弃 PCM + 结束后 800ms 尾音保护，语音打断关闭，
用 `Ctrl+Alt+X` / Interrupt。详见 [voice-architecture.md](./voice-architecture.md)。

### 4.3 取消/暂停

- 语音转写命中“停/取消/暂停”时，VoiceBrain 直接调用 Controller，不依赖模型工具调用；
- Controller 调 adapter.cancel/pause；GUI 侧 `AbortController.abort()` + `guiAgent.stop()`；
- 取消只停止后续动作，不回滚已执行的点击。

### 4.4 状态反馈

GUIAdapter 回调 → Controller 事件 → ProactivityPolicy → TTS。
完成/失败/取消只由 Controller 事件产生；Voice Agent 不得自行宣布成功。

## 5. 状态

### 5.1 任务（`TaskStatus`）

`idle → starting → executing → paused / cancelling → done / failed / cancelled`

单任务互斥；同一时间只允许一个 GUI 任务，所有任务有 `taskId`。

### 5.2 语音 UI

| 状态 | 含义 |
|---|---|
| Sleeping / Ready | 未唤醒 / 可说话 |
| Listening | 正在采集用户语音 |
| Thinking | 已提交，等待首 token |
| Speaking | TTS 播放中（可打断） |
| Executing | GUI 任务执行中 |

## 6. 接口契约（以源码为准）

| 接口 | 文件 | 要点 |
|---|---|---|
| `VoiceProvider` | `voice/provider.ts` | `connect/sendAudio/sendToolResult/cancelResponse/speak/close` + callbacks |
| `VoiceToolCall` | `types.ts` | `start_gui_task`、`cancel/pause/resume_gui_task`、`get_gui_status`、`confirm_action` |
| `ControllerEvent` | `types.ts` | `task_started/executing/step_update/stalled/needs_user/paused/resumed/cancelling/done/failed/cancelled` |
| `GUIAdapter` | `types.ts` | `start(instruction, callbacks)/cancel/pause/resume`；taskId 由 Controller 持有 |
| `TaskSnapshot` | `types.ts` | UI 展示任务状态、步骤、摘要、错误 |

## 7. 目录

```
apps/ui-tars/src/main/cyrvis/
├── controller.ts
├── gui-adapter.ts
├── voice-brain.ts
├── capture-service.ts
├── voice-service.ts
├── proactivity.ts
├── types.ts
├── voice/
│   ├── provider.ts
│   ├── qwen-omni.ts
│   └── tools.ts
├── gui/          # 规划：Task Router / MCP / 加速
├── gaze/         # 规划
├── proactivity/  # 规划：触发器/策略/反馈
└── memory/       # 规划

apps/ui-tars/src/renderer/src/components/
├── CyrvisVoice/  # 语音条、WAV 播放器
└── CyrvisUI/     # 规划：工作台
```

## 8. 关键设计决策

| 决策 | 原因 |
|---|---|
| Controller 是任务唯一权威 | 防止 Voice 误报完成/多任务并发 |
| 采集/播放分进程 | 同进程 AEC 会归零麦克风，语音打断失效 |
| TTS 用 WAV 分段文件 | WebAudio/MediaSource 播放同样触发 AEC；普通文件不触发 |
| 语音工具严格校验 | 防止“你好”等闲聊进入 GUI Agent |
| 确定性暂停/取消 | 模型可能只说“已暂停”但不调用工具 |
| 单实例 + 关闭到托盘 | 防止多实例重复语音/音频 |
| 物理麦校验 | ToDesk 虚拟麦会收到系统回环，产生空转写 |

## 9. 与 v1 设计的主要差异

| v1 设计 | 当前实现 |
|---|---|
| Voice 在 Renderer 采集/播放 | 隐藏采集窗口采集；主窗口播放 |
| `events.ts` / `voice/realtime/` / `voice/cascade/` | `types.ts` / `voice/qwen-omni.ts`（单 Provider） |
| `VoiceWidget.tsx` / `useVoiceState.ts` | `CyrvisVoiceBar.tsx` / `useVoiceAudio.ts` |
| GUIAdapter 返回 taskId | Controller 生成 taskId，adapter 只执行 |
| 语音 Provider 可插拔多实现 | 当前 Qwen 实现，接口保留可插拔 |
| 眼动列为 P0/P1 | 尚未进入实现，见 roadmap |

## 10. 后续

GUI 加速/MCP/简单任务直连、UI 升级、眼动、主动性/记忆的模块边界与分支见
[roadmap.md](./roadmap.md)。开发环境与故障排查见 [development.md](./development.md)。
