# cyrvis/gui（规划中）

归属分支：`feat/gui-accel`、`feat/mcp-tools`

职责：

- `task-router.ts`：意图 → 简单任务直连 / GUI Agent / 反问；
- `simple-tasks.ts`：文件、URL、搜索、剪贴板等确定性执行；
- `mcp-bridge.ts`：MCP client、工具发现、权限、审计；
- `accelerator.ts`：Action Batching、截图去重、loop wait、模型路由。

约束：

- 不直接改 `voice-brain.ts` 内部；通过新增接口接入 Controller；
- 共享类型改动先对齐 `types.ts`；
- 所有工具调用必须有超时、取消、权限与日志。

详见 `doc/roadmap.md` 第 1 节。
