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

## advisor（可选功能）

`advisor` 是一个「问更强模型要判断」的工具：主模型在实质开工前、卡住时、准备宣告完成前，带上一个自包含的 context 调用 advisor，拿回一份计划 / 纠偏 / 停止信号（同时写到 `/tmp/pi-sub-<name>/result.md`）。它复用 spawn_sub 的全部基础设施（tmux、watchdog、wait-for、exit 协议），只是给子 agent 换了简报模板、系统提示词，并把工具限制为 `read,write,stop_watchdog`。

**默认不注册**：未配置时主模型看不到这个工具，promptGuidelines 也不注入（零开销）。开启即配置：

- 环境变量 `PI_ADVISOR_MODEL=provider/id:thinking` → 开，且用该模型
- `~/.pi/agent/subagent_advisor.json`（可用 `PI_CODING_AGENT_DIR` 重定向目录）：

  ```json
  {
    "advisor": {
      "model": "anthropic/claude-opus-4-6:high",
      "enabled": true
    }
  }
  ```

  配了 `model` 即视为启用；`enabled: true` 而不配 `model` 则**不开**（advisor 的意义在更强的模型，沿用默认模型没有意义），pi 会在会话里提示补配置；`enabled: false` 显式关闭。

优先级：`PI_ADVISOR_MODEL` 环境变量 > 配置文件 `model`。只配 `enabled: true` 而没有模型不会开启。模型/thinking 由配置决定，调用方不能通过参数传 `--model`。

## 上下文与 token 开销

### 常驻开销（每次对话都在）

工具注册后会进入上下文，模型每一轮请求都能看到。来自 `advisor.ts` 的固定字符串：

| 内容 | 来源字段 | 大约 token |
|---|---|---|
| 工具一句话描述 | `description` | ~24 |
| 系统提示里的一行摘要 | `promptSnippet` | ~21 |
| 何时该用 / 怎么写 context 两条准则 | `promptGuidelines` | ~76 |
| 两个参数的填写说明 | 参数 `description` | ~108 |

合计约 230 token（英文按 ~4 字符/token 估算），外加参数 schema 的 JSON 结构开销。这是一个只要装了扩展就要付的固定成本，与调用次数无关。

### 每次调用的开销（线性累积）

每调用一次 spawn_sub，主会话的对话里新增两条消息：

- **tool call**：模型写的 `question` 和 `context` 参数全文（写多少花多少输出 token，同时也进上下文）。其中 context 是主要的变数：它是子 agent 唯一的背景来源，多花几十到几百 token 写清文件路径和已有结论，能省下子 agent 盲目重新探索的大量开销，通常很划算。
- **tool result**：启动说明 + 等待指引（wait-for 命令、timeout 限时要求、timeout 命中后的 has-session 判读、exit 判读），比改动前的单句说明长，约 100 token。常用运维命令速查表只渲染给你看，不会写进主会话的对话。

### 等待阶段：零 token，但 timeout 机制不是免费的

主会话用 tmux wait-for 这条 shell 命令阻塞等待完成信号。阻塞发生在 shell 进程里，不是让模型反复轮询"好了没有"，所以等待期间不发 API 请求，一个 token 都不消耗。

不过这条命令必须用 bash 工具的 timeout 参数限时（建议 600s）。正常情况下信号会按时到达，但如果出现代码 bug，比如 hook 注册失败、子 agent 挂死，信号可能永远不来，主会话就会永久阻塞。加 timeout 是为了兜住这种异常情况。

timeout 的取值逻辑要兼顾两边：

- 长度不影响 token（等待零成本），影响的只是异常场景的恢复速度。
- 但 timeout 命中后的「判读 + 重等」是一个完整的 tool call 回合：命令文本和结果说明都要进上下文、走一次 API 请求。单次很便宜（几十 token），重试太频繁就把「等待零 token」的优势磨掉了。
- 所以取适中值：600s 够覆盖典型任务（减少重试次数），又在挂死时不会把主会话卡死太久。超大 timeout（如 1800s+）只是把异常恢复推后，没有收益。

另外，timeout 命中后**不能简单地重发 wait-for**：完成信号可能恰好在等待空窗期已发出并被丢弃，重发会永久阻塞。正确判读以会话状态为准：

```bash
TMUX= tmux -L pi-sub has-session -t <会话名>
```

- 会话已消失 = 子 agent 已结束（信号被错过了），直接读 exit/result 判成败；
- 会话还在 = 确实没跑完，再执行一次 wait-for（继续带 timeout）。

这样 timeout 只是一次安全的状态检查，循环下去总能收敛，信号丢失无后患。

### 完成阶段：读回交付物是唯一的大额回流

任务完成后 `read result.md` 会把交付物全文写进主会话的对话。这是子 agent 的产出进入主会话的唯一通道，好处是子 agent 中间读过的文件、跑过的命令都不会带回来，坏处是如果 result.md 写得太长，主会话上下文会一下子变大。这个约束由扩展单方面保证：子 agent 的 brief（`buildBrief`）固定要求交付物「结论优先、克制篇幅」。

### prompt cache 的利弊

API 对同样的对话前缀会缓存折扣价，但缓存有过期时间。委派期间主会话不发请求：短任务等完回来，缓存还在，基本无损；连着等几个长时间子 agent 再回来，缓存已过期，那一整段对话要按全价重新计费 input token。

## 安装

推荐用 pi 的包管理器安装（会自动跑 `npm install`，装好依赖）：

```bash
pi install npm:pi-extension-subagent
```

也可以从 GitHub 直接装（任选一种，`pi install` 写入全局设置，`-l` 写入项目设置）：

```bash
pi install git:github.com/GreenHatHG/pi-extension-tmux-subagent
# 或锚定 tag（之后需手动 pi install <...>@新tag 才会升级）
pi install git:github.com/GreenHatHG/pi-extension-tmux-subagent@v1.0.0
```

临时试用（不写入设置，只对本次运行生效）：

```bash
pi -e npm:pi-extension-subagent
```

管理命令：

```bash
pi list                          # 查看已安装的包
pi update npm:pi-extension-subagent   # 更新这个包
pi remove npm:pi-extension-subagent   # 卸载
```

安装后重启 pi（或 `/reload`）即可生效。

### 手动复制（不推荐）

把 `index.ts` 和 `advisor.ts` 一起放入 `~/.pi/agent/extensions/`（自动发现），重启或 `/reload` 后生效。这些文件只依赖 pi 内置的包（`typebox`、`@earendil-works/pi-tui` 与 pi 核心包都是内置的 peer dependency），所以直接复制也能跑；但如果之后引入了外部依赖，手动复制会漏装依赖，建议优先用 `pi install`。

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
