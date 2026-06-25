# 单机多对 Claude+Codex / Single-Machine Multi-Pair

> **Approach A — Shared-Nothing Multi-Instance**
> 每一对 Claude↔Codex 都是完全隔离的实例：独立 daemon + 独立端口三元组 + 独立状态目录。
> Each Claude↔Codex pair is a fully isolated instance: its own daemon, its own port triple, and its own state directory.

---

## 目录 / Table of Contents

1. [背景与方案 / What Was Built](#背景与方案--what-was-built)
2. [架构 / Architecture](#架构--architecture)
3. [Slot → Port 映射 / Slot → Port Table](#slot--port-映射--slot--port-table)
4. [用法 / Usage](#用法--usage)
5. [底层原理 / How It Works](#底层原理--how-it-works)
6. [并发安全 / Concurrency Safety](#并发安全--concurrency-safety)
7. [升级迁移 / Migration Note](#升级迁移--migration-note)
8. [验证状态 / Verification](#验证状态--verification)

---

## 背景与方案 / What Was Built

### 问题 / Problem

AgentBridge 此前每台机器只能运行 **一对** Claude↔Codex：单个 daemon，固定端口 `4500 / 4501 / 4502`。想同时跑两份协作（比如一份写功能、一份做 review）就会端口冲突、状态互相覆盖。

Previously AgentBridge ran only **one** Claude↔Codex pair per machine: a single daemon on fixed ports `4500 / 4501 / 4502`. Running two collaborations at once (e.g. one for feature work, one for review) caused port collisions and state clobbering.

### 方案 / Solution

每一对 = **一个隔离的 daemon + 它自己的端口三元组 + 它自己的状态目录**。

- **无需改动 daemon 内部逻辑** —— 所有多对（multi-pair）逻辑都落在一个全新的「解析层（resolution layer）」+ CLI 里。
- 这与已废弃的 **PR #81「单 daemon 多 router」（路线 B）** 形成对比：路线 B 让多对共享一个 daemon，导致生命周期状态泄漏（一对的 kill/restart 会污染另一对）。本方案的 shared-nothing 隔离从根上避免了这个问题。

Each pair = **one isolated daemon + its own port triple + its own state dir**.

- **No daemon-internal changes** — all multi-pair logic lives in a new resolution layer + CLI.
- This contrasts with the abandoned **PR #81 "single daemon multi-router" (route B)**, where pairs shared one daemon and lifecycle state leaked between them (killing/restarting one pair corrupted another). Shared-nothing isolation eliminates that class of bug.

> ### 🔑 关键洞察（运行时已验证）/ Key Insight (runtime-verified)
>
> **Claude Code 会把继承到的环境变量原样传给它的 plugin MCP server。** 因此选择「跑哪一对」纯粹靠在启动前设置环境变量即可完成 —— **`.mcp.json` 完全不用改**。
>
> **Claude Code passes inherited environment variables straight through to its plugin MCP server.** A pair is therefore selected purely by setting env vars before launch — **`.mcp.json` is unchanged.**

---

## 架构 / Architecture

两对并排运行，互不干扰 / Two pairs side by side, fully isolated:

```
   abg claude --pair work            abg claude --pair review
   (env: ports + statedir = work)    (env: ports + statedir = review)
            │                                  │
            ▼                                  ▼
   daemon(work)  4500/01/02          daemon(review)  4510/11/12
            │                                  │
            ▼                                  ▼
   codex --pair work                 codex --pair review
     --remote :4501                    --remote :4511
```

每一对都完全隔离，各自拥有独立的 `daemon.pid` / `status.json` / 日志 / `killed` sentinel，统一放在：

Each pair is fully isolated, with its own `daemon.pid` / `status.json` / logs / `killed` sentinel under:

```
<stateDir>/pairs/<pairId>/
```

---

## Slot → Port 映射 / Slot → Port Table

每一对占据一个 **slot**，slot 决定它的端口三元组。规律：第 N 个 slot 在经典基址上 `+ N*10`。

Each pair occupies a **slot**, and the slot determines its port triple. Rule: slot N is offset `+ N*10` from the classic base.

| slot | appPort (`CODEX_WS_PORT`) | proxyPort (`CODEX_PROXY_PORT`) | controlPort (`AGENTBRIDGE_CONTROL_PORT`) |
|:----:|:-------------------------:|:------------------------------:|:----------------------------------------:|
| **0** (第一对 / first pair) | `4500` | `4501` | `4502` |
| **1** | `4510` | `4511` | `4512` |
| **2** | `4520` | `4521` | `4522` |
| **N** | `4500 + N*10` | `+1` | `+2` |

> **注意 / Note：** slot 0 = 经典端口（the classic ports）。所以**单对用户 100% 不受影响** —— 行为与升级前完全一致。
> slot 0 = the classic ports, so a single-pair user is **100% unchanged**.

---

## 用法 / Usage

> 这是最重要的一节。下面所有命令都可以直接复制粘贴。
> This is the most important section. Every command below is copy-pasteable.

### 启动一个命名对 / Start a named pair

终端 1 启动 Claude 侧，终端 2 启动 Codex 侧（两者用同一个 `--pair` 名字配对）：

Terminal 1 starts the Claude side, terminal 2 starts the Codex side (both use the same `--pair` name):

```bash
# Terminal 1
abg claude --pair work

# Terminal 2
abg codex --pair work
```

### 第二个对（自动分配下一个 slot）/ A second pair (auto-assigned next slot)

```bash
# Terminal 3
abg claude --pair review

# Terminal 4
abg codex --pair review
```

`review` 这一对会自动拿到下一个空闲 slot（例如 slot 1 → 端口 `4510/11/12`），与 `work` 对完全隔离。

The `review` pair automatically takes the next free slot (e.g. slot 1 → ports `4510/11/12`), fully isolated from `work`.

### 不带参数：按目录自动推导 / No flag: pair derived from the current directory

```bash
abg claude
```

不带 `--pair` 时，**对的身份由当前目录自动推导**（realpath + 短 hash）。在同一个项目目录里再次运行，会**重连到同一个对**。

Without `--pair`, the pair identity is **auto-derived from the current directory** (realpath + short hash). Running it again in the same project **reconnects to the same pair**.

### 列出所有对 / List all pairs

```bash
abg pairs
```

输出每个对的 `pairId`、slot、端口、cwd、运行/停止状态、pid。脚本场景用 JSON：

Shows each pair's `pairId`, slot, ports, cwd, running/stopped state, and pid. For scripting:

```bash
abg pairs --json
```

停止某个对并释放它的 slot：

Stop a pair and free its slot:

```bash
abg pairs rm <id>
```

### 停止 / Kill

```bash
# 停止所有对（以及任何遗留的旧版单对 daemon）
# Stop ALL pairs (and any legacy single-pair daemon)
abg kill

# 只停 "work" 这一对（保留它的注册表条目 / slot）
# Stop only the "work" pair (keeps its registry entry / slot)
abg kill --pair work
```

### 对身份规则 / Pair identity rules

- **显式 `--pair <name>` 优先 / explicit `--pair <name>` wins。**
- 否则由**目录决定 / otherwise the directory decides。**
- **命名对是全局的 / named pairs are global** —— 跨目录共享同一组端口。
- **目录推导的对是按目录的 / directory-derived pairs are per-directory** —— 每个目录一个独立的对。

---

## 底层原理 / How It Works (env-injection seam)

每个 CLI 命令的最顶端都会先跑一个 **「对解析器（pair resolver）」**：

1. 在跨进程锁（cross-process lock）保护下，到注册表 `<base>/pairs/registry.json` 里**分配 / 查找**这个对的 slot。
2. 然后设置这些环境变量：
   - `AGENTBRIDGE_STATE_DIR`（该对的 state 目录 `<base>/pairs/<id>`）
   - `AGENTBRIDGE_CONTROL_PORT`
   - `CODEX_WS_PORT`
   - `CODEX_PROXY_PORT`
   - `AGENTBRIDGE_BASE_DIR`（注册表 base —— 子进程 `abg pairs`/`kill` 据此解析正确的 registry，而不会误把 per-pair 目录当 base）
   - `AGENTBRIDGE_PAIR_ID`（对的 id，用于诊断 / 写入 status.json）
3. 既有的 `claude` / `codex` / `kill` 代码，以及 daemon，因为**本来就从环境变量读取这些值**，所以无需任何改动就「自动工作」。

A **"pair resolver"** runs at the top of each CLI command:

1. Under a cross-process lock, it **allocates / looks up** the pair's slot in the registry `<base>/pairs/registry.json`.
2. It then sets these env vars: `AGENTBRIDGE_STATE_DIR` (the pair dir `<base>/pairs/<id>`), `AGENTBRIDGE_CONTROL_PORT`, `CODEX_WS_PORT`, `CODEX_PROXY_PORT`, plus `AGENTBRIDGE_BASE_DIR` (the registry base, so child `abg pairs`/`kill` resolve the real registry rather than the per-pair dir) and `AGENTBRIDGE_PAIR_ID` (the pair id, for diagnostics / status.json).
3. The existing claude / codex / kill code and the daemon **just work**, because they already read these from env.

这就是整个特性的接缝（seam）：**靠环境变量注入，而不是改动核心代码。**

This is the entire seam of the feature: **env-injection, not core-code surgery.**

---

## 并发安全 / Concurrency Safety

- **两个 `abg claude` 同时启动不会撞车 / Two `abg claude` started at the same time can't collide。** Slot 分配由一个**原子锁文件（atomic lock file，靠 `link(2)`：先写临时文件,再 `link` 到锁路径,EEXIST 即已持有)**串行化,锁内含 owner pid + nonce。陈旧锁回收**只针对已死的 owner**(绝不抢占活进程的锁,以免恢复后写回旧 registry 造成 lost update);回收本身还经一个独立的 serialized reclaim lock + 重新确认 owner 已死后才删,杜绝并发 evict 活锁。Stale recovery is by **process liveness, not TTL**.
- **端口会被探测 / allocated ports are probed。** 如果某个外部进程占用了目标端口，你会得到一个清晰的 **`PAIR_PORTS_BUSY`** 错误，而不是悄悄连到错误的端口（silent wrong-port connection）。

---

## 升级迁移 / Migration Note

> ### ⚠️ 升级后请执行一次 / Run once after upgrading
>
> 升级到多对版本后，如果还有一个**旧版（pre-multi-pair）daemon** 在跑，请执行一次：
>
> After upgrading, if an old (pre-multi-pair) daemon is still running, run once:
>
> ```bash
> abg kill
> ```
>
> 新代码会**检测到这个 legacy-root daemon 并给出引导**。
> The new code detects the legacy-root daemon and guides you.

---

## 验证状态 / Verification

全部通过。 / All green.

| 项 / Item | 状态 / Status |
|---|---|
| 单元测试（pair-registry / concurrency / resolver / command）/ Unit tests | ✅ pass — 含 8 进程并发 + seeded-dead-lock 锁测试，20+ 次 stress 0 碰撞 |
| 类型检查 + 全量测试 + 插件同步（`bun run check`）/ Type check + full suite + plugin sync | ✅ 334 pass / 0 fail，typecheck clean，bundles in sync，version-aligned 0.1.6 |
| 真实双对运行时 E2E（Codex sandbox，仓库原脚本无 workaround）/ Real two-pair runtime E2E | ✅ pass — pair `a`=slot2 (4520/4521/4522, pairId "a")、pair `b`=slot3 (4530/4531/4532, pairId "b")；端口/state/日志隔离；`kill --pair a` 只停 a，b 仍 LISTEN；`kill --all` 后 4520-4532 全清 |
| 交叉评审（Claude×2 全新 reviewer + Codex / 轮）/ Cross-review | ✅ 8 轮迭代收敛到连续 2 轮 0 真实 issue（第 7、8 轮）+ post-gate packaging delta focused 复审 0 issue |

真实修掉的 bug（交叉评审捕获）/ Real bugs caught & fixed by cross-review:
- 跨进程锁竞争（3 次迭代：发布窗口 → CAS → reclaim-lock 串行化 + dead-pid-only + nonce）
- `AGENTBRIDGE_STATE_DIR` 双重语义（引入 `AGENTBRIDGE_BASE_DIR`）
- 空字符串 env 被当有效路径
- `kill --help` / 未知 flag 误落 kill-all
- pair-scoped 命令提示（bridge / disabled-state / codex / kill / SessionStart health-check.sh）
- packaging：`build:cli` 未产 `dist/daemon.js` + daemon entry 默认
