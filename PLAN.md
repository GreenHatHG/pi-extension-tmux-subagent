# 方案二落地：预生成 vcc 压缩摘要 + advisor 取证升级为「摘要 + recall」

## 背景

现状：advisor 只拿到 question + 手写 context + recall 检索指引，对主会话记录无全局视野。
目标（用户确认的方案二）：

1. **主会话侧（launch 时）预先 shell 调用 `pi-vcc compact <sessionFile>`**，把压缩摘要写入 advisor 运行目录的一个文件；
2. **简报取证栏目升级为两级**：先 read 预生成的压缩摘要（全局视野），再按需 `recall <关键词>` / `--expand N` 补细节；
3. 系统提示词与边界约束同步放宽（bash 只许跑 pi-vcc 只读子命令）。

## 改动文件

### 1. 新增 `src/modes/vcc.ts` —— compact 的 shell 调用（主会话侧，唯一新增职责文件）

**先回答「vcc CLI 能不能 compact 输出到文件」**：`pi-vcc compact` 本身没有输出文件参数，只有两种出口——
- 默认：压缩摘要打到 **stdout**（`--write` 是另一回事：往主会话 jsonl 追加 compaction entry，不是写摘要文件，且会改动会话文件，不能用）；
- 所以「落盘到文件」由我们这边用 shell 重定向完成：`exec(`${vccCli} compact ${shQuote(sessionFile)} > ${shQuote(outPath)}`)，效果等价于 CLI 原生输出文件。`

```ts
export interface VccSummary { path: string; ok: boolean; error?: string }
export async function runVccCompact(vccCli: string, sessionFile: string, outPath: string): Promise<VccSummary>
```

- `execFile`（shell 模式 `exec(vccCli + " compact " + shQuote(sessionFile))`——vccCli 本身就是用户配置的 shell 命令串）；
- `timeout: 180_000`，`maxBuffer: 32MB`；
- shell 重定向落盘：`exec(`${vccCli} compact ${shQuote(sessionFile)} > ${shQuote(outPath)}`)（CLI 无输出文件参数，stdout 重定向等价；不改 pi-vcc）;
- **任何失败都返回 `{ ok: false, error }` 而不抛**：compact 失败（消息太少 / bun 缺失 / 超时）绝不能阻塞 advisor 启动，简报里降级声明即可；
- 不用 `--write`（不碰主会话 jsonl，纯只读 stdout）。

### 2. `src/modes/briefs.ts` —— `buildAdvisorBrief` 取证栏目改两级

签名不变（见第 3 点，走新的 opts 对象），新增收 `vccSummary?: VccSummary`：

- **有摘要**：取证栏目第一改为「① read ${outPath}——整段会话的 vcc 压缩摘要（主会话预生成，含已发生步骤/结论/命令全貌）」，② recall 按需补细节（保留现有 recall/--expand/#N:path/--page 全套说明），并强调「摘要与 context 冲突时以摘要/取证为准，冲突本身要在结论里点出」；
- **无摘要但 vccCli+sessionFile 齐**（compact 失败或未跑）：保留现有 recall-only 栏目，末尾加一行「也可自行跑 `<vccCli> compact <sessionFile>` 生成摘要（只读 stdout，不加 --write）」；
- 其余降级分支（无 vccCli / 会话未落盘）文案不变。

### 3. `src/modes/types.ts` —— brief 签名收敛为 opts 对象

现 6 个位置参数已到极限，本次加第 7 个会让 task/web-research 的 wrapper 更丑。改为：

```ts
brief(question, context, artifactPath, useWatchdog, opts?: {
  sessionFile?: string; vccCli?: string; vccSummary?: VccSummary;
}): string;
```

- `buildTaskBrief` / `buildWebResearchBrief` 忽略 opts（或改为 `(...args)` 适配，保持零逻辑）；
- `buildAdvisorBrief` 消费 opts。

### 4. `src/launch/launch.ts` —— 启动编排接入 compact

- `opts` 类型扩展：`sessionFile? / vccCli?` 之外新增透传 `vccSummary`；
- 在 `prepareRunDir` 之前（目录需先建）：`sessionFile && vccCli` 时算出 `outPath = join(paths.dir, "vcc-summary.md")`，调 `runVccCompact`；
- 目录提前创建：把 `mkdirSync(paths.dir, {recursive: true})` 提到 compact 之前（`prepareRunDir` 保留写 brief/清 exit 的职责）；
- compact 是唯一的启动前新增延迟（bun 冷启动 ~秒级，180s 上限兜底），失败不重试、不阻塞。

### 5. `src/modes/presets.ts` —— 边界与提示词同步

- `ADVISOR_SYSTEM_PROMPT` 的 bash 条款：`"ONLY for running the pi-vcc CLI (see your brief's forensics section)"` 保持只读语义，措辞从 "recall CLI" 放宽为 "read-only pi-vcc CLI (recall to search the session; compact summary is pre-computed and readable as a file)"；
- 注释同步（`ADVISOR_TOOLS` 的 bash 用途说明）。

### 6. `src/tools/advisor.ts` / `src/index.ts` —— 透传接线

- `index.ts`：launch 回调把 `advisor.vccCli` 与 `sessionFile` 一起传（已实现，仅需随 opts 结构确认）；
- `tools/advisor.ts` execute：不变（sessionFile 取自 ctx）；
- README / CHANGELOG 补一段：advisor 配置 vccCli 后启动时预生成压缩摘要，简报两级取证。

## 不做的事

- 不改 pi-vcc 仓库任何文件；
- compact 不加 `--write`（绝不触碰主会话 jsonl）；
- 不给 task / web-research 模式引入 vcc（ advisor 判断型场景才需要全局摘要）。

## 验证

已用 `--help` + 实测确认的前提：compact 只输出 stdout（无文件参数）；实测一次 compact 秒级完成；exit code 0=成功、1=失败且 stderr 带 `pi-vcc: <reason>`。

1. `bun run build`（或项目现有 typecheck）零错误；
2. 现有测试通过；
3. 手动冒烟：配好 vccCli 的会话里调 advisor，检查运行目录出现 `vcc-summary.md` 且内容为 compact 产物；简报（TUI 展开的「advisor 咨询简报」entry）含两级取证栏目；
4. 故障注入：把 vccCli 改成不存在的命令再调 advisor——应正常启动、简报降级为 recall-only + 自助 compact 提示；
5. 未配 vccCli / 新会话首条消息未落盘：行为与现状一致（降级文案）。
