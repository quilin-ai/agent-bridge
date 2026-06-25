# AgentBridge 文档索引 / docs

本目录收录 AgentBridge 的架构规格、设计稿、发布流程与历史记录。**面向用户的叙述一律中文**；代码/路径/标识符保留原文。中英双语文档成对列出，以中文版为准。

> 状态说明：标 **[活]** 的是当前仍在使用/演进的文档；其余历史记录见底部「历史归档」。`docs/archive/` 下为已被取代或使命完成的存档（保留追溯价值，未删除）。

## 架构与实现规格 / Architecture & Specs

- **[活] [collab-system-spec.md](collab-system-spec.md)** — 协作系统实现规格 v3（整合版）。最新主规格（2026-06-25 PR #185），整合多人多仓 A 场景 + 配额池化 B 场景 + Tailscale 跨网，**取代已删除的根目录旧 spec**，以下方 v2-architecture 为增量基座。新功能落地先读此文。
- **[活] [v2-architecture.md](v2-architecture.md)** / **[v2-architecture.zh-CN.md](v2-architecture.zh-CN.md)** — v2 架构设计（中英双语，以中文版为准）。daemon 收窄为纯消息路由器、Room/身份/message envelope/policy/SQLite 抽象，被 collab-system-spec 引用为底座。
- **[活] [multi-pair.md](multi-pair.md)** — 单机多对（路线 A：Shared-Nothing 多实例）规格与结案报告，已 ship 上线。每对独立 daemon+端口三元组+状态目录，含 slot→port 映射、CLI 用法、并发安全锁。（HTML 渲染版已归档。）

## 额度协调设计 / Budget Coordination

- **[活] [design/budget-strategy-v3.md](design/budget-strategy-v3.md)** — 额度策略 v3 核心设计规格（时间感知动态暂停线 / 三态 admission 闸门 / runway 估计 / 跨套餐分配）。§0 v3.2 addendum 为最新修订层，已部署。
- **[活] [design/budget-auto-resume.md](design/budget-auto-resume.md)** — 减速线 + 全自动续接设计（guard × bridge 两仓协同），含已落地的 fast-follow / backlog 补充。

## 协作协议与集成 / Collaboration Protocol

- **[活] [collaboration-protocol-v2.md](collaboration-protocol-v2.md)** — Claude × Codex 设计契约（turnPhase 四态 / 幂等键 ACK / 降噪分层）。PR A/B0/B 已实施，PR C 待实施。
- **[活] [design-codex-skill-integration.md](design-codex-skill-integration.md)** — 将协作协议以 Codex 原生 skill 安装的设计稿（draft，含待决 open questions，尚未落地）。

## 发布与运维 / Release

- **[活] [RELEASING.md](RELEASING.md)** — 发布流程：三段式 CI 发布链、secret 配置、本地全局安装四步、daemon 停止策略。

---

## 历史归档 / Archive（已被取代或使命完成，保留追溯价值）

> 已统一移入 `docs/archive/`。这些文档对应的功能多已落地或被新规格取代，保留以备追溯。

### 规划与早期交付
- `archive/v1-roadmap.md` / `archive/v1-roadmap.zh-CN.md` — v1 路线图（中英），大部分已落地，演进职责转交 collab-system-spec。
- `archive/phase3-spec.md` — Phase 3 两进程 CLI 产品化交付记录（v1 收尾）。
- `archive/multi-pair-guide.html` — multi-pair.md 的 HTML 渲染版（内容重复）。

### 已实现功能的设计/计划
- `archive/budget-v3-p3-implementation-plan.md` — P3 三态 admission 闸门实施计划，已随 PR #180/#181 落地。
- `archive/issue-37-server-request-passthrough-design.md` — Issue #37 server-request 透传设计稿（v5），代码已落地。
- `archive/2026-03-30-server-request-passthrough-plan.md` — 同 Issue #37 的分步实现计划。

### 历史 issue 复盘
- `archive/issues-2026-04-18-codex-stuck-and-resume.md` — Codex 卡死 + resume 启动失败复盘。
- `archive/issues-2026-04-24-codex-not-initialized-after-silent-reconnect.md` — 静默重连 "Not initialized" 闪退复盘。

### 手动测试计划（多数已执行完）
- `archive/test-plans/budget-coordination.md` — 额度协调 E2E 计划（PR #96）。
- `archive/test-plans/p3-m3b-admission-directive-baton.md` — P3 M3b admission 闸门 E2E 计划（PR #180）。
- `archive/test-plans/round2-round3-e2e.md` — round-2/3 五 PR（#149–#153，v0.1.12）回归计划。
- `archive/test-plans/issue-68-stale-frontend.md` — Issue #68 stale frontend 驱逐 E2E 计划（PR #57 相关）。
- `archive/test-plans/pr-57-close-code-4001.md` — PR #57 单会话准入 + 审批可靠性 E2E 计划。
- `archive/test-plans/pr5-codex-idle-injection.md` — PR5 Codex idle 注入能力探测计划。
