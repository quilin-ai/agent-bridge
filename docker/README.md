# 多机协作模拟（Docker）

用多个容器模拟「多台机器、多个 agent」连同一个常开 broker 协作，验证规格 §13 的跨机切片
（PSK 鉴权可达 + broker 扇出），无需真实多台物理机。

## 拓扑

| 容器 | 角色 |
|------|------|
| `provision` | 注册身份、签发 PSK token 写入共享卷（一次性） |
| `broker` | 常开控制面 broker（一台「服务器机」），WSS + PSK + 扇出 |
| `subscriber` | 一台「agent 机」：鉴权 → 订阅房间 → 等事件 |
| `publisher` | 另一台「agent 机」：鉴权 → 发布 `task_completed` 事件 |

## 跑

```bash
docker compose -f docker/docker-compose.yml up --build --abort-on-container-exit
```

**通过判据**：`subscriber` 容器打印 `SIM_OK` 并以 0 退出——表示 publisher 容器发布的事件
经 broker 跨容器扇出，被 subscriber 容器收到（跨「机」鉴权 + 路由全链路通）。

清理：

```bash
docker compose -f docker/docker-compose.yml down -v
```

## 说明

- 容器仅为模拟共享 `/data` 卷分发 token + DB；真实部署里 token 走带外分发、每台机器各自持
  工作副本（**代码同步是 git 的职责，§2.6；broker 永不传文件**）。
- broker 在容器内绑 `0.0.0.0`（容器网络已隔离）；**跨内网真机请绑 Tailscale 的 `100.x`，
  绝不绑 `0.0.0.0`（§7.3）**。
- 这是 broker 层的跨机切片验证。完整的「多人多 agent 完成事件协作」E2E 需要 Edge adapter
  （后续 PR）与 `task_completed` 语义齐备后再扩。
