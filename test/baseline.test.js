import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { EventStore } from "../src/domain/store.js";
import { TurnaroundService } from "../src/domain/turnaround.js";
import { projectLeg } from "../src/domain/projection.js";
import { importFixture } from "../src/bootstrap.js";
import { buildServer } from "../src/http/router.js";

const TZ = "+08:00";
const iso = (h, m = 0) => `2026-09-12T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${TZ}`;
const LEG = "MU5107-20260912-PVG-PEK";

async function makeService(clock = () => Date.parse(iso(8, 40))) {
  const dir = await mkdtemp(join(tmpdir(), "turnaround-"));
  const store = new EventStore(join(dir, "events.jsonl"));
  const service = new TurnaroundService(store, clock);
  return { service, dir };
}

async function seedFixture(service) {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/context.json", import.meta.url), "utf8"));
  await importFixture(service, fixture);
}

test("乱序与重复上报：先采信的完成时间不倒退，迟到开始仅补录，重复完成被拒绝", async () => {
  const { service } = await makeService();
  await seedFixture(service);

  const leg = service.state.legs.get(LEG);
  const view = projectLeg(leg, service.now());
  const catering = view.tasks.find((t) => t.taskCode === "CATERING");

  assert.equal(catering.status, "COMPLETED");
  assert.equal(catering.completedAt, new Date(iso(8, 37)).toISOString());
  assert.equal(catering.startedAt, new Date(iso(8, 23)).toISOString());
  assert.equal(catering.lastEffectiveEvent.eventId, "evt-003");

  const byId = Object.fromEntries(catering.reports.map((r) => [r.eventId, r]));
  assert.equal(byId["evt-003"].decision, "EFFECTIVE");
  assert.equal(byId["evt-002"].decision, "REDUNDANT");
  assert.match(byId["evt-002"].reason, /补录/);
  assert.equal(byId["evt-005"].decision, "REJECTED");
  assert.match(byId["evt-005"].reason, /重复完成/);
});

test("到达顺序不影响最终事实：先到开始与先到完成折叠出同一状态", async () => {
  const { service: a } = await makeService();
  const { service: b } = await makeService();
  for (const svc of [a, b]) {
    await svc.scheduleLeg({
      flightLegId: LEG,
      aircraftRegistration: "B-20A1",
      turnaroundStart: iso(8, 5),
      scheduledDoorClose: iso(9, 0),
    });
    await svc.scheduleTask(LEG, {
      taskCode: "CATERING",
      responsibleUnit: "配餐",
      dependsOn: [],
      plannedStart: iso(8, 20),
      plannedEnd: iso(8, 35),
    });
  }

  // A：开始先到、完成后到（正常顺序）
  await a.report(LEG, { eventId: "a1", taskCode: "CATERING", kind: "STARTED", occurredAt: iso(8, 23), receivedAt: iso(8, 23, 5) });
  await a.report(LEG, { eventId: "a2", taskCode: "CATERING", kind: "COMPLETED", occurredAt: iso(8, 37), receivedAt: iso(8, 37, 10) });

  // B：完成先到、开始迟到（乱序）
  await b.report(LEG, { eventId: "b2", taskCode: "CATERING", kind: "COMPLETED", occurredAt: iso(8, 37), receivedAt: iso(8, 37, 10) });
  await b.report(LEG, { eventId: "b1", taskCode: "CATERING", kind: "STARTED", occurredAt: iso(8, 23), receivedAt: iso(8, 38, 0) });

  const va = projectLeg(a.state.legs.get(LEG), a.now());
  const vb = projectLeg(b.state.legs.get(LEG), b.now());
  const ta = va.tasks[0];
  const tb = vb.tasks[0];
  assert.equal(ta.status, tb.status);
  assert.equal(ta.completedAt, tb.completedAt);
  assert.equal(ta.startedAt, tb.startedAt);
  assert.equal(ta.forecastEnd, tb.forecastEnd);
});

test("关键路径与最早可关舱时刻：前序延误 10 分钟沿紧链顺延至关舱", async () => {
  const { service } = await makeService();
  await service.scheduleLeg({
    flightLegId: LEG,
    aircraftRegistration: "B-1",
    turnaroundStart: iso(8, 5),
    scheduledDoorClose: iso(9, 0),
  });
  // 无缓冲的紧链：保洁 → 配餐 → 登机。
  await service.scheduleTask(LEG, { taskCode: "CABIN_CLEANING", responsibleUnit: "保洁队", dependsOn: [], plannedStart: iso(8, 15), plannedEnd: iso(8, 30) });
  await service.scheduleTask(LEG, { taskCode: "CATERING", responsibleUnit: "配餐部", dependsOn: ["CABIN_CLEANING"], plannedStart: iso(8, 30), plannedEnd: iso(8, 45) });
  await service.scheduleTask(LEG, { taskCode: "BOARDING", responsibleUnit: "客运室", dependsOn: ["CATERING"], plannedStart: iso(8, 45), plannedEnd: iso(9, 0) });

  // 保洁实际 08:40 才完成（计划 08:30）。
  await service.report(LEG, {
    eventId: "evt-clean-1",
    taskCode: "CABIN_CLEANING",
    kind: "COMPLETED",
    occurredAt: iso(8, 40),
    receivedAt: iso(8, 40, 5),
  });

  const view = projectLeg(service.state.legs.get(LEG), service.now());
  assert.equal(view.delayed, true);
  assert.equal(view.delayMinutes, 10);
  assert.equal(view.forecastEarliestDoorClose, new Date(iso(9, 10)).toISOString());
  assert.deepEqual(view.criticalPath, ["CABIN_CLEANING", "CATERING", "BOARDING"]);
  assert.match(view.delayReason.summary, /CABIN_CLEANING/);
  // 已过计划开始时刻（08:30）仍未开始的配餐是当前阻塞环节。
  assert.ok(view.blockingTasks.some((b) => b.taskCode === "CATERING" && b.type === "NOT_STARTED"));
});

test("暂停不计工时：暂停 10 分钟后恢复，预计完成顺延 10 分钟", async () => {
  const { service } = await makeService(() => Date.parse(iso(8, 25)));
  await service.scheduleLeg({
    flightLegId: LEG,
    aircraftRegistration: "B-1",
    scheduledDoorClose: iso(9, 0),
  });
  await service.scheduleTask(LEG, {
    taskCode: "REFUELLING",
    responsibleUnit: "加油站",
    dependsOn: [],
    plannedStart: iso(8, 0),
    plannedEnd: iso(8, 30),
  });
  await service.report(LEG, { eventId: "s", taskCode: "REFUELLING", kind: "STARTED", occurredAt: iso(8, 0), receivedAt: iso(8, 0) });
  await service.report(LEG, { eventId: "p", taskCode: "REFUELLING", kind: "PAUSED", occurredAt: iso(8, 10), receivedAt: iso(8, 10) });
  await service.report(LEG, { eventId: "r", taskCode: "REFUELLING", kind: "RESUMED", occurredAt: iso(8, 20), receivedAt: iso(8, 20) });

  const view = projectLeg(service.state.legs.get(LEG), service.now());
  const task = view.tasks[0];
  // 已耗 15 分钟（08:00-08:10 + 08:20-08:25），剩余 15 分钟 → 08:40 完成。
  assert.equal(task.status, "IN_PROGRESS");
  assert.equal(task.forecastEnd, new Date(iso(8, 40)).toISOString());
  assert.ok(view.blockingTasks.every((b) => b.taskCode !== "REFUELLING" || b.type !== "PAUSED"));
});

test("换机：旧机进度不继承，旧机号上报被拒，历史可追溯", async () => {
  const { service } = await makeService();
  await seedFixture(service);

  await service.reassign(LEG, { aircraftRegistration: "B-9999", reason: "原机故障调机", changedBy: "签派" });

  const fresh = projectLeg(service.state.legs.get(LEG), service.now());
  assert.equal(fresh.aircraftRegistration, "B-9999");
  const catering = fresh.tasks.find((t) => t.taskCode === "CATERING");
  assert.equal(catering.status, "PENDING");
  assert.equal(catering.staleProgress, true);
  assert.ok(catering.reports.some((r) => r.decision === "SUPERSEDED_AIRCRAFT"));
  assert.equal(fresh.aircraftHistory.at(-1).reason, "原机故障调机");

  // 旧机号上报必须拒绝。
  await assert.rejects(
    service.report(LEG, {
      eventId: "evt-old",
      taskCode: "CATERING",
      kind: "STARTED",
      occurredAt: iso(8, 50),
      aircraftRegistration: "B-20A1",
    }),
    (err) => err.code === "AIRCRAFT_MISMATCH",
  );

  // 新机重新开始，得到全新进度。
  await service.report(LEG, {
    eventId: "evt-new-1",
    taskCode: "CATERING",
    kind: "STARTED",
    occurredAt: iso(8, 50),
  });
  const after = projectLeg(service.state.legs.get(LEG), service.now());
  assert.equal(after.tasks.find((t) => t.taskCode === "CATERING").status, "IN_PROGRESS");
});

test("人工调计划留下版本与理由；已发生节点冻结；事实不被改写", async () => {
  const { service } = await makeService();
  await seedFixture(service);

  const event = await service.adjustPlan(LEG, {
    reason: "加油车队晚到，加油窗口后移 10 分钟",
    changedBy: "运行协调员",
    changes: [{ taskCode: "REFUELLING", plannedStart: iso(8, 20), plannedEnd: iso(8, 45) }],
  });
  assert.equal(event.type, "PLAN_ADJUSTED");

  const view = projectLeg(service.state.legs.get(LEG), service.now());
  assert.equal(view.planVersion, 2);
  const refuel = view.tasks.find((t) => t.taskCode === "REFUELLING");
  assert.equal(refuel.plannedStart, new Date(iso(8, 20)).toISOString());
  assert.equal(view.planVersions[1].reason, "加油车队晚到，加油窗口后移 10 分钟");
  assert.equal(view.planVersions[1].changedBy, "运行协调员");

  // 已完成的配餐不能随新计划改写。
  await assert.rejects(
    service.adjustPlan(LEG, {
      reason: "试图改写已完成节点",
      changes: [{ taskCode: "CATERING", plannedStart: iso(9, 0), plannedEnd: iso(9, 10) }],
    }),
    (err) => err.code === "ACTUAL_FROZEN",
  );
  const still = projectLeg(service.state.legs.get(LEG), service.now());
  assert.equal(still.tasks.find((t) => t.taskCode === "CATERING").completedAt, new Date(iso(8, 37)).toISOString());
  assert.equal(still.planVersion, 2);
});

test("撤销：CANCELLED 作废误报后重新折叠；更早被拒的完成升格，继续撤销后可重新上报", async () => {
  const { service } = await makeService();
  await seedFixture(service);

  // 撤销首条完成（08:37）后，此前被拒的第二条完成（08:41）升格为事实。
  await service.report(LEG, {
    eventId: "evt-cancel-003",
    taskCode: "CATERING",
    kind: "CANCELLED",
    refEventId: "evt-003",
    occurredAt: iso(8, 45),
    note: "08:37 那条完成属误报",
  });
  const rebound = projectLeg(service.state.legs.get(LEG), service.now());
  let catering = rebound.tasks.find((t) => t.taskCode === "CATERING");
  assert.equal(catering.status, "COMPLETED");
  assert.equal(catering.completedAt, new Date(iso(8, 41)).toISOString());
  assert.equal(catering.lastEffectiveEvent.eventId, "evt-005");
  assert.ok(catering.reports.find((r) => r.eventId === "evt-003").revoked);

  // 再撤销 08:41 这条：仅剩迟到的开始补录，任务回到进行中。
  await service.report(LEG, {
    eventId: "evt-cancel-005",
    taskCode: "CATERING",
    kind: "CANCELLED",
    refEventId: "evt-005",
    occurredAt: iso(8, 46),
  });
  const pending = projectLeg(service.state.legs.get(LEG), service.now());
  catering = pending.tasks.find((t) => t.taskCode === "CATERING");
  assert.equal(catering.status, "IN_PROGRESS");
  assert.equal(catering.completedAt, null);

  await service.report(LEG, {
    eventId: "evt-real-done",
    taskCode: "CATERING",
    kind: "COMPLETED",
    occurredAt: iso(8, 48),
    receivedAt: iso(8, 48, 3),
  });
  const done = projectLeg(service.state.legs.get(LEG), service.now());
  assert.equal(done.tasks.find((t) => t.taskCode === "CATERING").completedAt, new Date(iso(8, 48)).toISOString());
});

test("并发更新：同一 eventId 的并发重复上报只落一条，当前状态唯一", async () => {
  const { service } = await makeService();
  await seedFixture(service);

  const attempts = await Promise.all(
    Array.from({ length: 10 }, () =>
      service.report(LEG, {
        eventId: "evt-race",
        taskCode: "REFUELLING",
        kind: "STARTED",
        occurredAt: iso(8, 12),
      }),
    ),
  );
  const committed = attempts.filter((r) => !r.duplicated);
  assert.equal(committed.length, 1);

  const view = projectLeg(service.state.legs.get(LEG), service.now());
  const refuel = view.tasks.find((t) => t.taskCode === "REFUELLING");
  assert.equal(refuel.status, "IN_PROGRESS");
  assert.equal(refuel.startedAt, new Date(iso(8, 12)).toISOString());
  const reports = refuel.reports.filter((r) => r.eventId === "evt-race");
  assert.equal(reports.length, 1);
});

test("重启恢复：新进程从耐久事件重放，投影与重启前逐字段一致", async () => {
  const { service, dir } = await makeService();
  await seedFixture(service);
  await service.report(LEG, {
    eventId: "evt-clean-1",
    taskCode: "CABIN_CLEANING",
    kind: "COMPLETED",
    occurredAt: iso(8, 40),
  });
  await service.reassign(LEG, { aircraftRegistration: "B-7777", reason: "换机演练" });
  await service.adjustPlan(LEG, {
    reason: "重启前调整",
    changes: [{ taskCode: "REFUELLING", plannedStart: iso(8, 25), plannedEnd: iso(8, 50) }],
  });

  const before = projectLeg(service.state.legs.get(LEG), service.now());

  const restartedStore = new EventStore(join(dir, "events.jsonl"));
  const restarted = new TurnaroundService(restartedStore, () => Date.parse(iso(8, 40)));
  const after = projectLeg(restarted.state.legs.get(LEG), service.now());

  assert.deepEqual(after, before);

  // 重启后继续写入：事件序号连续，状态继续演进。
  await restarted.report(LEG, {
    eventId: "evt-after-restart",
    taskCode: "REFUELLING",
    kind: "STARTED",
    occurredAt: iso(8, 30),
  });
  const resumed = projectLeg(restarted.state.legs.get(LEG), restarted.now());
  assert.equal(resumed.tasks.find((t) => t.taskCode === "REFUELLING").status, "IN_PROGRESS");

  await rm(dir, { recursive: true, force: true });
});

test("HTTP API：时间线、延误归因、阻塞与上报幂等", async (context) => {
  const { service, dir } = await makeService();
  await seedFixture(service);
  const server = buildServer(service).listen(0, "127.0.0.1");
  context.after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);

  const timeline = await (await fetch(`${base}/api/legs/${LEG}/timeline`)).json();
  assert.equal(timeline.aircraftRegistration, "B-20A1");
  assert.ok(Array.isArray(timeline.criticalPath));
  assert.equal(timeline.tasks.find((t) => t.taskCode === "CATERING").lastEffectiveEvent.eventId, "evt-003");

  const delayRes = await fetch(`${base}/api/legs/${LEG}/delay`);
  const delay = await delayRes.json();
  assert.equal(delay.delayed, false);
  assert.equal(typeof delay.delayReason.summary, "string");

  const blockers = await (await fetch(`${base}/api/legs/${LEG}/blockers`)).json();
  assert.ok(Array.isArray(blockers.blockingTasks));

  // 幂等：同一上报连 POST 两次。
  const payload = {
    eventId: "evt-http-1",
    taskCode: "REFUELLING",
    kind: "COMPLETED",
    occurredAt: iso(8, 36),
  };
  const r1 = await fetch(`${base}/api/legs/${LEG}/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(r1.status, 201);
  const r2 = await fetch(`${base}/api/legs/${LEG}/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body2 = await r2.json();
  assert.equal(r2.status, 200);
  assert.equal(body2.duplicated, true);

  const after = await (await fetch(`${base}/api/legs/${LEG}/timeline`)).json();
  assert.equal(after.tasks.find((t) => t.taskCode === "REFUELLING").completedAt, new Date(iso(8, 36)).toISOString());

  // 校验错误映射为 4xx。
  const bad = await fetch(`${base}/api/legs/NO-SUCH/timeline`);
  assert.equal(bad.status, 404);
  const badJson = await bad.json();
  assert.equal(badJson.error, "LEG_NOT_FOUND");
});

test("编排校验：未知依赖、成环、计划起止倒置都被拒绝", async () => {
  const { service } = await makeService();
  await service.scheduleLeg({
    flightLegId: LEG,
    aircraftRegistration: "B-1",
    scheduledDoorClose: iso(9, 0),
  });
  await assert.rejects(
    service.scheduleTask(LEG, {
      taskCode: "X",
      responsibleUnit: "u",
      dependsOn: ["GHOST"],
      plannedStart: iso(8, 0),
      plannedEnd: iso(8, 10),
    }),
    (e) => e.code === "UNKNOWN_DEPENDENCY",
  );
  await service.scheduleTask(LEG, {
    taskCode: "A",
    responsibleUnit: "u",
    dependsOn: [],
    plannedStart: iso(8, 0),
    plannedEnd: iso(8, 10),
  });
  await service.scheduleTask(LEG, {
    taskCode: "B",
    responsibleUnit: "u",
    dependsOn: ["A"],
    plannedStart: iso(8, 10),
    plannedEnd: iso(8, 20),
  });
  await assert.rejects(
    service.scheduleTask(LEG, {
      taskCode: "A2",
      responsibleUnit: "u",
      dependsOn: ["B"],
      plannedStart: iso(8, 0),
      plannedEnd: iso(8, 0),
    }),
    (e) => e.code === "VALIDATION_FAILED",
  );
});
