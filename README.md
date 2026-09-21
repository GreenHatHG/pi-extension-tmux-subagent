# pi-extension-subagent

pi 插件：`spawn_sub` 工具。把多步、耗时久或上下文很重的任务委派给一个隔离运行的 pi 子 agent（跑在专用 socket 的 tmux 会话里），主会话零 token 等待完成信号，然后读取交付物 `/tmp/pi-sub-<name>/result.md`。

## 工作原理

### 心智模型

一个子 agent 就是在 tmux 里另开的一个 pi 进程。它收到一份任务简报（brief.md），把最终结论写到
result.md，结束时发一个信号通知主会话。除此之外的细节（watchdog、钩子、退出码、socket）都是实现手段。

`spawn_sub` 工具把多步或上下文很重的任务委派给一个隔离的 pi 子 agent。

### 运行时文件

运行时靠文件传递真相（LLM 只声明意图，shell 命令负责确定性的动作）：

```
/tmp/pi-sub-<name>/
  ├── brief.md    主会话启动前生成：任务目标 + 从主会话蒸馏出的背景 + 工具使用策略
  │               + 交付物要求 + 行为边界
  ├── result.md   子 agent 写的交付物。等待方以 exit 文件判断这次委派成败
  ├── exit        子 agent 的退出码，由 pane 里的 shell 写入：0 = 正常收尾；
  │               非 0 = 失败；文件不存在 = 进程被强杀或崩溃
  └── log         子 agent 的 stdout 日志（交互式 pi 的 TUI 输出，主要用于排查）
```

### 启动与收尾流程

全部用 tmux 自带功能，扩展本身不做额外魔法：

1. 用 tmux 新开一个后台 session 运行子 agent：

   ```bash
   TMUX= tmux -L pi-sub -e PI_WATCHDOG=… [-e PI_WATCHDOG_ON_STOP=…] new-session -d \
     'pi "Read the brief at …" ; echo $? > exit'
   ```

   - 子 agent 用交互式 pi 启动，任务做完不会自己退出进程，所以额外注入 ON_STOP
     钩子：子 agent 调用 `stop_watchdog` 停止监控时，由扩展本地直接把退出码 0 写进 exit 文件，
     再用 wait-for 发完成信号。这样不需要子 agent 再跑一轮 bash 命令（之前试过，遇到 API 429
     故障时等待方会永久挂起，踩过坑）。

2. 再注册一个 pane-died 钩子兜底：子 agent 进程异常退出（崩溃/被杀）时也发完成信号。等待方
   发现 exit 文件缺失，就能识别出这是异常终止。

3. 主会话用 `tmux wait-for` 阻塞等待完成信号（零 token 消耗），完成后 read result.md。

### 注意事项

- **查看子 agent 的执行过程**：委派完成后子 agent 进程会关闭，tmux 会话随之消失，主会话连不上去。如果想回看它做了什么，读 pi 的会话历史 jsonl（`~/.pi/agent/sessions/<按工作目录分目录>/`）。
- **沙盒环境下的嵌套**：如果主会话的 pi 是在沙盒（如 SRT 限制）里启动的，子 agent 继承同样的环境，也会受沙盒限制（例如无法写 `~`、无法访问网络等）。

### 嵌套

子 agent 自己也会加载本扩展，所以 spawn_sub 对子 agent 同样可用（未限制嵌套深度，谨慎 fan-out）。

## 安装

把 `index.ts` 放入 `~/.pi/agent/extensions/`（自动发现），重启或 `/reload` 后生效。

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
