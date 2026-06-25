# AgentBridge 文档索引 / docs

本目录收录 AgentBridge 的架构规格、设计稿与发布流程，按序号编排方便查找。**面向用户的叙述一律中文**；代码/路径/标识符保留原文。中英双语文档成对列出，以中文版为准。

> 历史文档（已被取代或使命完成的设计稿、issue 复盘、测试计划）已合并归档进 [archive/历史归档.md](archive/历史归档.md)，保留追溯价值。

## 活文档（按序号）

| # | 文档 | 说明 |
|---|---|---|
| 01 | [01-协作系统规格-v3.md](01-协作系统规格-v3.md) | **主规格**：多人多仓协作（A）+ 配额池化（B）+ Tailscale 跨网（2026-06 整合版）。新功能落地先读此文。 |
| 02 | [02-v2架构设计.md](02-v2架构设计.md) ／ [中文版](02-v2架构设计.zh-CN.md) | v2 架构（中英双语，以中文版为准）：daemon 收窄为纯消息路由器、Room/身份/message envelope/policy/SQLite 抽象，是 01 的增量基座。 |
| 03 | [03-单机多对.md](03-单机多对.md) | 单机多对（路线 A：Shared-Nothing 多实例）规格与结案报告，已 ship 上线。每对独立 daemon+端口三元组+状态目录。 |
| 04 | [04-额度策略-v3.md](04-额度策略-v3.md) | 额度策略 v3（时间感知动态暂停线 / 三态 admission 闸门 / runway 估计 / 跨套餐分配），已部署。 |
| 05 | [05-额度自动续接.md](05-额度自动续接.md) | 减速线 + 全自动续接设计（guard × bridge 两仓协同），含已落地的 fast-follow / backlog。 |
| 06 | [06-协作协议-v2.md](06-协作协议-v2.md) | Claude × Codex 设计契约（turnPhase 四态 / 幂等键 ACK / 降噪分层），PR A/B0/B 已实施、PR C 待实施。 |
| 07 | [07-Codex-skill集成.md](07-Codex-skill集成.md) | 将协作协议以 Codex 原生 skill 安装的设计稿（draft，含待决 open questions，尚未落地）。 |
| 08 | [08-发布流程.md](08-发布流程.md) | 发布流程：三段式 CI 发布链、secret 配置、本地全局安装四步、daemon 停止策略。 |

## 历史归档

- [archive/历史归档.md](archive/历史归档.md) — 合并了 **10 份有追溯价值**的历史文档：v1 路线图、Issue #37 闭源协议逆向设计稿、2 份故障根因复盘（2026-04-18 / 04-24）、5 份手动 E2E 测试计划（含 fake-codex 复现配方与真机回归步骤）。另有 **5 份无追溯价值**的文档（phase3-spec、multi-pair-guide.html、server-request 施工计划、budget-v3-p3 实施计划、pr-57 测试计划）已直接删除（git 历史仍可查），归档文件开头有说明。
