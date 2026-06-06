# AgentBridge × AgentQuotaGuard 集成：预算感知的双 Agent 协调层（v2.2 · 终版）

> **版本说明**：v1 = 远端 ultraplan 产出。v2 = 三方汇总版。v2.1 = 交叉 review 第 1 轮修订（Codex 3 REAL 全采纳 + Claude 侧 2 REAL，1 条驳回有证据）。**v2.2 = 第 2 轮终版**——第 2 轮 Codex 复核 **0 REAL**，本版折入其 3 条 RECOMMEND（rate-limit 结果不得丢 null / config 边界保护 / stop() timer 测试）与 SUSPECT 措辞收紧（transport-accepted ≠ applied），并锁定分支基线。**方案已过双方共识门，进入实施。**
>
> **Round-1 修订摘要**：① R4 进入/解除统一用 `gateUtil`（resettable hard winner）② probe 双形状归一化（bash `hard_util` / node 无此字段）③ capability probe 措辞降级（turn/started 不含 model）④ probe 解析序收紧 ⑤ 新增 `pauseAt=90`（先于 per-agent 硬线 92）⑥ **取消 park 转达**（消除闸门时序洞 + 省一轮 Codex 额度）⑦ R4 自动唤醒声明依赖 push 模式 ⑧ `rate_limited_until > now` ⑨ start() 立即首轮 poll ⑩ balance/parallel 并发合并文案 ⑪ `budget` 进 PAIR_AWARE_COMMANDS ⑫ 无 attached Claude 的 paused 可见性验收 ⑬ 重启重推导（容忍单次重复 STOP）。

## Context（为什么做这个）

AgentBridge 已能让 Claude Code 与 Codex 协同执行长任务，但**两边都对订阅额度无感**：跑一半某一边 Token 先耗尽、任务卡死、甚至只剩一边空转。`agent-quota-guard`（零依赖 ESM，**尚未发布 npm**）已能让**单个** agent 感知自己的 5 小时 / 周额度并在轮末干净暂停 + checkpoint，但它是**单边、per-agent** 的——看不到对方，也无法跨 agent 协调。

AgentBridge 的 daemon 是机器上**唯一同时看到 Claude 与 Codex 两侧**的长生命周期进程，天然就是缺失的「预算协调层」。本方案在 daemon 内新增 **BudgetCoordinator**：周期性探测双方额度 → 计算联合决策 → 通过既有消息通道下发协调指令、并在耗尽时**在 bridge 层强制暂停/唤醒**。

### 关键事实（已读源码确认；行号截至 2026-06-06）

- `agent-quota-guard` 探针 `fetchUsage(agent)`（`lib/probe/index.mjs`）按 claude / codex 分别返回归一化数据：`buckets[]` 含 5h（`primary_window`/`five_hour`）与周（`secondary_window`/`seven_day`），带 `util`（**resettable hard winner**，`lib/probe/claude.mjs:152-168`）、`warn_util`（**全桶含 non-resettable 的 max**）、`reset_epoch`、`rate_limited_until`；缓存 45s TTL、永不抛异常（fail-open）。
- **【v2.1】探针双形状不同形**：bash 安装版 `~/.budget-guard/bin/budget-probe --agent <agent>` 输出含 `hard_util`（`codex-budget-guard/budget-probe:214-224, 252-263`）；Node `bin/probe.mjs <agent> probe` 直接输出 `fetchUsage()` 结果，**无 `hard_util` 字段**（`bin/probe.mjs:52-54`）。两者均已部署在 `~/.budget-guard/bin/`（ls 实证）。quota-source 必须做字段回退归一化。
- quota-guard 已自带**单边** hook（T1=80/T2=90/T3=92 硬线，硬线写 `pending/<agent>_<scope>.json` + checkpoint）。**【v2.1 实证】Claude 侧 PreToolUse/PostToolUse 的 matcher 为 `Bash|Edit|Write|MultiEdit|NotebookEdit`（~/.claude/settings.json），不含 MCP 工具 → bridge 的 `reply`/`get_budget` 调用不会被 guard 硬线拦截**；Stop hook（matcher 全量）在硬线时 `continue:false`。
- **Codex 侧可强制 per-turn 切模型/effort**：`~/repo/codex/codex-rs/app-server-protocol/src/protocol/v2/turn.rs:85-99` —— `TurnStartParams` 含 `model: Option<String>` 与 `effort: Option<ReasoningEffort>`，注释明确 *"this turn and **subsequent turns**"*（**sticky 语义**）。本机 codex-cli 0.137.0。**【v2.1】但 `TurnStartedNotification` 只含 `thread_id` + `turn`（turn.rs:312-315；bespoke_event_handling.rs:171-177），无法从中观测 applied model/effort**。
- **Claude 主会话不可外控**：`set_model`（claude-code `controlSchemas.ts:140`）仅对 SDK 宿主有效；交互 TUI 下只有用户能 `/model` `/effort`。Claude 侧真实强杆 = **Task 工具 per-call model 参数**（subagent 分层 haiku/sonnet/opus）。
- **模型分层真省额度**：Claude 订阅 usage API 存在独立 `seven_day_sonnet` 桶（本机 usage_claude.json 亲见）。
- **唤醒链（push 模式）可行**：daemon `emitToClaude` push 通道可唤醒空闲 Claude 轮次（本会话实证）。**【v2.1 实证】pull 模式（`AGENTBRIDGE_MODE=pull`，claude-adapter.ts:156-158）只入队不唤醒** → R4 自动唤醒**依赖 push 模式（默认）**；pull 模式下 RESUME 静默入队、依赖 Claude 主动 `get_messages` 或 P5 watchdog。daemon 消息缓冲（100 条）不跨重启持久化。

## 诚实的能力边界

| 诉求 | 机制 | 强度 |
|---|---|---|
| 1 额度同步 | 探测双方 → 算漂移 → 下发「你 A%，对方 B%」指令 | 数据真实，执行建议性 |
| 2 动态并行 | 高剩余 + 临近结算 → 下发「拆更多 sub-agent 并行」 | 建议性（bridge 不能替 agent spawn） |
| 3 负载均衡 | effective util 漂移 → 下发「多分给 lighter 一侧」 | 建议性，Claude 委派时据此路由 |
| 4 耗尽暂停/唤醒 | **bridge 层强制**：暂停闸门 + STOP/RESUME + 唤醒轮询，叠加 quota-guard 单边 hook（backstop） | **强制（最强项）**；自动唤醒依赖 push 模式 |
| 5 模型/effort 分级 | **Codex 侧：turn/start 带 `model`/`effort`，可强制**（sticky，策略期管理 + 接受性探测 + `codexTierControl` 默认关）；Claude 侧：subagent 分层建议 + 用户手动 /model /effort + watchdog 重启级 `--model --effort` | Codex 强制 / Claude 建议（**诚实非对称**） |

> bridge 无法强行更改运行中 Claude 主会话的模型、也无法替任一 agent spawn sub-agent。诉求 4 是真正可强制的闭环；诉求 5 在 Codex 侧可强制、Claude 侧建议性。

## 架构

```mermaid
flowchart TD
  subgraph QG[agent-quota-guard（外部，零依赖）]
    PB["budget-probe / fetchUsage()<br/>claude & codex 各自<br/>5h% · 周% · reset · rate_limit"]
  end
  subgraph D[daemon.ts（常驻，唯一双向可见）]
    QS[quota-source.ts<br/>探测适配·双形状归一化·fail-open→null]
    BS["budget-state.ts<br/>computeBudgetState() 纯函数<br/>phase: normal/balance/parallel/paused"]
    BC[budget-coordinator.ts<br/>轮询(启动即首测)·去重·暂停/唤醒生命周期]
    GATE{{claude_to_codex<br/>暂停闸门}}
  end
  subgraph FE[bridge.ts（前台 MCP）]
    CA["claude-adapter.ts<br/>get_budget 工具 + 指令推送"]
  end
  PB -->|spawn| QS --> BS --> BC
  BC -->|emitToClaude 指令| CA -->|push notify / get_budget| Claude
  BC -->|isPaused| GATE -->|被暂停时拒绝注入<br/>+ 理由 + 恢复时刻| Claude
  BC -->|R5 策略：model/effort 档位| GATE
  BC -.->|DaemonStatus.budget 快照| CA
```

### 决策指标（v2.1 统一口径）

- **`gateUtil(agent)` = probe 的 `util`（resettable hard winner）** —— R4 暂停/解除**唯一**门控指标。非 resettable 桶不参与门控（等不来刷新，由 guard 单边 hook 兜底）。
- **`warnUtil(agent)` = probe 的 `warn_util`（全桶 max）** —— 仅用于 R1/R3 parity 展示与均衡决策：`drift = warnUtil(claude) − warnUtil(codex)`。
- **暂停进入**：任一侧 `gateUtil ≥ pauseAt(90)` **或** `rate_limited_until > now`。
- **暂停解除**：**双方** `gateUtil < resumeBelow(30)` **且** 双方 `rate_limited_until ≤ now`；唤醒轮询在各自 `reset_epoch` 过点时强制重探（绕过缓存 TTL）。
- **阈值分层设计**：`pauseAt=90` **刻意低于** guard 单边硬线 92 —— bridge 协调暂停先行（留 2% 的收尾预算），guard 92 硬线作为逃逸 backstop；T1/T2 提醒仍归 guard。
- 决策优先级：`paused` → `balance`（|drift| > syncDriftPct）→ `parallel`（双方剩余 > minRemainingPct 且最近 5h 桶距结算 < timeWindowSec）→ `normal`。**balance 与 parallel 同时成立时合并为一条指令**（「lighter 一侧多承担并行子任务」），避免 R2 被优先级吞掉。

## 明确不做的事（v1 范围外，防 scope 漂移）

1. **不 standalone 注入 Codex**：每次 `turn/start` 注入 = 烧一轮 Codex 额度 + 污染 thread。协调指令只发 Claude。
2. **【v2.1】暂停时不要求 Claude 向 Codex 转达 park**：Codex 是 turn-based——没有输入就没有消耗，「不发消息」本身就是 park；其 mid-turn 场景由它自己的 quota-guard hook 在轮末停。这消除「STOP 让 Claude 发 reply、闸门又拦 reply」的时序矛盾，并省一轮 Codex 额度。RESUME 后由 Claude 首条带上下文的 reply 自然唤醒 Codex。
3. **不自动 spawn 进程/pair**：动态并行是建议，由 agent 自己拆 sub-agent。
4. **不加 npm 依赖**：quota-guard 未发布 npm，daemon bundle 保持零外部依赖；lib import 路径仅 `AGENTBRIDGE_QUOTA_PROBE` 显式指定时启用。
5. **不假装能控 Claude 主模型**（TUI 无 set_model 入口）。
6. **pause 态不持久化**：daemon 重启后由启动即刻的首轮探测重新推导；代价是可能重发一次 STOP 指令（幂等语义：「checkpoint + 停止委派」重复执行无害），P1 单测覆盖。

## 新增文件（`src/budget/`）

1. **`src/budget/quota-source.ts`** — 探测适配器，fail-open → null。
   - 接口：`fetchBoth(): Promise<{ claude: AgentUsage|null; codex: AgentUsage|null } | null>`，spawn 带超时（默认 10s）。
   - **解析优先级（v2.3 修订，P0 实施期实证推翻 v2.1 收紧）**：① `AGENTBRIDGE_QUOTA_PROBE` / `BUDGET_PROBE` env 显式命令；② `~/.budget-guard/bin/budget-probe --agent <agent>`；③ **per-agent 回退** `~/.budget-guard/bin/probe.mjs <agent> probe`；④ null。回退理由（2026-06-06 本机实证）：bash budget-probe 对 claude 已 schema 漂移（`ok:false "no Claude usage buckets found"`），对 codex 正常；node probe.mjs 两侧均正常——bash 解析器跟不上 Claude usage API 演进，node lib 是被维护的实现，必须留 per-agent 回退。
   - **归一化（v2.1，双形状兼容）**：`hardUtil = raw.hard_util ?? raw.util ?? 0`；`warnUtil = raw.warn_util ?? hardUtil`；`gateUtil = raw.util ?? raw.hard_util ?? 0`；`rateLimitedUntil = raw.rate_limited_until ?? 0`。
   - **【v2.2】`ok:false` 但携带有效 `rate_limited_until` 的 probe 结果不得当普通失败丢成 null**——必须保留为 `AgentUsage`，让 R4 能按 `rate_limited_until > now` 暂停（probe 确会返回此形状：`lib/probe/index.mjs:301-308, 319-325`）。仅当完全无数据时才 null。
   - `AgentUsage`：`{ ok, stale, gateUtil, warnUtil, fiveHour:{util,resetEpoch}, weekly:{util,resetEpoch}, remaining, rateLimitedUntil, fetchedAt }`。
   - 5h/周分桶：bucket id 子串映射（`primary_window`/`five_hour`→5h；`secondary_window`/`seven_day`→周），回退按 `reset_after_seconds` 排序。
2. **`src/budget/budget-state.ts`** — `computeBudgetState(claude, codex, cfg, now): BudgetState` 纯函数（零 I/O、`now` 入参）。输出 `{ phase, now, perAgent, drift:{pct,heavier,lighter}, pause:{active,side,reason,resumeBelow,resetEpochs}, parallel:{recommended,reason}, effort:{claudeAdvice, codexTier}, directiveToClaude: string|null }`。指令文案中文，含具体百分比与 reset 时刻、标注「账号级额度」。`rate_limited` 判定一律 `rate_limited_until > now`。
3. **`src/budget/budget-coordinator.ts`** — 有状态编排器，注入式依赖（`{ source, config, emit, onPauseChange, now, log }`）：
   - `start()`：**立即执行首轮探测**（消除启动到首 tick 间的 fail-open 窗口），随后每 `pollSeconds` 轮询 → `computeBudgetState` → phase/材料变化才 `emit(systemMessage("system_budget_*", directive))`，去重仿 `fingerprint.mjs`（key=phase+heavier+bucketReset；**仅内存**，重启后允许单次重发）；每 tick 更新快照并触发 `DaemonStatus.budget` 广播。
   - 暂停生命周期：进入 `paused` → `onPauseChange(true)` + 向 Claude 发 STOP 指令（**只要求：写 checkpoint + 停止委派/收尾**；不要求转达 Codex）→ 唤醒轮询（各自 reset 过点强制重探）→ **双方** `gateUtil < resumeBelow` 且无 rate-limit → `onPauseChange(false)` + RESUME 指令（push 模式唤醒空闲 Claude；**pull 模式只入队并记 warning 日志**）→ Claude 首条 reply 自然唤醒 Codex。
   - R5 策略：`codexTier`（`full|balanced|eco` → model/effort 档位映射，phase 驱动），暴露 `getCodexTurnOverrides(): {model?, effort?} | null`；**sticky 管理**：档位变化进入「策略期」、恢复 `full` 时显式带恢复参数发一次；**接受性探测（v2.1 降级措辞）：以 `turn/start` 无 JSON-RPC error 判定参数被接受并记日志——`turn/started` 通知不含 model/effort，无法确认 applied 值**。
   - `isPaused()` / `getSnapshot()` / `stop()`。

## 修改文件

- **`src/config-service.ts`** — `AgentBridgeConfig` 加可选 `budget` 段并入 `DEFAULT_CONFIG` + `normalizeConfig`：`{ enabled:true, pollSeconds:60, pauseAt:90, resumeBelow:30, syncDriftPct:10, parallel:{minRemainingPct:60,timeWindowSec:3600}, codexTierControl:false }` + `AGENTBRIDGE_BUDGET_*` env 覆盖。（T1/T2 提醒阈值不归 bridge——那是 guard 的职责，不重复配置。）**【v2.2】归一化边界保护**：非法组合（如 `pauseAt ≤ resumeBelow`、越界百分比）→ 回退默认值并记日志（现 `normalizeInteger` 为宽松解析，`config-service.ts:52-59`），加测试覆盖。
- **`src/daemon.ts`** — ① `bootCodex` 成功后构造 `BudgetCoordinator`（`emit=emitToClaude`），codex `ready` 后 `start()`、`shutdown()` 里 `stop()`；② `claude_to_codex` 分支（daemon.ts:397 case 内）在 busy-guard（:430 同形态）旁加**暂停闸门**：`coordinator.isPaused()` → `{success:false, error:<预算暂停理由+预计恢复时刻>}`，置于 `codex.injectMessage`（:428）之前；③ 注入时若 `codexTierControl` 且有档位 → `injectMessage(text, coordinator.getCodexTurnOverrides())`；④ `currentStatus()` 增补 `budget?: BudgetSnapshot`。
- **`src/codex-adapter.ts`** — `injectMessage(text: string, overrides?: {model?: string; effort?: string})`（现签名 :347 仅 text）：有 overrides 时在 `turn/start` params 加 `model`/`effort`（协议字段为 `Option`，老版本 serde 忽略未知字段 → 天然降级；无 error = 接受，记日志）。
- **`src/control-protocol.ts`** — `DaemonStatus`（:14）增 `budget?: BudgetSnapshot`（复用既有 `status` 广播，无新 control 消息类型）。
- **`src/claude-adapter.ts`** — ① 新增 MCP 工具 `get_budget`（返回缓存快照：双方 5h/周 % / gateUtil / warnUtil、漂移、phase、暂停态与预计恢复时刻、并行/effort 建议，渲染为中文）；② `setBudgetSnapshot()` 由 bridge status 处理器写入；③ `CLAUDE_INSTRUCTIONS` 补 `get_budget` 用法。
- **`src/bridge.ts`** — `daemonClient.on("status")` 把 `status.budget` 写入 `claude.setBudgetSnapshot()`。
- **`src/collaboration-content.ts`** — `CLAUDE_MD_SECTION` 与 `AGENTS_MD_SECTION` 各加「预算感知协作」子节：5 种行为说明、`get_budget`（Claude）、收到 budget-pause 指令时 Claude 应 checkpoint+停止委派（闸门会拒绝期间的 reply，错误信息含恢复时刻，**不要重试**）、Codex 侧说明「pause 期间不会收到新 turn；自身 quota-guard hook 照常生效」、R5 分层规则（Claude subagent：haiku=机械活/sonnet=常规/opus=架构；Codex effort 档位含义）。
- **`src/cli.ts` + 新增 `src/cli/budget.ts`** — `abg budget [--json] [--pair <name>]`；**`PAIR_AWARE_COMMANDS`（cli.ts:23）加 `"budget"`**。读 daemon status 的 budget 快照打印；daemon 未跑/无快照时友好提示。

## 分阶段交付（单 PR 内按阶段 commit，每阶段过测试再进下一阶段）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 感知层** | quota-source + budget-state 纯函数 + `DaemonStatus.budget` + `get_budget` + `abg budget`（pair-aware） | probe 缺失 fail-open 全静默；fixture 单测覆盖 4 phase + **双 probe 形状**（bash 含 `hard_util` / node 无）+ 双 provider 分桶 |
| **P1 联合暂停/唤醒（R4）** | coordinator（启动即首测）+ STOP/RESUME 指令 + 暂停闸门 + 唤醒轮询 | fixture 任一侧 gateUtil≥90 → STOP 下发、reply 被闸门拒（错误含恢复时刻）；双方 <30 → RESUME 下发、闸门放开；**coordinator 重建（模拟 daemon 重启）后重推导 paused、允许单次重复 STOP**；**无 attached Claude 时 status/abg budget 仍显示 paused，重新 attach 后从 buffer 收到 STOP**；rate-limited 过期（`until ≤ now`）不触发暂停 |
| **P2 均衡+同步（R1/R3）** | warnUtil drift 计算 + 倾斜指令 + fingerprint 去重 | 40/20、20/40 fixture 正确倾斜且重复 tick 不刷屏 |
| **P3 动态并行（R2）** | parallel 推荐 + 指令；与 balance 并发时合并文案 | 边界 fixture（59%/61% × 59min/61min）触发正确；drift+parallel 同时成立 → 单条合并指令 |
| **P4 模型/effort（R5）** | codex-adapter overrides + 协议文本分层规则 + 接受性探测 | 单测：overrides 正确序列化进 `turn/start` params、档位变化只发一次、恢复 full 显式下发；真机（0.137.0）：注入无 error + 人工经 Codex TUI `/status` 确认模型变化；`codexTierControl` 关闭/老版本零影响 |
| **P5 无人值守（跨仓库，单独 PR 到 agent-quota-guard）** | pending payload 加 `pair_id/state_dir/thread`；watchdog pair-aware（同 pair 串行恢复：先 daemon/Codex 后 Claude）；`abg resume`；**兼顾 pull 模式的唤醒兜底** | tmux E2E：睡前任务→双侧 park→刷新→watchdog 拉起 pair 续跑 |

> P0–P4 = agent_bridge 仓库一个 PR（`feat/budget-aware-coordination`）。P5 = agent-quota-guard 仓库独立 PR，本 PR 合并后做。

## 测试（遵循「每模块一 test 文件」约定）

- `src/unit-test/budget-state.test.ts`：场景表——sync 漂移、parallel 机会、balance+parallel 并发合并、单侧暂停（gateUtil 门控）、**warnUtil 高但 gateUtil 低不触发暂停**（non-resettable 桶不门控）、双侧耗尽、rate-limited（`until > now` 触发 / `until ≤ now` 不触发）、normal、单侧探测失败（null）。
- `src/unit-test/quota-source.test.ts`：**bash 形状（含 hard_util）与 node 形状（无 hard_util）双 fixture 归一化**、5h/周分桶（两 provider）、无 source fail-open→null、spawn 超时。
- `src/unit-test/budget-coordinator.test.ts`：假时钟+假 source——start 即首测、指令去重、暂停→闸门→唤醒生命周期、重建后重推导（允许单次重复 STOP）、`onPauseChange` 回调、R5 档位变化只发一次 override + 恢复 full 显式下发、**【v2.2】`stop()` 取消所有 poll/wake timer（shutdown 后无残留轮询）**、rate-limited-only usage（ok:false）仍触发暂停。
- 扩展 `config-service.test.ts`（budget 默认/归一化/env 覆盖）、collaboration 相关测试（新指南断言）、daemon 接线断言（暂停态 `claude_to_codex` 拒绝注入；overrides 透传）、cli 测试（`budget` pair-aware 解析）。
- 新增 `src/unit-test/e2e/budget-coordination.md` E2E 测试计划。

## 验证（端到端）

1. `bun run typecheck && bun test src`。
2. `bun run build:plugin` → `src/budget/*` 打进 `daemon.js`、无外部依赖内联。
3. fixture 驱动手测：`AGENTBRIDGE_QUOTA_PROBE` 指向固定 JSON 脚本，构造 4 phase 起真实会话：normal 静默 / drift 倾斜 / parallel 指令 / gateUtil≥90 STOP+闸门拒 / 双方<30 RESUME+闸门开。
4. `get_budget` 与 `abg budget` 输出一致（含 pair-aware）。
5. `bun run check` 全绿后提交。

## 风险与缓解（v2.1 修订）

1. **turn/start override 是 sticky 的**——策略期管理 + 恢复显式下发；`codexTierControl` 默认关（paused 期间 Codex 无输入即无消耗，tier 控的是 normal 期经济性，默认关是 sticky+版本不确定下的保守选择）。
2. **探针不可用 / 形状漂移**：fail-open→null + 双形状归一化回退；绝不阻断既有协作。
3. **额度是账号级不是 pair 级**：指令文案如实标注，不做虚假精确。
4. **双侧 reset_epoch 不一致**：解除需双方达标（保守换一致性，防协作状态分叉）。
5. **pull 模式自动唤醒失效**：R4 自动唤醒依赖 push（默认）；pull 模式记 warning 日志 + 文档声明 + P5 watchdog 兜底。
6. **指令刷屏 / 重启重复 STOP**：内存去重 + 材料变化才发；重启允许单次幂等重发（文档化 + 测试覆盖）。
7. **版本偏移**：当前版 `TurnStartParams` 无 `deny_unknown_fields`（turn.rs 实证），**但「老版本未知字段静默忽略」是合理推断而非跨版本实证** → 无 JSON-RPC error 仅记为 *transport accepted*（不承诺 applied）+ 日志；`codexTierControl` 默认关。不报错不阻断。
8. **与 guard 阈值耦合**：bridge `pauseAt=90` 刻意先于 guard 硬线 92（收尾预算），guard 是逃逸 backstop；两套阈值独立配置、文档写明关系。

## Git 与分工

- **【v2.2 锁定】分支 `feat/budget-aware-coordination` 基于 `feat/kill-scope-and-log-hardening`（PR#96 栈顶）**——本计划所有已实证 file:line（cli.ts:23 PAIR_AWARE_COMMANDS、daemon.ts:397/428/430、pair registry 等）均验证于该树；origin/master（b79dc69）尚无多 pair 结构，不可作基线。随 #94→#95→#96 栈合并逐级 retarget master（沿用 #95 先例）。PR 双语，附单测 + E2E plan。
- **分工（Codex 已确认接受）**：
  - **Codex（implementer）**：`src/budget/quota-source.ts`、`budget-state.ts`、`budget-coordinator.ts` 及三个单测文件。约定：`budget-state` 按本文件 v2.1 的 `gateUtil` 口径实现；`quota-source` 单测必须覆盖两种 probe JSON 形状。
  - **Claude（orchestrator）**：daemon/bridge/claude-adapter/codex-adapter/control-protocol 接线、config-service、collaboration-content、`cli/budget.ts` + `PAIR_AWARE_COMMANDS`、E2E plan、build/plugin 验证、全部 git 操作。
  - **Review gate**：Claude review Codex 模块、Codex review Claude 接线；每阶段合入前再过仓库硬规则的 2 个全新 subagent cross-review 循环（连续两轮 0 真实 issue 才 commit）。
- 双方在 `/Users/raysonmeng/repo/agent_bridge` 同一 checkout 的 feature 分支上工作（文件集正交）；Codex 禁写 `.git`，提交全部由 Claude 执行。
