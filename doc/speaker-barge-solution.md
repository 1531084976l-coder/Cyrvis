# CYRVIS 外放语音打断解决方案

> 2026-11-17。本文评估现有实现、外部开源方案，并给出可分阶段验收的工程方案。

## 1. 结论

当前外放打断失败的根因是**声学混合**，不是语音模型或阈值：

```text
麦克风 = 用户人声 + 助手外放回声 + 环境噪声
```

实测外放回声 3933–13183，用户人声 3000–4500，回声经常比人声还大。声纹干净自检 0.7446、TTS 原始音频 0.11–0.17，但播放中只有 0.02–0.30。**声纹不能分离混合信号，只能判断干净音频是谁。**

因此暂停继续调声纹/能量阈值，改为：

1. **AEC 回声消除**：先从混合音频中分离出近端人声；
2. **本地 KWS**：识别“停/停一下/别说了”；
3. **流式 ASR**：识别“直接说新任务”；
4. **Interrupt Controller**：统一控制 TTS、播放队列、GUI 任务和旧响应丢弃；
5. 声纹只作为 AEC 后的可选第二道门，不作为第一道门。

## 2. 对现有外部建议的评估

| 建议 | 评估 | 处理 |
|---|---|---|
| Windows 自带 AEC（IAcousticEchoCancellationControl） | 值得先检查，但蓝牙 HFP 麦克风通常不提供该控制；不能作为主方案 | 10 分钟探针验证 |
| XMic（WebRTC AEC3 + RNNoise，虚拟声卡） | 真实存在，适合**快速验证**；依赖 VB-CABLE，使用系统回环而非我们的 TTS 参考，不适合直接产品化 | 仅做设备组合验证 |
| pywebrtc-audio（WebRTC APM Python bindings） | 有 Windows x86_64 预编译 wheel，含 AEC3/NS/AGC/VAD，`stream_delay_ms` 可对齐；适合做本地 sidecar | **首选集成方案** |
| sherpa-onnx 中文 KWS | 已有 sherpa-onnx 环境；`sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01` 支持自定义关键词，160/320ms 分块 | **首选停词识别** |
| WASAPI Loopback 作为参考 | 可行，但会混入全部系统声音；我们已有实际 TTS 播放参考 PCM，更干净 | 暂不采用 |
| 声纹继续判混合音频 | 已实测失败 | 停止投入 |
| 只做 Ducking + ASR | 可作为兜底，但无 AEC 时 Ducking 触发本身会被回声污染 | 作为 AEC 后的软打断层 |
| 换带杆/指向性麦克风 | 最可靠的硬件方案 | 演示兜底 |

## 3. 目标行为

| 用户行为 | 系统动作 |
|---|---|
| “停” | KWS 高置信度 → 立即停止 TTS + 清空播放队列 + 取消旧响应 + 暂停 GUI 任务 |
| “停一下” | KWS → 停止 TTS + 暂停 GUI 任务（可恢复） |
| “赛维斯停止” / “别说了” | KWS 备用长口令，降低单字“停”漏检 |
| 直接说新任务 | ASR 转写 → 取消旧 TTS/旧回复 → 新任务交给 Controller |
| 环境噪声 / 助手回声 | AEC + VAD/声纹 → 忽略，继续播放 |

“停”和“新任务”必须是**不同策略**：

- “停”不等完整 ASR，KWS 直接触发硬打断；
- 新任务需要流式 ASR + 意图确认，先取消旧回复，再交给 GUI Agent。

## 4. 推荐架构

```text
                     ┌──────────────────────────────┐
TTS PCM（24k）───────┤ 参考重采样/时间戳/环形缓冲      │
                     └──────────────┬───────────────┘
                                    │ far-end
麦克风 PCM（16k）────────────────────┼───────────────┐
                                    ▼               │
                          ┌──────────────────┐       │
                          │ AEC sidecar      │       │
                          │ WebRTC AEC3      │       │
                          │ NS + AGC + VAD   │       │
                          └────────┬─────────┘       │
                                   │ near-end clean  │
                    ┌──────────────┼──────────────┐  │
                    ▼              ▼              ▼  │
              ┌──────────┐  ┌──────────┐  ┌──────────────┐
              │ 本地 KWS │  │ VAD      │  │ 流式 ASR     │
              │ 停/停一下│  │ 近端检测 │  │ 新任务/指令  │
              └────┬─────┘  └────┬─────┘  └──────┬───────┘
                   │             │               │
                   └─────────────┼───────────────┘
                                 ▼
                     ┌─────────────────────────┐
                     │ Interrupt Controller    │
                     │ turn_id / 软打断 / 硬打断│
                     └───────┬─────────┬───────┘
                             │         │
                    ┌────────▼───┐ ┌───▼────────────┐
                    │ TTS/播放器 │ │ GUI Controller │
                    │ 停止/清空  │ │ pause/cancel   │
                    └────────────┘ └────────────────┘
```

原则：

1. AEC 是核心，必须使用**实际播放的 TTS PCM**作为 far-end 参考；
2. KWS 与 ASR 并行，不串行等待；
3. 软打断只降低音量，硬打断才清空队列；
4. 所有取消都带 `turn_id`，旧 turn 的迟到音频/文本必须丢弃；
5. `Ctrl+Alt+X` 和界面按钮保留。

## 5. 音频链路细节

### 5.1 采样率与帧

- 麦克风：16kHz mono PCM16（现有隐藏采集窗口）；
- TTS：24kHz PCM16，重采样到 16kHz 作为 AEC far-end；
- AEC/NS/AGC/VAD：10ms 帧（160 samples @16k）；
- KWS：sherpa-onnx 流式模型，建议 16k，chunk 16/32（160/320ms）；
- ASR：16k PCM，复用 Qwen 流式 ASR 或独立 ASR 会话。

### 5.2 时间对齐

- 渲染端在**实际播放前**发送完整 TTS 参考 PCM + 计划开始时间；
- 主进程维护 far-end 环形缓冲；
- 用 pywebrtc-audio 的 `stream_delay_ms` 粗对齐，再用互相关在 ±300ms 内微调；
- 蓝牙时钟漂移：每 10–30s 重新估计延迟；必要时对 far-end 做微重采样；
- 任何时刻如果参考不可用，AEC 标记为不可信，KWS/ASR 不作为硬打断依据。

### 5.3 双讲（Double-talk）

目标不是“完全消掉 AI 声音”，而是用户和 AI 同时说话时，近端语音仍然可识别：

- AEC3 原生支持双讲检测；
- 双讲期间不要重置滤波器，不要清空近端缓冲；
- 软打断可将 TTS 音量降到 20–30%，但**不要暂停**，避免用户以为已经停止；
- 硬打断只在 KWS 高置信度或 ASR 明确任务时执行。

## 6. Interrupt Controller

### 6.1 状态

```text
idle
listening
assistant_speaking
soft_barge (ducked)
hard_barge_pending
cancelling
```

### 6.2 turn_id

每个助手回复分配 `turn_id`：

- TTS 音频块携带 `turn_id`；
- 播放器只接受当前 `turn_id` 的块；
- 取消时递增 `turn_id`，旧块直接丢弃；
- ASR/工具调用的迟到响应同样按 `turn_id` 丢弃。

### 6.3 软打断

触发条件：AEC 后 VAD 检测到近端语音概率高，且持续 150–250ms。

动作：

1. TTS gain 在 50ms 内降到 0.25；
2. 继续收集近端音频，交给 KWS/ASR；
3. 300–600ms 内确认：
   - KWS 命中 → 硬打断；
   - ASR 识别出新任务 → 硬打断 + 新任务；
   - 误触发 → gain 恢复到 1.0，继续播放。

### 6.4 硬打断

动作顺序：

1. 停止播放器并清空未播放队列；
2. `provider.cancelResponse()`，递增 `turn_id`；
3. `controller.pauseTask()`（“停”）或 `cancelTask()`（明确取消）；
4. 麦克风静音 900ms，等 TTS 尾音衰减；
5. 2s 内抑制模型确认语；
6. 广播 `response-stopped`，UI 状态同步。

## 7. 分阶段实施

### Phase 0：环境探针（0.5 天）

- 检查 Windows `IAcousticEchoCancellationControl` 是否对 `cc ultimate` 可用；
- 录制 3 组 WAV：AI 单独外放、用户单独说话、双讲；
- 作为后续 AEC 对比基线。

验收：有可重复的 near/far WAV 对。

### Phase 1：离线 AEC 验证（1 天）

- 安装 `pywebrtc-audio`，写离线脚本读取 near/far WAV；
- 用 `EchoCanceller`/`AudioProcessor` 处理；
- 对比处理前后：
  - 回声残留（ERLE）；
  - 双讲时用户语音可懂度；
  - 再用声纹/ASR 检查近端是否恢复。

验收：双讲场景 ERLE ≥ 10–15dB，用户语音可被 ASR 正确转写。

### Phase 2：实时 AEC sidecar（1–2 天）

- 本地 HTTP/WebSocket sidecar，接收 near/far 10ms 帧；
- 参考环形缓冲 + 延迟对齐；
- 输出 near-end clean PCM；
- 先不影响现有 KWS/ASR，只记录处理前后波形/指标。

验收：实时因子 > 20x，端到端额外延迟 < 50ms。

### Phase 3：KWS 停词（1 天）

- 下载 `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`；
- 关键词：`停`、`停一下`、`别说了`、`赛维斯停止`；
- 在 AEC 输出上跑 KWS；
- 调整阈值，统计漏检/误触发。

验收：安静/外放/双讲三种场景各 20–30 次，停词召回 ≥ 95%，误触发 ≤ 1 次/10 分钟。

### Phase 4：流式 ASR + 新任务（1–2 天）

- AEC 输出进入流式 ASR；
- 识别到任务意图 → Interrupt Controller 取消旧回复 → Controller 执行；
- 复用现有 VoiceBrain/IntentGate，不重建语音 Agent。

验收：新任务前 3 个字不丢，ASR 完整率 ≥ 90%。

### Phase 5：软打断与打磨（1 天）

- VAD → duck TTS；
- KWS/ASR 确认后硬打断；
- 误触发恢复音量；
- 全链路延迟/状态测试。

## 8. 测试矩阵与指标

每组 20–30 次：

| 场景 | 观察 |
|---|---|
| AI 单独外放 | 不应打断；AEC 后近端接近静音 |
| 外放中说“停” | 打断成功率、延迟 |
| 外放中说“停一下” | 暂停任务成功率 |
| 外放中说新任务 | ASR 完整率、任务启动 |
| 双讲（用户与 AI 同时说） | 用户语音可懂度、KWS/ASR 是否命中 |
| 环境噪声/键盘声 | 误触发率 |
| 蓝牙耳机 vs Realtek 输出 | 延迟漂移/卡顿 |

指标：

| 指标 | 目标 |
|---|---|
| “停”打断延迟 | < 500ms |
| 错误打断率 | ≤ 1 次/10 分钟 |
| 双讲 ERLE | ≥ 15dB |
| KWS 召回 | ≥ 95% |
| 新任务 ASR 完整率 | ≥ 90% |
| 旧 turn 音频泄漏 | 0 |

## 9. 风险与决策点

| 风险 | 说明 | 缓解 |
|---|---|---|
| 蓝牙时钟漂移 | 两个设备时钟不同步，AEC 延迟漂移 | 定期重估延迟/微重采样 |
| 蓝牙 HFP/A2DP | 麦克风与高质量输出共存可能降码率 | 外放用 Realtek；麦克风尽量 USB/有线 |
| Windows AEC 不可用 | 蓝牙麦通常不支持 IAcousticEchoCancellationControl | 用 pywebrtc-audio 软件 AEC |
| 双讲残留 | AEC 不能完全消除混响 | 声纹/ASR 第二道门；软打断 |
| 单字“停”太短 | KWS 可能漏检 | 备用长口令“赛维斯停止/停一下” |
| 虚拟声卡 | XMic 依赖 VB-CABLE，App 当前拒绝虚拟麦 | 仅用于验证，不用于生产 |

## 10. 现有代码可复用部分

| 模块 | 现状 | 方案中的角色 |
|---|---|---|
| 隐藏采集窗口 + 主窗口播放 | 已实现 | 保留，解决麦克风归零 |
| WebAudio 连续播放 | 已实现 | 保留；增加 duck gain |
| TTS 参考 PCM + 时间戳 | 已实现 | AEC far-end 输入 |
| VAD 400ms | 已实现 | 端点判断，不单独决定打断 |
| bare-stop 静音/暂停任务 | 已实现 | 硬打断最终动作 |
| 声纹 sidecar | 已验证干净音频 | AEC 后可选第二道门 |
| 单抽头回声减法 | 离线有效、在线不足 | 可保留为 AEC 失效时的降级 |
| GUI Action Batching 关闭/坐标修复 | 已完成 | 与本方案独立，不要回退 |

## 11. 最终建议

**短期验证顺序：**

1. Windows AEC 探针；
2. XMic / pywebrtc-audio 离线对比；
3. 确认 AEC 有效后，再接 KWS；
4. 最后接 ASR + Interrupt Controller。

**不建议：**

- 继续在混合音频上调声纹/能量阈值；
- 为了打断重写整个语音 Agent；
- 在没有 AEC 验证前直接大规模改播放/ASR 架构。

**演示兜底：**

- 外放 + `Ctrl+Alt+X` / 界面“打断”；
- 或换带杆/指向性麦克风；
- 耳机模式语音打断已可用。

## 12. 参考

- XMic: https://github.com/mengshouer/XMic
- pywebrtc-audio: https://github.com/strands-labs/pywebrtc-audio
- sherpa-onnx KWS: https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html
- sherpa-onnx KWS model: https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2
- Windows AEC control: https://learn.microsoft.com/windows/win32/api/audioclient/
- Hugging Face speech-to-speech: https://github.com/huggingface/speech-to-speech

## 13. Phase 1 实测补充（2026-11-17）

使用真实录音：

- 外放：Realtek `tts-probe.wav`（Qwen TTS，约 9s）；
- 麦克风：`cc ultimate`，44.1k 录制后转 16k；
- 参考：同一段 TTS 16k。

结果：

| 测试 | 结果 |
|---|---|
| 纯回声 AEC | ERLE **42.6dB**，AEC 后接近静音 |
| 用户单独说话 + 远端 TTS 活跃 | AEC 对人声衰减 **-8.2dB**（`EchoCanceller` 与 `AudioProcessor` 相同） |
| 双讲（回声+用户）声纹 | 混合 0.643 → AEC 后 0.344–0.419 |
| ASR：混合音频 | “你好，我叫徐世华，本科长春师范大学…” 基本可转写 |
| ASR：AEC 后 | “徐志华，我是武汉大学毕业…” 出现丢字/改词 |

结论：

1. AEC3 消回声有效，但默认的 near-end suppression/双讲处理会压人声；
2. 对语音识别来说，AEC 输出不一定优于原始混合音频；
3. 不能把“AEC 后直接接声纹/ASR”当成必然正确，需要：
   - 关闭/降低 NS、调整 AEC 双讲策略；
   - 或使用 **Soft barge：AEC 检测到近端后先压低 TTS，再对原始/混合音频做 ASR**；
   - 或对 AEC 输出与原始 near 做可调混合（保留人声，牺牲部分回声）。

因此 Phase 2 不应直接上线实时 AEC，而应先做 **AEC 参数/双讲对照实验**：

- AEC only、AEC+NS、AEC+NS+AGC；
- AEC 输出与 raw near 的混合比例 0/25/50/75%；
- 真实双讲录音（用户实际说“停”“新任务”），而不是合成叠加；
- 以 KWS/ASR 结果为准，不以声纹分数单独判定。
