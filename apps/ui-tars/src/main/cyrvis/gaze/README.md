# cyrvis/gaze（规划中）

归属分支：`feat/gaze`

职责：

- `device.ts`：眼动设备/API 适配；
- `calibration.ts`：校准与误差评估；
- `fusion.ts`：gaze + voice + 屏幕元素融合，输出候选/指针。

约束：

- 默认本地处理，不上传摄像头/眼动原始数据；
- 只向 Controller/VoiceBrain 发结构化事件，不泄漏设备 SDK 类型。

详见 `doc/roadmap.md` 第 3 节。
