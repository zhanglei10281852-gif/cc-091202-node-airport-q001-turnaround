import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { buildApp } from "../src/server.js";
import { EventStore } from "../src/store/event-store.js";

const LEG = {
  legId: "MU5107-20260912-SHA-PEK",
  flightNumber: "MU5107",
  origin: "SHA",
  destination: "PEK",
  aircraftRegistration: "B-20A1",
  scheduledOffBlock: "2026-09-12T09:00:00+08:00",
  finalTaskCode: "DOOR_CLOSED",
  tasks: [
    { code: "ARRIVAL_CHOCKS", name: "挡轮挡", responsibleUnit: "机务", dependsOn: [], plannedStart: "2026-09-12T08:00:00+08:00", plannedEnd: "2026-09-12T08:02:00+08:00" },
    { code: "CABIN_CLEANING", name: "客舱清洁", responsibleUnit: "清洁队", dependsOn: ["ARRIVAL_CHOCKS"], plannedStart: "2026-09-12T08:05:00+08:00", plannedEnd: "2026-09-12T08:25:00+08:00" },
    { code: "FUELING", name: "航油加注", responsibleUnit: "航油", dependsOn: ["ARRIVAL_CHOCKS"], plannedStart: "2026-09-12T08:05:00+08:00", plannedEnd: "2026-09-12T08:25:00+08:00" },
    { code: "CATERING", name: "配餐装机", responsibleUnit: "配餐", dependsOn: ["CABIN_CLEANING"], plannedStart: "2026-09-12T08:25:00+08:00", plannedEnd: "2026-09-12T08:35:00+08:00" },
    { code: "BOARDING", name: "旅客登机", responsibleUnit: "客运", dependsOn: ["CATERING", "FUELING"], plannedStart: "2026-09-12T08:35:00+08:00", plannedEnd: "2026-09-12T08:55:00+08:00" },
    { code: "DOOR_CLOSED", name: "关舱", responsibleUnit: "机组", dependsOn: ["BOARDING"], plannedStart: "2026-09-12T08:55:00+08:00", plannedEnd: "2026-09-12T09:00:00+08:00" },
  ],
};

async function startServer(logPath) {
  const store = new EventStore(logPath);
  store.load();
  const server = buildApp(store).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    store,
    base,
    req: async (method, path, body) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      return { status: res.status, json };
    },
  };
}

let dir;
let logPath;
let app;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "turnaround-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  logPath = join(dir, `events-${process.hrtime.bigint()}.jsonl`);
  app = await startServer(logPath);
});

test("健康接口返回可用状态", async (t) => {
  t.after(() => app.server.close());
  const res = await fetch(`${app.base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("建航段后时间线包含全部任务与计划关舱时刻", async (t) => {
  t.after(() => app.server.close());
  const { status, json } = await app.req("POST", "/legs", LEG);
  assert.equal(status, 200, JSON.stringify(json));

  const tl = (await app.req("GET", `/legs/${LEG.legId}`)).json;
  assert.equal(tl.criticalPath.earliestOffBlock, "2026-09-12T01:00:00.000Z"); // 09:00 +08:00
  assert.equal(tl.criticalPath.delayMinutes, 0);
  assert.equal(tl.criticalPath.isDelayed, false);
  // 关键链：轮挡 -> 清洁 -> 配餐 -> 登机 -> 关舱（加油非关键）
  assert.deepEqual(tl.criticalPath.tasks, [
    "ARRIVAL_CHOCKS",
    "CABIN_CLEANING",
    "CATERING",
    "BOARDING",
    "DOOR_CLOSED",
  ]);
  assert.equal(tl.tasks.find((x) => x.code === "FUELING").onCriticalPath, false);
  assert.equal(tl.criticalPath.blockedBy.taskCode, "ARRIVAL_CHOCKS");
});

test("乱序到达的上报按发生时刻排序，迟到的开工不会倒退事实", async (t) => {
  t.after(() => app.server.close());
  await app.req("POST", "/legs", LEG);

  // 先到完成（08:37），开工（08:23）一分钟后才到——与 fixture 一致。
  const r1 = await app.req("POST", `/legs/${LEG.legId}/tasks/CATERING/reports`, {
    eventId: "evt-003", kind: "COMPLETED", occurredAt: "2026-09-12T08:37:00+08:00", receivedAt: "2026-09-12T08:37:10+08:00",
  });
  assert.equal(r1.status, 200);
  const r2 = await app.req("POST", `/legs/${LEG.legId}/tasks/CATERING/reports`, {
    eventId: "evt-002", kind: "STARTED", occurredAt: "2026-09-12T08:23:00+08:00", receivedAt: "2026-09-12T08:38:00+08:00",
  });
  assert.equal(r2.status, 200);

  const tl = (await app.req("GET", `/legs/${LEG.legId}`)).json;
  const catering = tl.tasks.find((x) => x.code === "CATERING");
  assert.equal(catering.status, "COMPLETED");
  assert.equal(catering.actualStartedAt, "2026-09-12T00:23:00.000Z");
  assert.equal(catering.actualCompletedAt, "2026-09-12T00:37:00.000Z");
  // 最近一次有效上报按接收时间取，仍是 COMPLETED（evt-003 最后到达的是 STARTED 但发生更早）
  assert.equal(catering.lastReport.eventId, "evt-002");
});

test("同一项工作被报成两个完成时间：重复 COMPLETED 不改变首个事实，撤销可纠正", async (t) => {
  t.after(() => app.server.close());
  await app.req("POST", "/legs", LEG);
  const reports = `/legs/${LEG.legId}/tasks/CATERING/reports`;
  await app.req("POST", reports, { eventId: "e-start", kind: "STARTED", occurredAt: "2026-09-12T08:23:00+08:00" });
  await app.req("POST", reports, { eventId: "e-done-1", kind: "COMPLETED", occurredAt: "2026-09-12T08:37:00+08:00" });
  await app.req("POST", reports, { eventId: "e-done-2", kind: "COMPLETED", occurredAt: "2026-09-12T08:41:00+08:00" });

  let tl = (await app.req("GET", `/legs/${LEG.legId}`)).json;
  let catering = tl.tasks.find((x) => x.code === "CATERING");
  assert.equal(catering.actualCompletedAt, "2026-09-12T00:37:00.000Z");

  // 撤销首个错误完成时间（客运复核误报），第二个完成立即成为唯一事实。
  const rev = await app.req("POST", `/legs/${LEG.legId}/revocations`, {
    refEventId: "e-done-1", reason: "客运复核误报，以配餐自报为准",
  });
  assert.equal(rev.status, 200, JSON.stringify(rev.json));
  tl = (await app.req("GET", `/legs/${LEG.legId}`)).json;
  catering = tl.tasks.find((x) => x.code === "CATERING");
  assert.equal(catering.actualCompletedAt, "2026-09-12T00:41:00.000Z");
  assert.equal(tl.lastRevocation.refEventId, "e-done-1");
});

test("重复 eventId 被拒绝", async (t) => {
  t.after(() => app.server.close());
  await app.req("POST", "/legs", LEG);
  const body = { eventId: "dup", kind: "STARTED", occurredAt: "2026-09-12T08:05:00+08:00" };
  await app.req("POST", `/legs/${LEG.legId}/tasks/FUELING/reports`, body);
  const r = await app.req("POST", `/legs/${LEG.legId}/tasks/FUELING/reports`, body);
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "duplicate_event");
});

test("暂停的任务阻塞关键路径，最早关舱时刻无法承诺", async (t) => {
  t.after(() => app.server.close());
  await app.req("POST", "/legs", LEG);
  await app.req("POST", `/legs/${LEG.legId}/tasks/ARRIVAL_CHOCKS/reports`, {
    kind: "COMPLETED", occurredAt: "2026-09-12T08:02:00+08:00",
  });
  const cleaning = `/legs/${LEG.legId}/tasks/CABIN_CLEANING/reports`;
  await app.req("POST", cleaning, { kind: "STARTED", occurredAt: "2026-09-12T08:06:00+08:00" });
  await app.req("POST", cleaning, { kind: "PAUSED", occurredAt: "2026-09-12T08:10:00+08:00" });

  const tl = (await app.req("GET", `/legs/${LEG.legId}`)).json;
  assert.equal(tl.criticalPath.earliestOffBlock, null);
  assert.equal(tl.criticalPath.blockedBy.taskCode, "CABIN_CLEANING");
  assert.equal(tl.criticalPath.blockedBy.reason, "任务已暂停，等待恢复");
  assert.ok(tl.criticalPath.reasons.some((r) => r.type === "paused" && r.taskCode === "CABIN_CLEANING"));

  // 恢复后重新可计算（按已耗用工时推算剩余工时）。
  await app.req("POST", cleaning, { kind: "RESUMED", occurredAt: "2026-09-12T08:20:00+08:00" });
  const tl2 = (await app.req("GET", `/legs/${LEG.legId}`)).json;
  assert.notEqual(tl2.criticalPath.earliestOffBlock, null);
  // 清洁净作业 20 分钟：08:06-08:10(4) + 08:20 起 16 分钟 -> 08:36 完成，链整体顺延。
  const cleaningTask = tl2.tasks.find((x) => x.code === "CABIN_CLEANING");
  assert.equal(cleaningTask.projectedFinish, "2026-09-12T00:36:00.000Z");
  assert.ok(tl2.criticalPath.delayMinutes >= 11);
});

test("换机后旧飞机进度不继承，归档可查", async (t) => {
  t.after(() => app.server.close());
  await app.req("POST", "/legs", LEG);
  await app.req("POST", `/legs/${LEG.legId}/tasks/FUELING/reports`, {
    kind: "COMPLETED", occurredAt: "2026-09-12T08:24:00+08:00",
  });
  await app.req("POST", `/legs/${LEG.legId}/aircraft-change`, {
    newRegistration: "B-6699", occurredAt: "2026-09-12T08:30:00+08:00", reason: "飞机故障换机",
  });

  const tl = (await app.req("GET", `/legs/${LEG.legId}`)).json;
  assert.equal(tl.leg.aircraftRegistration, "B-6699");
  assert.equal(tl.leg.initialRegistration, "B-20A1");
  for (const task of tl.tasks) assert.equal(task.status, "NOT_STARTED");
  assert.equal(tl.tasks.find((x) => x.code === "FUELING").lastReport, null);
  assert.equal(tl.leg.aircraftHistory[0].fromRegistration, "B-20A1");
  // 旧机进度被归档保留。
  assert.equal(tl.leg.aircraftHistory[0].progress.FUELING.status, "COMPLETED");
});

test("计划修订留下版本与理由，已发生节点不被改写", async (t) => {
  t.after(() => app.server.close());
  await app.req("POST", "/legs", LEG);
  // 加油已完成。
  await app.req("POST", `/legs/${LEG.legId}/tasks/FUELING/reports`, {
    kind: "COMPLETED", occurredAt: "2026-09-12T08:24:00+08:00",
  });
  const rev = await app.req("POST", `/legs/${LEG.legId}/plan-revisions`, {
    reason: "流量控制，登机推迟 10 分钟",
    changes: {
      BOARDING: { plannedStart: "2026-09-12T08:45:00+08:00", plannedEnd: "2026-09-12T09:05:00+08:00" },
      FUELING: { plannedStart: "2026-09-12T08:30:00+08:00", plannedEnd: "2026-09-12T08:50:00+08:00" },
    },
  });
  assert.equal(rev.status, 200, JSON.stringify(rev.json));

  const tl = (await app.req("GET", `/legs/${LEG.legId}`)).json;
  assert.equal(tl.leg.planVersion, 1);
  assert.equal(tl.planHistory[1].reason, "流量控制，登机推迟 10 分钟");
  assert.deepEqual(tl.planHistory[1].frozen, ["FUELING"]);
  const fueling = tl.tasks.find((x) => x.code === "FUELING");
  // 已完成任务的计划窗口与实际完成都保持原样。
  assert.equal(fueling.plannedEnd, "2026-09-12T08:25:00+08:00");
  assert.equal(fueling.actualCompletedAt, "2026-09-12T00:24:00.000Z");
  assert.equal(tl.tasks.find((x) => x.code === "BOARDING").plannedStart, "2026-09-12T08:45:00+08:00");
});

test("并发上报同一任务只形成一条确定的当前状态", async (t) => {
  t.after(() => app.server.close());
  await app.req("POST", "/legs", LEG);
  const url = `/legs/${LEG.legId}/tasks/FUELING/reports`;
  const payloads = [
    { kind: "STARTED", occurredAt: "2026-09-12T08:06:00+08:00" },
    { kind: "PAUSED", occurredAt: "2026-09-12T08:10:00+08:00" },
    { kind: "RESUMED", occurredAt: "2026-09-12T08:15:00+08:00" },
    { kind: "COMPLETED", occurredAt: "2026-09-12T08:26:00+08:00" },
  ];
  const results = await Promise.all(
    payloads.map((p) => app.req("POST", url, p)),
  );
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.json));
  const tl = (await app.req("GET", `/legs/${LEG.legId}`)).json;
  const fueling = tl.tasks.find((x) => x.code === "FUELING");
  assert.equal(fueling.status, "COMPLETED");
  assert.equal(fueling.actualStartedAt, "2026-09-12T00:06:00.000Z");
  assert.equal(fueling.actualCompletedAt, "2026-09-12T00:26:00.000Z");
});

test("服务重启后从事件日志恢复出一致判断", async (t) => {
  await app.req("POST", "/legs", LEG);
  await app.req("POST", `/legs/${LEG.legId}/tasks/CATERING/reports`, {
    eventId: "evt-003", kind: "COMPLETED", occurredAt: "2026-09-12T08:37:00+08:00", receivedAt: "2026-09-12T08:37:10+08:00",
  });
  await app.req("POST", `/legs/${LEG.legId}/tasks/CATERING/reports`, {
    eventId: "evt-002", kind: "STARTED", occurredAt: "2026-09-12T08:23:00+08:00", receivedAt: "2026-09-12T08:38:00+08:00",
  });
  const before = (await app.req("GET", `/legs/${LEG.legId}`)).json;
  await new Promise((resolve) => app.server.close(resolve));

  // 新进程视角：新建 store 从同一日志恢复。
  const restarted = await startServer(logPath);
  t.after(() => restarted.server.close());
  const after = (await restarted.req("GET", `/legs/${LEG.legId}`)).json;
  assert.deepEqual(after, before);

  const lines = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 3); // 建航段 + 2 条上报，重启不产生重复日志
});

test("延误归因指出具体环节与分钟数", async (t) => {
  t.after(() => app.server.close());
  await app.req("POST", "/legs", LEG);
  // 清洁晚 10 分钟完成，关键链整体顺延。
  await app.req("POST", `/legs/${LEG.legId}/tasks/CABIN_CLEANING/reports`, {
    kind: "COMPLETED", occurredAt: "2026-09-12T08:35:00+08:00",
  });
  const tl = (await app.req("GET", `/legs/${LEG.legId}`)).json;
  assert.equal(tl.criticalPath.isDelayed, true);
  assert.equal(tl.criticalPath.delayMinutes, 10);
  const reason = tl.criticalPath.reasons.find((r) => r.taskCode === "CABIN_CLEANING");
  assert.equal(reason.type, "finished_late");
  assert.equal(reason.minutesLate, 10);
});

test("依赖环在建航段时被拒绝", async (t) => {
  t.after(() => app.server.close());
  const cyclic = {
    ...LEG,
    legId: "CYCLIC",
    tasks: LEG.tasks.map((task) =>
      task.code === "ARRIVAL_CHOCKS" ? { ...task, dependsOn: ["DOOR_CLOSED"] } : task,
    ),
  };
  const r = await app.req("POST", "/legs", cyclic);
  assert.equal(r.status, 400);
  assert.match(r.json.message, /环/);
});

test("向不存在的航段上报返回 404", async (t) => {
  t.after(() => app.server.close());
  const r = await app.req("POST", "/legs/NOPE/tasks/FUELING/reports", {
    kind: "STARTED", occurredAt: "2026-09-12T08:10:00+08:00",
  });
  assert.equal(r.status, 404);
});

test("并发计划修订获得唯一递增版本号并各自记录理由", async (t) => {
  t.after(() => app.server.close());
  await app.req("POST", "/legs", LEG);
  const url = `/legs/${LEG.legId}/plan-revisions`;
  const results = await Promise.all([
    app.req("POST", url, { reason: "修订一", changes: { BOARDING: { plannedStart: "2026-09-12T08:40:00+08:00", plannedEnd: "2026-09-12T09:00:00+08:00" } } }),
    app.req("POST", url, { reason: "修订二", changes: { BOARDING: { plannedStart: "2026-09-12T08:45:00+08:00", plannedEnd: "2026-09-12T09:05:00+08:00" } } }),
  ]);
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.json));
  const versions = results.map((r) => r.json.planVersion).sort((a, b) => a - b);
  assert.deepEqual(versions, [1, 2]);
  const tl = (await app.req("GET", `/legs/${LEG.legId}`)).json;
  assert.deepEqual(tl.planHistory.map((h) => h.version), [0, 1, 2]);
  assert.equal(tl.planHistory[1].reason, "修订一");
  assert.equal(tl.planHistory[2].reason, "修订二");
});

test("fixtures 场景经 API 建航段并乱序上报后结论一致", async (t) => {
  t.after(() => app.server.close());
  const fixture = JSON.parse(await readFile(new URL("../fixtures/context.json", import.meta.url), "utf8"));
  const plan = fixture.records.find((r) => r.type === "plan");
  const { status } = await app.req("POST", "/legs", {
    legId: plan.flightLegId,
    flightNumber: plan.flightNumber,
    origin: plan.origin,
    destination: plan.destination,
    aircraftRegistration: plan.aircraftRegistration,
    scheduledOffBlock: plan.scheduledOffBlock,
    finalTaskCode: plan.finalTaskCode,
    tasks: plan.tasks.map((task) => ({
      code: task.taskCode,
      name: task.name,
      responsibleUnit: task.responsibleUnit,
      dependsOn: task.dependsOn,
      plannedStart: task.plannedStart,
      plannedEnd: task.plannedEnd,
    })),
  });
  assert.equal(status, 200);

  // 与文件中记录的到达顺序一致：evt-003 先到、evt-002 后到。
  for (const record of fixture.records.filter((r) => r.type === "event")) {
    const r = await app.req(
      "POST",
      `/legs/${plan.flightLegId}/tasks/${record.taskCode}/reports`,
      {
        eventId: record.eventId,
        kind: record.kind,
        occurredAt: record.occurredAt,
        receivedAt: record.receivedAt,
        responsibleUnit: record.responsibleUnit,
        note: record.note ?? null,
      },
    );
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }

  const tl = (await app.req("GET", `/legs/${plan.flightLegId}`)).json;
  const catering = tl.tasks.find((x) => x.code === "CATERING");
  assert.equal(catering.status, "COMPLETED");
  assert.equal(catering.actualStartedAt, "2026-09-12T00:23:00.000Z");
  assert.equal(catering.actualCompletedAt, "2026-09-12T00:37:00.000Z");
  assert.ok(catering.lastReport.eventId === "evt-004");
  // 两个完成时间并存时以首个事实 08:37 为准，evt-004 仍作为最近上报暴露冲突来源。
  assert.equal(catering.actualCompletedAt, "2026-09-12T00:37:00.000Z");
  // 配餐晚 2 分钟完成，关键链顺延导致预计关舱延误。
  assert.equal(tl.criticalPath.isDelayed, true);
  assert.equal(tl.criticalPath.delayMinutes, 2);
});
