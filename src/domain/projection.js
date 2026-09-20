import { bindingFor } from "./turnaround.js";
import { formatClock, toIso } from "./time.js";

/**
 * 只读投影：把事件折叠出的状态计算为“运行人员视角”的过站时间线。
 *
 * 关键路径口径：
 *   对每个任务做正向 CPM——ES/EF 取前置 EF 的最大值（拓扑顺序天然成立：
 *   依赖必须先编排且禁止成环）。
 *   - 计划视图：时长取计划窗口，得到计划最早可关舱时刻；
 *   - 预计视图：已完成取实际时长与实际完成时刻；进行中/暂停取“已耗工时
 *     + 剩余计划工时”推算 EF；未开始取计划时长。
 *   关舱（DOOR_CLOSE）作为汇聚所有任务的虚拟终节点。
 */

const STATUS_LABEL = Object.freeze({
  PENDING: "未开始",
  IN_PROGRESS: "进行中",
  PAUSED: "已暂停",
  COMPLETED: "已完成",
});

function taskViews(leg) {
  const views = new Map();
  for (const task of leg.tasks.values()) {
    const binding = bindingFor(task, leg.aircraftRegistration);
    views.set(task.taskCode, {
      task,
      binding,
      planDuration: task.plannedEnd - task.plannedStart,
      // 旧飞机遗留的尝试（换机后仅作展示，不参与计算）。
      staleAttempts: task.attempts.filter((a) => a.aircraftRegistration !== leg.aircraftRegistration),
    });
  }
  return views;
}

function cpm(views, mode, nowMs) {
  const ef = new Map();
  const es = new Map();
  const predecessor = new Map(); // taskCode -> 决定其最早开始的那个前置

  // views 的插入顺序即编排顺序：依赖必须先编排且禁止成环，故为拓扑序。
  for (const code of views.keys()) {
    const { task, binding, planDuration } = views.get(code);

    let base = Number.NEGATIVE_INFINITY;
    let baseDep = null;
    for (const dep of task.dependsOn) {
      const depEf = ef.get(dep);
      if (depEf !== undefined && depEf > base) {
        base = depEf;
        baseDep = dep;
      }
    }
    if (baseDep !== null) predecessor.set(code, baseDep);

    let start;
    let finish;

    if (mode === "actual" && binding.status === "COMPLETED") {
      // 已完成：以实际时刻为事实。
      finish = binding.completedAt;
      start = binding.startedAt ?? Math.min(binding.completedAt, task.plannedStart);
    } else if (mode === "actual" && (binding.status === "IN_PROGRESS" || binding.status === "PAUSED")) {
      // 进行中/暂停：已耗工时 + 剩余计划工时，暂停期间不计工时。
      const usedMs =
        binding.activeWorkMs +
        (binding.status === "IN_PROGRESS" && binding.workEpochStart != null
          ? nowMs - binding.workEpochStart
          : 0);
      const remainingMs = Math.max(0, planDuration - usedMs);
      start = binding.startedAt;
      finish = nowMs + remainingMs;
    } else {
      // 计划视图，或实际视图下尚未开始的任务。
      start = task.plannedStart;
      if (base !== Number.NEGATIVE_INFINITY) start = Math.max(start, base);
      finish = start + planDuration;
      es.set(code, start);
      ef.set(code, finish);
      continue;
    }

    es.set(code, start);
    ef.set(code, finish);
  }

  return { es, ef, predecessor };
}

/**
 * 计算投影。nowMs 用于推算进行中任务的剩余完成时刻。
 */
export function projectLeg(leg, nowMs) {
  const views = taskViews(leg);
  const codes = [...views.keys()];

  // 计划 CPM
  const plan = cpm(views, "plan", nowMs);
  let planDoorClose = leg.scheduledDoorClose;
  for (const code of codes) {
    if (plan.ef.get(code) > planDoorClose) planDoorClose = plan.ef.get(code);
  }

  // 预计 CPM
  const forecast = cpm(views, "actual", nowMs);
  let forecastDoorClose = leg.scheduledDoorClose;
  for (const code of codes) {
    if (forecast.ef.get(code) > forecastDoorClose) forecastDoorClose = forecast.ef.get(code);
  }
  const forecastCriticalChain = criticalChain(forecast.ef, forecast.predecessor, codes, leg.scheduledDoorClose);

  const delayMs = forecastDoorClose - leg.scheduledDoorClose;
  const tasks = codes.map((code) => {
    const { task, binding, staleAttempts } = views.get(code);
    const last = binding.lastEffective;
    return {
      taskCode: task.taskCode,
      responsibleUnit: task.responsibleUnit,
      dependsOn: task.dependsOn,
      planVersion: leg.planVersion,
      plannedStart: toIso(task.plannedStart),
      plannedEnd: toIso(task.plannedEnd),
      status: binding.status,
      statusLabel: STATUS_LABEL[binding.status],
      startedAt: binding.startedAt == null ? null : toIso(binding.startedAt),
      pausedAt: binding.pausedAt == null ? null : toIso(binding.pausedAt),
      completedAt: binding.completedAt == null ? null : toIso(binding.completedAt),
      forecastEnd: toIso(forecast.ef.get(code)),
      onCriticalPath: forecastCriticalChain.includes(code),
      lastEffectiveEvent: last
        ? {
            eventId: last.eventId,
            kind: last.kind,
            occurredAt: toIso(last.occurredAt),
            receivedAt: toIso(last.receivedAt),
            reporter: last.reporter,
          }
        : null,
      staleProgress: staleAttempts.length > 0,
      reports: task.attempts.map((a) => ({
        eventId: a.eventId,
        kind: a.kind,
        occurredAt: toIso(a.occurredAt),
        receivedAt: toIso(a.receivedAt),
        reporter: a.reporter,
        aircraftRegistration: a.aircraftRegistration,
        refEventId: a.refEventId,
        revoked: a.revoked,
        decision:
          a.kind === "CANCELLED"
            ? "EFFECTIVE"
            : a.revoked
              ? "REVOKED"
              : a.aircraftRegistration === leg.aircraftRegistration
                ? binding.decisions.get(a.eventId) ?? "IGNORED"
                : "SUPERSEDED_AIRCRAFT",
        reason: binding.reasons.get(a.eventId) ?? null,
      })),
    };
  });

  const blockers = deriveBlockers(leg, views, forecast, nowMs);
  const delayReason = deriveDelayReason(leg, views, forecast, forecastDoorClose, forecastCriticalChain, nowMs);

  return {
    flightLegId: leg.flightLegId,
    aircraftRegistration: leg.aircraftRegistration,
    planVersion: leg.planVersion,
    scheduledDoorClose: toIso(leg.scheduledDoorClose),
    plannedEarliestDoorClose: toIso(planDoorClose),
    forecastEarliestDoorClose: toIso(forecastDoorClose),
    delayMinutes: Math.max(0, Math.round(delayMs / 60000)),
    delayed: delayMs > 0,
    criticalPath: forecastCriticalChain,
    blockingTasks: blockers,
    delayReason,
    aircraftHistory: leg.aircraftHistory.map((h, index) => ({
      aircraftRegistration: h.aircraftRegistration,
      changedAt: toIso(h.changedAt),
      reason: index === 0 ? "初始执飞机号" : h.reason,
    })),
    planVersions: leg.planHistory.map((version) => ({
      version: version.version,
      reason: version.reason,
      changedBy: version.changedBy,
      changedAt: toIso(version.changedAt),
      changes: version.changes.map((change) => ({
        taskCode: change.taskCode,
        plannedStart: toIso(change.plannedStart),
        plannedEnd: toIso(change.plannedEnd),
      })),
    })),
    tasks,
  };
}

function criticalChain(ef, predecessor, codes, targetDoorClose) {
  // 从 EF 最晚且顶破关舱点的任务回溯：每一步取把该任务最早开始顶到最大值的前置。
  let leaf = null;
  let best = targetDoorClose;
  for (const code of codes) {
    if (ef.get(code) > best) {
      best = ef.get(code);
      leaf = code;
    }
  }
  const chain = [];
  const guard = new Set();
  let current = leaf;
  while (current && !guard.has(current)) {
    guard.add(current);
    chain.push(current);
    current = predecessor.get(current) ?? null;
  }
  chain.reverse();
  return chain;
}

function deriveBlockers(leg, views, forecast, nowMs) {
  const blockers = [];

  // 1) 暂停中的任务直接阻塞。
  for (const code of views.keys()) {
    const { binding } = views.get(code);
    if (binding.status === "PAUSED") {
      blockers.push({
        taskCode: code,
        type: "PAUSED",
        message: `${code} 已暂停（${formatClock(binding.pausedAt)} 起），正阻塞其后续环节`,
        since: toIso(binding.pausedAt),
      });
    }
  }

  // 2) 已过预计开始时刻却仍未开始的前置任务。
  for (const code of views.keys()) {
    const { task, binding } = views.get(code);
    if (binding.status !== "PENDING") continue;
    const downstream = [...views.keys()].filter((c) => views.get(c).task.dependsOn.includes(code));
    const shouldHaveStarted =
      task.plannedStart <= nowMs || downstream.some((d) => views.get(d).binding.status !== "PENDING");
    if (shouldHaveStarted) {
      blockers.push({
        taskCode: code,
        type: "NOT_STARTED",
        message: `${code} 计划 ${formatClock(task.plannedStart)} 开始，截至 ${formatClock(nowMs)} 仍无有效开始上报`,
        since: toIso(task.plannedStart),
      });
    }
  }

  // 3) 前置未完成、后继已抢跑。
  for (const code of views.keys()) {
    const { task, binding } = views.get(code);
    if (binding.status === "PENDING") continue;
    for (const dep of task.dependsOn) {
      const depBinding = views.get(dep).binding;
      if (depBinding.status !== "COMPLETED") {
        blockers.push({
          taskCode: code,
          type: "DEPENDENCY_OPEN",
          message: `${code} 已启动但前置 ${dep} 尚未完成（当前：${STATUS_LABEL[depBinding.status]}）`,
          since: toIso(binding.startedAt ?? nowMs),
        });
      }
    }
  }

  void forecast;
  void leg;
  return blockers;
}

function deriveDelayReason(leg, views, forecast, forecastDoorClose, chain, nowMs) {
  const delayMs = forecastDoorClose - leg.scheduledDoorClose;
  if (delayMs <= 0) {
    return {
      delayed: false,
      summary: `预计可在 ${formatClock(leg.scheduledDoorClose)} 的计划关舱时刻前完成，最早关舱 ${formatClock(
        forecastDoorClose,
      )}`,
      contributors: [],
    };
  }

  const contributors = [];
  for (const code of chain) {
    const { task, binding } = views.get(code);
    const plannedEnd = task.plannedEnd;
    const ef = forecast.ef.get(code);
    if (ef > plannedEnd) {
      let cause;
      if (binding.status === "COMPLETED") {
        cause = `实际完成 ${formatClock(binding.completedAt)}，晚于计划 ${formatClock(plannedEnd)}`;
      } else if (binding.status === "PAUSED") {
        cause = `处于暂停，剩余工时按计划外时间顺延`;
      } else if (binding.status === "IN_PROGRESS") {
        cause = `进行中但预计完成 ${formatClock(ef)}，晚于计划 ${formatClock(plannedEnd)}`;
      } else {
        // 未开始但被更前置的节点顶后。
        const dep = forecast.predecessor.get(code);
        cause = dep ? `等待前置 ${dep} 完成后方能开始` : "未按计划开始";
      }
      contributors.push({ taskCode: code, plannedEnd: toIso(plannedEnd), forecastEnd: toIso(ef), cause });
    }
  }

  const summary =
    contributors.length > 0
      ? `预计延误 ${Math.round(delayMs / 60000)} 分钟：关键路径 ${chain.join(" → ")}，` +
        contributors.map((c) => `${c.taskCode}（${c.cause}）`).join("；")
      : `预计延误 ${Math.round(delayMs / 60000)} 分钟`;

  void nowMs;
  return { delayed: true, summary, contributors };
}
