# cyrvis/memory（规划中）

归属分支：`feat/proactivity`

职责：

- `schema.ts`：记忆条目、来源、置信度、过期时间；
- `store.ts`：短期会话 + 长期偏好/事实，可替换落盘（JSON/SQLite）。

约束：

- 记忆写入要可追溯、可删除；
- 敏感信息默认不长期保存；
- 不把记忆内容泄露到无关日志。

详见 `doc/roadmap.md` 第 4 节。
