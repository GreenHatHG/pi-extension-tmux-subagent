# pi-extension-subagent

pi 插件：`spawn_sub` 工具。把多步、耗时久或上下文很重的任务委派给一个隔离运行的 pi 子 agent（跑在专用 socket 的 tmux 会话里），主会话零 token 等待完成信号，然后读取交付物 `/tmp/pi-sub-<name>/result.md`。

## 工作原理

一个子 agent = tmux 里另起的一个 pi 进程。扩展负责：

- 生成任务简报 `brief.md`（目标 + 蒸馏出的会话背景 + 交付物要求）
- 在 tmux 专用 socket `pi-sub` 上后台启动子 agent
- 完成信号经 `tmux wait-for` 送达（阻塞等待，零 token），`pane-died` hook 兜底崩溃场景
- 退出码写入 `exit` 文件，用于区分正常收尾 / 失败 / 异常终止

详细设计见 [index.ts](./index.ts) 头部注释。

## 安装

把 `index.ts` 放入 `~/.pi/agent/extensions/`，重启或 `/reload` 后生效。

## 开发

```bash
pnpm install
pnpm typecheck      # tsc --noEmit
pnpm check:biome    # lint + format 检查
pnpm format         # 自动格式化
```

提交时 `.githooks/pre-commit` 会对暂存文件跑 biome 检查（可自动修复的问题自动修复后重新暂存）。启用 hooks：

```bash
git config core.hooksPath .githooks
```

## License

MIT
