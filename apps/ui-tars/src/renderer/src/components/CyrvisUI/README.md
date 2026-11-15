# CyrvisUI（规划中）

归属分支：`feat/ui`

职责：

- CYRVIS 工作台：语音状态、转写、任务时间线、截图缩略图；
- 麦克风/输出设备选择、耳机/外放切换、打断按钮；
- 首次启动与权限引导；
- Gaze 状态占位（后续接 `CyrvisGaze`）。

约束：

- 只消费 `VoiceUiState` / `ControllerEvent`，不直接调用模型；
- 不阻塞语音主链路；大依赖按需加载；
- GUI 执行时主窗口隐藏，任务信息需同步到 widget 或结束后回放。

详见 `doc/roadmap.md` 第 2 节。
