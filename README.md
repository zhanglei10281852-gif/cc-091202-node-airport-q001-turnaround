# 航班过站运行协同服务

面向短停过站的保障协同服务：把航班航段、保障任务、前后依赖、计划窗口和责任单位组织成可追踪时间线；各单位乱序上报开始、暂停、恢复、完成或撤销时，重复及乱序事件不能倒退事实；系统持续计算当前关键路径与最早可关舱时刻。

所有业务时刻均采用带偏移量的 ISO 8601 字符串，航班航段标识运行任务，航空器注册号标识实际执行飞机。

## 模型与语义

- **事件溯源**：建航段、任务上报、撤销、换机、计划修订全部是只追加事件，落盘为 JSONL（默认 `data/events.jsonl`，可用 `EVENT_LOG_PATH` 覆盖）。任何当前状态都由事件重放得到，重启后判断与重启前一致。
- **全序处理**：事件按 `occurredAt → receivedAt → eventId` 排序重放。先收到"完成"再收到"开始"也能还原事实；迟到的开工不会覆盖已成立的完成。
- **单调状态机**：`NOT_STARTED → IN_PROGRESS ⇄ PAUSED → COMPLETED`。重复的开始/完成被忽略，因此同一项工作被报出多个完成时间时只承认第一个事实；错误上报可通过撤销纠正。
- **撤销（REVOKED）**：撤销某条任务上报后该上报视为从未发生，关键路径立即重算（例如撤销误报的完成时间后，后报的完成时间成为唯一事实）。
- **换机**：`AIRCRAFT_CHANGED` 把旧飞机上的全部进度归档（事件与归档可查），新飞机任务从零开始，不自动继承任何进度或上报。
- **计划修订**：每次修订生成递增版本号并强制填写理由；只对尚未开始的任务生效，已发生节点（实际开始/完成时刻）永不被改写，被冻结的任务记录在该版本的 `frozen` 中。
- **关键路径**：依据未完成的依赖，按计划工期与实际进度（含暂停/恢复的净作业时间）推算每个任务最早完成，回溯出关键链、最早可关舱时刻、当前阻塞环节与逐环节延误归因；任务暂停时最早关舱时刻不可承诺（`null`）。
- **并发确定性**：写入经单条串行队列，计划版本号在锁内分配，并发更新同一任务只会形成一条确定的当前状态。

## 运行

需要 Node.js 20 或更高版本：

```bash
npm test
npm start
```

服务默认监听 `3000` 端口，`GET /health` 返回进程状态。也可以执行 `docker compose up --build` 启动容器，使用 `APP_PORT` 调整宿主机端口；容器把事件日志挂载到 `./data` 卷。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/legs` | 建立航段：航段、机号、计划关舱时刻、任务（编码、责任单位、依赖、计划窗口） |
| GET | `/legs` | 列出全部航段摘要 |
| GET | `/legs/:legId` | 时间线投影：任务状态、关键路径、最早关舱、阻塞环节、延误原因、最近有效上报（支持 `?asOf=`） |
| GET | `/legs/:legId/events` | 查看该航段的原始事件日志 |
| POST | `/legs/:legId/tasks/:code/reports` | 责任单位上报 `STARTED/PAUSED/RESUMED/COMPLETED` |
| POST | `/legs/:legId/revocations` | 撤销一条错误上报（`refEventId` + `reason`） |
| POST | `/legs/:legId/aircraft-change` | 换机（`newRegistration` + `reason`） |
| POST | `/legs/:legId/plan-revisions` | 人工修订计划（`changes` + 必填 `reason`） |

上报请求体：

```json
{
  "kind": "COMPLETED",
  "occurredAt": "2026-09-12T08:37:00+08:00",
  "receivedAt": "2026-09-12T08:37:10+08:00",
  "responsibleUnit": "配餐"
}
```

时间线响应中的 `criticalPath`：

```json
{
  "tasks": ["ARRIVAL_CHOCKS", "CABIN_CLEANING", "CATERING", "BOARDING", "DOOR_CLOSED"],
  "scheduledOffBlock": "2026-09-12T09:00:00+08:00",
  "earliestOffBlock": "2026-09-12T01:02:00.000Z",
  "delayMinutes": 2,
  "isDelayed": true,
  "blockedBy": { "taskCode": "BOARDING", "status": "IN_PROGRESS", "reason": "尚未开始" },
  "reasons": [ { "taskCode": "CATERING", "type": "finished_late", "minutesLate": 2, "message": "配餐装机 实际完成晚于计划 2 分钟" } ]
}
```

`fixtures/context.json` 记录了一架短停航班的完整计划节点及三条乱序到达的保障上报（含两个不同岗位报出的不同完成时间），样例只用于说明字段与时间语义，不代表实时生产数据。

本地环境变量写入 `.env`，日志、`data/` 事件目录和任何运行凭据都不应提交到仓库。
