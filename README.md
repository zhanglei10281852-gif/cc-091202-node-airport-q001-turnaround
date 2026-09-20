# 航班过站运行协同服务

面向航司驻场运行协调员的短停过站协同服务：把航班航段、保障任务、前后依赖、
计划窗口与责任单位组织成可追踪时间线；汇聚各单位乱序、重复的进度上报；
持续计算当前关键路径与最早可关舱时刻；并解释每个航班**为何预计延误、
哪个环节正在阻塞、最近一次有效上报是什么**。

所有业务时刻均为带偏移量的 ISO 8601 字符串（如 `2026-09-12T08:37:00+08:00`）。

## 核心语义

- **事件溯源**：计划与上报一律作为不可变事件追加到只追加日志（`data/events.jsonl`）。
  当前状态永远是“按日志顺序折叠事件”的纯函数结果，服务重启后整体重放，
  判断与重启前逐字段一致。
- **乱序/重复不倒退事实**：上报不直接覆盖状态，而折叠为确定状态机。
  先被采信的完成时间即为事实；之后迟到的开始事件仅补录开始时刻（不倒退完成），
  第二条完成被记为 `REJECTED`；同态重复事件记为 `REDUNDANT`。每条上报都带
  `EFFECTIVE / REDUNDANT / REJECTED / REVOKED / SUPERSEDED_AIRCRAFT` 判定与原因，
  “同一项工作被报成三个完成时间”的争议可直接溯源。
- **撤销**：`CANCELLED` 显式作废此前一条上报（需带 `refEventId`），整体重新折叠；
  更早被拒的完成会自动升格为当前事实，再撤销则回到进行中。
- **换机隔离**：进度按“当前执飞飞机”绑定。换机后新飞机得到全新的未开始绑定，
  旧机进度只作 `staleProgress` 展示、不参与计算、不自动继承；旧机号继续上报会被
  `AIRCRAFT_MISMATCH` 拒绝。
- **计划版本化**：人工调整计划生成新版本（自增版本号 + 理由 + 操作人 + 时间）。
  **已经发生（开始/暂停/完成）的节点冻结**，调整请求以 `ACTUAL_FROZEN` 拒绝，
  已发生事实不随新计划改写；历史版本可回溯。
- **关键路径 / 最早可关舱**：对任务依赖图做正向 CPM。已完成取实际时刻；
  进行中/暂停按“已耗工时（暂停不计工时）+ 剩余计划工时”推算；未开始任务的最早
  开始被未完成前置顶后。关舱时刻取计划关舱点与所有任务预计完成的最大值，
  并回溯出当前关键链。
- **并发确定性**：所有写命令经单条 Promise 链串行化并按日志序号定全序，
  同一 `eventId` 的并发上报只有一条落库，当前状态唯一。

## 运行

需要 Node.js 20+（无需第三方依赖）：

```bash
npm test     # 运行 test/baseline.test.js
npm start    # 默认监听 3000，首次启动用 fixtures/context.json 播种
```

环境变量：`PORT`（默认 3000）、`EVENT_FILE`（默认 `data/events.jsonl`，
设为 `memory` 不落盘）、`FIXTURE_PATH`。容器方式：`docker compose up --build`
（事件日志保存在命名卷 `turnaround-data` 中）。

## HTTP API

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET  /health` | 进程健康状态 |
| `POST /api/legs` | 编排航班航段 |
| `GET  /api/legs` | 航段列表 |
| `POST /api/legs/:id/tasks` | 编排保障任务（依赖必须已存在且不得成环） |
| `POST /api/legs/:id/reports` | 上报进度（幂等：相同 `eventId` 不改变状态） |
| `POST /api/legs/:id/aircraft` | 换机 |
| `POST /api/legs/:id/plan-revisions` | 人工调整计划（带理由） |
| `GET  /api/legs/:id/timeline` | 完整时间线投影 |
| `GET  /api/legs/:id/delay` | 延误结论、关键路径与归因 |
| `GET  /api/legs/:id/blockers` | 当前阻塞环节 |
| `GET  /api/legs/:id` | 同 timeline |

### 上报

```jsonc
// POST /api/legs/MU5107-20260912-PVG-PEK/reports
{
  "eventId": "evt-003",
  "taskCode": "CATERING",
  "kind": "COMPLETED",                 // STARTED | PAUSED | RESUMED | COMPLETED | CANCELLED
  "occurredAt": "2026-09-12T08:37:00+08:00", // 业务发生时刻
  "receivedAt": "2026-09-12T08:37:10+08:00", // 可选，默认服务接收时刻
  "reporter": "配餐班组长",
  "note": "可选备注",
  "aircraftRegistration": "B-20A1",    // 可选；与当前机号不符则拒绝
  "refEventId": "evt-002"              // 仅 CANCELLED 需要
}
```

### 时间线投影（节选）

```jsonc
{
  "aircraftRegistration": "B-20A1",
  "planVersion": 1,
  "scheduledDoorClose": "2026-09-12T01:00:00.000Z",
  "forecastEarliestDoorClose": "2026-09-12T01:00:00.000Z",
  "delayed": false,
  "delayMinutes": 0,
  "criticalPath": ["CABIN_CLEANING", "CATERING", "BOARDING"],
  "blockingTasks": [{ "taskCode": "BOARDING", "type": "NOT_STARTED", "message": "…" }],
  "delayReason": { "delayed": false, "summary": "…", "contributors": [] },
  "planVersions": [/* 初始编排与每次人工调整，含 reason/changedBy/changes */],
  "aircraftHistory": [/* 机号变更轨迹 */],
  "tasks": [
    {
      "taskCode": "CATERING",
      "responsibleUnit": "航机配餐部",
      "dependsOn": ["CABIN_CLEANING"],
      "status": "COMPLETED",            // PENDING | IN_PROGRESS | PAUSED | COMPLETED
      "startedAt": "…", "completedAt": "…",
      "forecastEnd": "…",
      "onCriticalPath": true,
      "lastEffectiveEvent": { "eventId": "evt-003", "kind": "COMPLETED", "…": "…" },
      "staleProgress": false,
      "reports": [
        { "eventId": "evt-003", "decision": "EFFECTIVE", "reason": null },
        { "eventId": "evt-002", "decision": "REDUNDANT", "reason": "迟到的开始上报仅补录…" },
        { "eventId": "evt-005", "decision": "REJECTED",  "reason": "完成时间已先行采信…" }
      ]
    }
  ]
}
```

## 代码结构

```
src/domain/time.js         ISO 8601 解析/格式化（内部统一用毫秒时间戳）
src/domain/errors.js       带 HTTP 状态的领域错误
src/domain/store.js        只追加 JSONL 事件日志（重放 + 批量追加）
src/domain/turnaround.js   命令校验、事件折叠状态机、串行化命令服务
src/domain/projection.js   CPM 关键路径、最早关舱、阻塞、延误归因只读投影
src/http/router.js         HTTP 路由与 JSON/错误映射
src/bootstrap.js           fixtures 导入器
src/server.js              进程装配（重放 → 播种 → 起服务）
fixtures/context.json      短停场景：计划节点 + 三条乱序/重复上报
test/baseline.test.js      11 项端到端不变量测试
```

样例数据仅用于说明字段、时间语义与关联方式，不代表机场实时生产数据。
