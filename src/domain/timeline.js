// 过站协同领域核心：事件排序、状态机重放、关键路径投影。
// 全部为纯函数，判断结果只取决于事件集合与 asOf，便于重启后重放得到一致结论。

const TASK_KINDS = new Set(["STARTED", "PAUSED", "RESUMED", "COMPLETED"]);

export class DomainError extends Error {
  constructor(message, status = 400, code = "invalid_event") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseTime(value, field = "time") {
  if (typeof value !== "string") {
    throw new DomainError(`${field} 必须是 ISO 8601 字符串`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new DomainError(`${field} 不是合法时间: ${value}`);
  }
  return ms;
}

/** 有效事件的全序：发生时刻 → 接收时刻 → 事件编号，保证乱序到达后处理确定。 */
function eventOrder(e) {
  return [parseTime(e.occurredAt), parseTime(e.receivedAt ?? e.occurredAt), e.eventId];
}

function compareEvents(a, b) {
  const ta = eventOrder(a);
  const tb = eventOrder(b);
  for (let i = 0; i < ta.length; i += 1) {
    if (ta[i] < tb[i]) return -1;
    if (ta[i] > tb[i]) return 1;
  }
  return 0;
}

function assertDag(tasks) {
  const byCode = new Map(tasks.map((t) => [t.code, t]));
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!byCode.has(dep)) {
        throw new DomainError(`任务 ${task.code} 依赖了不存在的任务 ${dep}`);
      }
    }
  }
  const visiting = new Set();
  const done = new Set();
  const visit = (code, stack) => {
    if (done.has(code)) return;
    if (visiting.has(code)) {
      throw new DomainError(`任务依赖存在环: ${[...stack, code].join(" -> ")}`);
    }
    visiting.add(code);
    for (const dep of byCode.get(code).dependsOn ?? []) {
      visit(dep, [...stack, code]);
    }
    visiting.delete(code);
    done.add(code);
  };
  for (const task of tasks) visit(task.code, []);
}

/** 把建航段请求归一化为一条 LEG_SCHEDULED 事件的载荷。 */
export function buildLegScheduled(input, nowIso) {
  const required = ["legId", "aircraftRegistration", "scheduledOffBlock"];
  for (const field of required) {
    if (!input?.[field]) throw new DomainError(`缺少字段 ${field}`);
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new DomainError("至少需要一个保障任务");
  }
  const tasks = input.tasks.map((t) => {
    for (const field of ["code", "plannedStart", "plannedEnd"]) {
      if (!t?.[field]) throw new DomainError(`任务缺少字段 ${field}`);
    }
    const start = parseTime(t.plannedStart, "plannedStart");
    const end = parseTime(t.plannedEnd, "plannedEnd");
    if (end <= start) {
      throw new DomainError(`任务 ${t.code} 的计划结束必须晚于计划开始`);
    }
    return {
      code: t.code,
      name: t.name ?? t.code,
      responsibleUnit: t.responsibleUnit ?? null,
      dependsOn: [...(t.dependsOn ?? [])],
      plannedStart: t.plannedStart,
      plannedEnd: t.plannedEnd,
    };
  });
  const codes = new Set();
  for (const t of tasks) {
    if (codes.has(t.code)) throw new DomainError(`任务编码重复: ${t.code}`);
    codes.add(t.code);
  }
  assertDag(tasks);

  const finalTaskCode = input.finalTaskCode ?? "BOARDING";
  if (!codes.has(finalTaskCode)) {
    throw new DomainError(`关舱终态任务 ${finalTaskCode} 不存在`);
  }
  parseTime(input.scheduledOffBlock, "scheduledOffBlock");
  // 计划建立时刻缺省取最早计划开始时刻，确保它不会晚于实际作业而污染投影基准时间。
  const scheduledAt =
    input.scheduledAt ??
    new Date(Math.min(...tasks.map((t) => parseTime(t.plannedStart)))).toISOString();

  return {
    eventId: `leg-${input.legId}`,
    kind: "LEG_SCHEDULED",
    legId: input.legId,
    occurredAt: scheduledAt,
    receivedAt: nowIso,
    flight: {
      legId: input.legId,
      flightNumber: input.flightNumber ?? null,
      origin: input.origin ?? null,
      destination: input.destination ?? null,
      scheduledOffBlock: input.scheduledOffBlock,
      finalTaskCode,
    },
    aircraftRegistration: input.aircraftRegistration,
    tasks,
  };
}

/**
 * 重放某个航段的全部事件，得到当前投影。
 * 事件只需保证 eventId 唯一；重复、乱序、撤销均在此处理。
 */
export function reduceLeg(events) {
  const seen = new Set();
  for (const e of events) {
    if (!e?.eventId) throw new DomainError("事件缺少 eventId");
    if (seen.has(e.eventId)) throw new DomainError(`事件编号重复: ${e.eventId}`, 409, "duplicate_event");
    seen.add(e.eventId);
  }

  // 撤销先收集：被撤销的上报视为从未发生。
  const revoked = new Set();
  for (const e of events) {
    if (e.kind === "REVOKED" && e.refEventId) revoked.add(e.refEventId);
  }
  const valid = events
    .filter((e) => e.kind !== "REVOKED" && !revoked.has(e.eventId))
    .sort(compareEvents);

  const scheduled = valid.find((e) => e.kind === "LEG_SCHEDULED");
  if (!scheduled) return null;

  const leg = {
    ...scheduled.flight,
    aircraftRegistration: scheduled.aircraftRegistration,
    initialRegistration: scheduled.aircraftRegistration,
    scheduledAt: scheduled.occurredAt,
    planVersion: 0,
    planHistory: [{ version: 0, reason: "初始计划", occurredAt: scheduled.occurredAt }],
    tasks: scheduled.tasks.map((t) => ({ ...t })),
    progress: new Map(),
    aircraftHistory: [],
    lastRevocation: null,
  };
  const planByCode = new Map(leg.tasks.map((t) => [t.code, t]));

  const snapshotProgress = () =>
    Object.fromEntries(
      [...leg.progress].map(([code, p]) => [
        code,
        {
          status: p.status,
          actualStartedAt: p.actualStartedAt,
          actualCompletedAt: p.actualCompletedAt,
        },
      ]),
    );

  for (const code of planByCode.keys()) {
    leg.progress.set(code, blankProgress());
  }

  for (const e of valid) {
    if (e.kind === "LEG_SCHEDULED") continue;

    if (e.kind === "AIRCRAFT_CHANGED") {
      if (e.newRegistration && e.newRegistration !== leg.aircraftRegistration) {
        leg.aircraftHistory.push({
          fromRegistration: leg.aircraftRegistration,
          toRegistration: e.newRegistration,
          occurredAt: e.occurredAt,
          reason: e.reason ?? null,
          // 旧飞机上的进度只归档、不继承。
          progress: snapshotProgress(),
        });
        leg.aircraftRegistration = e.newRegistration;
        for (const code of planByCode.keys()) leg.progress.set(code, blankProgress());
      }
      continue;
    }

    if (e.kind === "PLAN_REVISED") {
      const frozen = [];
      for (const [code, change] of Object.entries(e.changes ?? {})) {
        const task = planByCode.get(code);
        if (!task) throw new DomainError(`修订引用了不存在的任务 ${code}`);
        const status = leg.progress.get(code)?.status ?? "NOT_STARTED";
        if (status !== "NOT_STARTED") {
          // 已经发生的节点不随新计划改写。
          frozen.push(code);
          continue;
        }
        if (change.plannedStart !== undefined) task.plannedStart = change.plannedStart;
        if (change.plannedEnd !== undefined) task.plannedEnd = change.plannedEnd;
        if (change.dependsOn !== undefined) task.dependsOn = [...change.dependsOn];
        if (parseTime(task.plannedEnd) <= parseTime(task.plannedStart)) {
          throw new DomainError(`任务 ${code} 的计划结束必须晚于计划开始`);
        }
      }
      assertDag(leg.tasks);
      leg.planVersion = e.version;
      leg.planHistory.push({
        version: e.version,
        reason: e.reason,
        occurredAt: e.occurredAt,
        frozen,
      });
      continue;
    }

    if (!TASK_KINDS.has(e.kind)) {
      throw new DomainError(`未知事件类型: ${e.kind}`);
    }
    if (!planByCode.has(e.taskCode)) {
      throw new DomainError(`事件引用了不存在的任务 ${e.taskCode}`);
    }
    applyTaskEvent(leg.progress.get(e.taskCode), e);
  }

  // 最近一次有效上报：只看当前飞机上的未撤销任务上报；
  // 换机前旧飞机的上报留在事件日志与换机归档里，不作为当前上报。
  const lastChangeAt = leg.aircraftHistory.length
    ? parseTime(leg.aircraftHistory[leg.aircraftHistory.length - 1].occurredAt)
    : -Infinity;
  const taskReports = valid
    .filter((e) => TASK_KINDS.has(e.kind) && parseTime(e.occurredAt) >= lastChangeAt)
    .sort((a, b) => parseTime(b.receivedAt ?? b.occurredAt) - parseTime(a.receivedAt ?? a.occurredAt));
  const latestByTask = new Map();
  for (const r of taskReports) {
    if (!latestByTask.has(r.taskCode)) {
      latestByTask.set(r.taskCode, {
        eventId: r.eventId,
        kind: r.kind,
        occurredAt: r.occurredAt,
        receivedAt: r.receivedAt ?? r.occurredAt,
        responsibleUnit: r.responsibleUnit ?? planByCode.get(r.taskCode)?.responsibleUnit ?? null,
      });
    }
  }
  leg.latestReportByTask = latestByTask;

  const lastRevocation = [...events]
    .filter((e) => e.kind === "REVOKED")
    .sort((a, b) => parseTime(b.receivedAt ?? b.occurredAt) - parseTime(a.receivedAt ?? a.occurredAt))[0];
  leg.lastRevocation = lastRevocation
    ? {
        eventId: lastRevocation.eventId,
        refEventId: lastRevocation.refEventId,
        occurredAt: lastRevocation.occurredAt,
        reason: lastRevocation.reason ?? null,
      }
    : null;

  return leg;
}

function blankProgress() {
  return {
    status: "NOT_STARTED",
    actualStartedAt: null,
    actualCompletedAt: null,
    segments: [], // 实际开工区间，暂停时闭合
    activeSince: null,
  };
}

// 单调状态机：任何转移都不能让事实倒退。
function applyTaskEvent(p, e) {
  const at = parseTime(e.occurredAt);
  switch (e.kind) {
    case "STARTED":
      // 已完成、已在进行中的开工上报（含乱序迟到的）一律忽略。
      if (p.status === "COMPLETED" || p.status === "IN_PROGRESS") return;
      if (p.status === "PAUSED") {
        // 乱序场景：早于暂停的迟到 STARTED，忽略。
        return;
      }
      p.status = "IN_PROGRESS";
      p.actualStartedAt = e.occurredAt;
      p.activeSince = at;
      p.segments.push({ start: at });
      return;
    case "PAUSED":
      if (p.status !== "IN_PROGRESS") return;
      p.segments[p.segments.length - 1].end = at;
      p.activeSince = null;
      p.status = "PAUSED";
      return;
    case "RESUMED":
      if (p.status !== "PAUSED") return;
      p.status = "IN_PROGRESS";
      p.activeSince = at;
      p.segments.push({ start: at });
      return;
    case "COMPLETED": {
      // 多个完成时间只承认第一个事实，重复/乱序完成不倒退。
      if (p.status === "COMPLETED") return;
      if (p.status === "NOT_STARTED") p.actualStartedAt = e.occurredAt;
      if (p.activeSince !== null) p.segments[p.segments.length - 1].end = at;
      p.activeSince = null;
      p.status = "COMPLETED";
      p.actualCompletedAt = e.occurredAt;
      return;
    }
    default:
      return;
  }
}

const MINUTE = 60_000;

/**
 * 关键路径投影。asOf 默认为最新有效事件的发生时刻，
 * 因此同一事件集合在重启前后给出完全一致的判断。
 */
export function projectTimeline(leg, asOfInput) {
  const latestEventMs = Math.max(
    parseTime(leg.scheduledAt),
    ...(leg.aircraftHistory?.map((h) => parseTime(h.occurredAt)) ?? []),
    ...(leg.planHistory?.map((h) => parseTime(h.occurredAt)) ?? []),
    ...[...leg.progress.values()].flatMap((p) =>
      p.segments.flatMap((s) => [s.start, s.end].filter((v) => v !== null && v !== undefined)),
    ),
    ...(leg.latestReportByTask ? [...leg.latestReportByTask.values()].map((r) => parseTime(r.occurredAt)) : []),
  );
  const asOf = asOfInput ?? latestEventMs;

  const planByCode = new Map(leg.tasks.map((t) => [t.code, t]));
  const finish = new Map(); // 最早完成时刻 ms；null 表示被暂停等阻塞、无法承诺
  const basis = new Map(); // 每个任务完成时刻的计算说明
  const predecessorPick = new Map(); // 关键路径上选中的前置依赖

  const evaluate = (code) => {
    if (finish.has(code)) return finish.get(code);
    const task = planByCode.get(code);
    const p = leg.progress.get(code) ?? blankProgress();
    const plannedStart = parseTime(task.plannedStart);
    const plannedEnd = parseTime(task.plannedEnd);
    const duration = plannedEnd - plannedStart;

    if (p.status === "COMPLETED") {
      const ms = parseTime(p.actualCompletedAt);
      finish.set(code, ms);
      basis.set(code, { type: "actual", status: p.status });
      return ms;
    }

    // 依赖的最早完成。
    let depFinish = plannedStart;
    let blockingDep = null;
    for (const dep of task.dependsOn ?? []) {
      const df = evaluate(dep);
      if (df === null) {
        if (blockingDep === null) blockingDep = dep;
      } else if (df > depFinish) {
        depFinish = df;
      }
    }
    // 记录关键前置：优先记录造成阻塞的依赖，否则取最晚完成者。
    if (blockingDep !== null) {
      predecessorPick.set(code, blockingDep);
    } else if (task.dependsOn?.length) {
      let picked = task.dependsOn[0];
      for (const dep of task.dependsOn) {
        if ((finish.get(dep) ?? -Infinity) > (finish.get(picked) ?? -Infinity)) picked = dep;
      }
      predecessorPick.set(code, picked);
    }

    if (p.status === "PAUSED") {
      finish.set(code, null);
      basis.set(code, { type: "paused", since: segmentEndMs(p) });
      return null;
    }

    if (p.status === "IN_PROGRESS") {
      const activeMs = accumulatedActive(p, asOf);
      const remaining = Math.max(0, duration - activeMs);
      const ef = asOf + remaining;
      finish.set(code, ef);
      basis.set(code, { type: "active", remainingMinutes: Math.round(remaining / MINUTE) });
      return ef;
    }

    if (blockingDep !== null) {
      finish.set(code, null);
      basis.set(code, { type: "waiting_dependency", dependency: blockingDep });
      return null;
    }

    const ef = depFinish + duration;
    finish.set(code, ef);
    basis.set(code, { type: "planned", startMs: depFinish });
    return ef;
  };

  for (const code of planByCode.keys()) evaluate(code);

  // 回溯关键路径。
  const chain = [];
  let cursor = leg.finalTaskCode;
  const guard = new Set();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    chain.push(cursor);
    cursor = predecessorPick.get(cursor);
  }
  chain.reverse();

  const scheduled = parseTime(leg.scheduledOffBlock);
  const earliest = finish.get(leg.finalTaskCode);

  // 阻塞环节：关键链上第一个未完成任务。
  let blockedBy = null;
  for (const code of chain) {
    const p = leg.progress.get(code);
    if (p.status !== "COMPLETED") {
      blockedBy = {
        taskCode: code,
        status: p.status,
        reason:
          p.status === "PAUSED"
            ? "任务已暂停，等待恢复"
            : (basis.get(code)?.type === "waiting_dependency"
              ? `等待依赖任务 ${basis.get(code).dependency}`
              : "尚未开始"),
      };
      break;
    }
  }
  if (!blockedBy && earliest === null) {
    blockedBy = { taskCode: leg.finalTaskCode, status: "UNKNOWN", reason: "存在未解决的阻塞" };
  }

  // 延误归因：关键链上相对计划窗口的偏差。
  const reasons = [];
  for (const code of chain) {
    const task = planByCode.get(code);
    const p = leg.progress.get(code);
    const plannedEnd = parseTime(task.plannedEnd);
    const ef = finish.get(code);
    if (p.status === "COMPLETED") {
      const actual = parseTime(p.actualCompletedAt);
      if (actual > plannedEnd) {
        reasons.push({
          taskCode: code,
          type: "finished_late",
          minutesLate: Math.round((actual - plannedEnd) / MINUTE),
          message: `${task.name} 实际完成晚于计划 ${Math.round((actual - plannedEnd) / MINUTE)} 分钟`,
        });
      }
    } else if (p.status === "PAUSED") {
      reasons.push({
        taskCode: code,
        type: "paused",
        message: `${task.name} 已暂停，关舱时刻无法承诺`,
      });
    } else if (ef !== null && ef > plannedEnd) {
      reasons.push({
        taskCode: code,
        type: "projected_late",
        minutesLate: Math.round((ef - plannedEnd) / MINUTE),
        message: `${task.name} 预计完成晚于计划 ${Math.round((ef - plannedEnd) / MINUTE)} 分钟`,
      });
    }
  }

  const tasks = leg.tasks.map((task) => {
    const p = leg.progress.get(task.code);
    return {
      code: task.code,
      name: task.name,
      responsibleUnit: task.responsibleUnit,
      dependsOn: task.dependsOn,
      plannedStart: task.plannedStart,
      plannedEnd: task.plannedEnd,
      status: p.status,
      actualStartedAt: p.actualStartedAt ? new Date(p.actualStartedAt).toISOString() : null,
      actualCompletedAt: p.actualCompletedAt ? new Date(p.actualCompletedAt).toISOString() : null,
      projectedFinish: finish.get(task.code) === null ? null : new Date(finish.get(task.code)).toISOString(),
      onCriticalPath: chain.includes(task.code),
      lastReport: leg.latestReportByTask?.get(task.code) ?? null,
    };
  });

  return {
    leg: {
      legId: leg.legId,
      flightNumber: leg.flightNumber,
      origin: leg.origin,
      destination: leg.destination,
      aircraftRegistration: leg.aircraftRegistration,
      initialRegistration: leg.initialRegistration,
      scheduledOffBlock: leg.scheduledOffBlock,
      finalTaskCode: leg.finalTaskCode,
      planVersion: leg.planVersion,
      aircraftHistory: leg.aircraftHistory,
    },
    planHistory: leg.planHistory,
    asOf: new Date(asOf).toISOString(),
    tasks,
    criticalPath: {
      tasks: chain,
      scheduledOffBlock: leg.scheduledOffBlock,
      earliestOffBlock: earliest === null ? null : new Date(earliest).toISOString(),
      delayMinutes: earliest === null ? null : Math.max(0, Math.round((earliest - scheduled) / MINUTE)),
      isDelayed: earliest !== null && earliest > scheduled,
      blockedBy,
      reasons,
    },
    lastRevocation: leg.lastRevocation,
  };
}

function segmentEndMs(p) {
  const last = p.segments[p.segments.length - 1];
  return last?.end ?? null;
}

function accumulatedActive(p, asOf) {
  let total = 0;
  for (const s of p.segments) {
    const end = s.end ?? asOf;
    total += Math.max(0, end - s.start);
  }
  return total;
}
