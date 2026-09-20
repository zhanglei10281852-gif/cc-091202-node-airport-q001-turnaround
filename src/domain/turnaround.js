import { ApiError } from "./errors.js";
import { parseInstant } from "./time.js";

/**
 * 过站协同核心：事件溯源（event sourcing）聚合。
 *
 * 所有事实都以事件形式一次性写入耐久日志，状态永远是“按日志顺序折叠事件”的
 * 结果——因此重启重放得到的判断与重启前严格一致。
 *
 * 进度上报（STARTED / PAUSED / RESUMED / COMPLETED / CANCELLED）不直接覆盖状态，
 * 而是追加为“尝试（attempt）”，再按日志顺序折叠：
 *   - 先到达的 COMPLETED 先被采信，之后迟到的 STARTED/其他完成时间不能倒退或改写；
 *   - 同态重复事件判为 REDUNDANT，非法跃迁判为 REJECTED；
 *   - CANCELLED 是显式撤销：作废此前一条上报后整体重新折叠。
 * 每次上报都按“当前执飞飞机”绑定；换机后新飞机得到全新的 PENDING 绑定，
 * 旧飞机尝试不参与新绑定的折叠（进度不自动继承）。
 */

export const REPORT_KINDS = Object.freeze(["STARTED", "PAUSED", "RESUMED", "COMPLETED", "CANCELLED"]);

function requireString(body, field, status = 400) {
  const value = body?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(status, "VALIDATION_FAILED", `字段 ${field} 不能为空`);
  }
  return value;
}

function legOrThrow(state, legId) {
  const leg = state.legs.get(legId);
  if (!leg) throw new ApiError(404, "LEG_NOT_FOUND", `航班航段 ${legId} 不存在`);
  return leg;
}

function taskOrThrow(leg, taskCode) {
  const task = leg.tasks.get(taskCode);
  if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `任务 ${taskCode} 在该航段不存在`);
  return task;
}

export function createState() {
  return { legs: new Map(), reportEventIds: new Map() };
}

/** 依赖图中加入 (deps -> taskCode) 后是否成环。 */
function wouldCreateCycle(leg, taskCode, deps) {
  const stack = [...deps];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === taskCode) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const node = leg.tasks.get(current);
    if (node) stack.push(...node.dependsOn);
  }
  return false;
}

/* -------------------------------- 命令侧校验 -------------------------------- */

function validate(state, event) {
  switch (event.type) {
    case "FLIGHT_LEG_SCHEDULED": {
      requireString(event, "flightLegId");
      requireString(event, "aircraftRegistration");
      if (!Number.isFinite(event.scheduledDoorClose)) {
        throw new ApiError(400, "VALIDATION_FAILED", "scheduledDoorClose 必须是 ISO 8601 时刻");
      }
      if (state.legs.has(event.flightLegId)) {
        throw new ApiError(409, "LEG_ALREADY_EXISTS", `航班航段 ${event.flightLegId} 已存在`);
      }
      return;
    }

    case "TASK_SCHEDULED": {
      const leg = legOrThrow(state, event.flightLegId);
      requireString(event, "taskCode");
      requireString(event, "responsibleUnit");
      if (leg.tasks.has(event.taskCode)) {
        throw new ApiError(409, "TASK_ALREADY_EXISTS", `任务 ${event.taskCode} 在该航段已存在`);
      }
      if (!Number.isFinite(event.plannedStart) || !Number.isFinite(event.plannedEnd)) {
        throw new ApiError(400, "VALIDATION_FAILED", "计划起止时刻必须是 ISO 8601");
      }
      if (event.plannedStart >= event.plannedEnd) {
        throw new ApiError(400, "VALIDATION_FAILED", "计划开始必须早于计划完成");
      }
      const deps = event.dependsOn ?? [];
      if (!Array.isArray(deps) || deps.some((d) => typeof d !== "string")) {
        throw new ApiError(400, "VALIDATION_FAILED", "dependsOn 必须为任务编号数组");
      }
      if (new Set(deps).size !== deps.length) {
        throw new ApiError(400, "VALIDATION_FAILED", "dependsOn 存在重复依赖");
      }
      for (const dep of deps) {
        if (!leg.tasks.has(dep)) {
          throw new ApiError(400, "UNKNOWN_DEPENDENCY", `前置任务 ${dep} 尚未编排`);
        }
      }
      if (wouldCreateCycle(leg, event.taskCode, deps)) {
        throw new ApiError(400, "DEPENDENCY_CYCLE", `加入 ${event.taskCode} 后依赖图成环`);
      }
      return;
    }

    case "TASK_PROGRESS_REPORTED": {
      const leg = legOrThrow(state, event.flightLegId);
      const task = taskOrThrow(leg, event.taskCode);
      requireString(event, "eventId");
      if (state.reportEventIds.has(event.eventId)) {
        throw new ApiError(409, "DUPLICATE_EVENT", `事件 ${event.eventId} 已接收过`);
      }
      if (!REPORT_KINDS.includes(event.kind)) {
        throw new ApiError(400, "VALIDATION_FAILED", `kind 必须是 ${REPORT_KINDS.join("/")}`);
      }
      if (!Number.isFinite(event.occurredAt)) {
        throw new ApiError(400, "VALIDATION_FAILED", "occurredAt 必须是 ISO 8601 时刻");
      }
      if (event.aircraftRegistration && event.aircraftRegistration !== leg.aircraftRegistration) {
        throw new ApiError(
          409,
          "AIRCRAFT_MISMATCH",
          `该航段当前执飞飞机为 ${leg.aircraftRegistration}，${event.aircraftRegistration} 为旧机或外单位机号，旧机进度不继承`,
        );
      }
      if (event.kind === "CANCELLED") {
        requireString(event, "refEventId");
        const ref = task.attempts.find((a) => a.eventId === event.refEventId);
        if (!ref || ref.aircraftRegistration !== leg.aircraftRegistration) {
          throw new ApiError(404, "REF_EVENT_NOT_FOUND", "被撤销事件不存在或属于另一架飞机");
        }
        if (ref.kind === "CANCELLED") {
          throw new ApiError(400, "CANNOT_CANCEL_CANCELLATION", "不能撤销一条撤销事件");
        }
        if (ref.revoked) {
          throw new ApiError(409, "EVENT_ALREADY_REVOKED", `事件 ${event.refEventId} 已被撤销`);
        }
      }
      return;
    }

    case "AIRCRAFT_REASSIGNED": {
      const leg = legOrThrow(state, event.flightLegId);
      requireString(event, "aircraftRegistration");
      if (event.aircraftRegistration === leg.aircraftRegistration) {
        throw new ApiError(400, "SAME_AIRCRAFT", "新机号与当前机号相同");
      }
      return;
    }

    case "PLAN_ADJUSTED": {
      const leg = legOrThrow(state, event.flightLegId);
      requireString(event, "reason");
      if (!Array.isArray(event.changes) || event.changes.length === 0) {
        throw new ApiError(400, "VALIDATION_FAILED", "changes 至少包含一项调整");
      }
      const codes = new Set();
      for (const change of event.changes) {
        taskOrThrow(leg, change.taskCode);
        if (codes.has(change.taskCode)) {
          throw new ApiError(400, "VALIDATION_FAILED", `任务 ${change.taskCode} 在同一版本中被多次调整`);
        }
        codes.add(change.taskCode);
        if (!Number.isFinite(change.plannedStart) || !Number.isFinite(change.plannedEnd)) {
          throw new ApiError(400, "VALIDATION_FAILED", "计划起止时刻必须是 ISO 8601");
        }
        if (change.plannedStart >= change.plannedEnd) {
          throw new ApiError(400, "VALIDATION_FAILED", "计划开始必须早于计划完成");
        }
        // 已经发生（开始/暂停/完成）的节点不得被新计划改写。
        const task = leg.tasks.get(change.taskCode);
        const binding = foldBinding(attemptsFor(task, leg.aircraftRegistration));
        if (binding.status !== "PENDING") {
          throw new ApiError(
            409,
            "ACTUAL_FROZEN",
            `任务 ${change.taskCode} 已有实际上报（当前 ${binding.status}），已发生节点不随新计划改写`,
          );
        }
      }
      return;
    }

    default:
      throw new ApiError(400, "UNKNOWN_EVENT_TYPE", `未知事件类型 ${event.type}`);
  }
}

/* -------------------------------- 状态折叠 -------------------------------- */

function attemptsFor(task, reg) {
  return task.attempts.filter((a) => a.aircraftRegistration === reg);
}

/**
 * 按日志顺序折叠某一飞机绑定下的全部上报尝试，得到确定状态。
 * 纯函数：同一组事件永远得到同一结果（重启一致性、并发确定性的基础）。
 */
export function foldBinding(attempts) {
  const result = {
    status: "PENDING",
    startedAt: null,
    pausedAt: null,
    completedAt: null,
    lastEffective: null,
    activeWorkMs: 0,
    workEpochStart: null,
    effectiveEventIds: new Set(),
    decisions: new Map(), // eventId -> EFFECTIVE | REDUNDANT | REJECTED
    reasons: new Map(),
  };

  const reject = (attempt, reason) => {
    result.decisions.set(attempt.eventId, "REJECTED");
    result.reasons.set(attempt.eventId, reason);
  };
  const redundant = (attempt, reason) => {
    result.decisions.set(attempt.eventId, "REDUNDANT");
    result.reasons.set(attempt.eventId, reason);
  };
  const effective = (attempt) => {
    result.decisions.set(attempt.eventId, "EFFECTIVE");
    result.effectiveEventIds.add(attempt.eventId);
    result.lastEffective = attempt;
  };

  for (const attempt of attempts) {
    if (attempt.revoked || attempt.kind === "CANCELLED") continue;
    const at = attempt.occurredAt;
    switch (attempt.kind) {
      case "STARTED": {
        if (result.status === "COMPLETED") {
          if (at < result.completedAt) {
            // 乱序补录：开始时刻早于已采信的完成时刻，仅补全事实，状态不倒退。
            if (result.startedAt === null || at < result.startedAt) result.startedAt = at;
            redundant(attempt, "迟到的开始上报仅补录，已采信的完成事实不变");
          } else {
            reject(attempt, "任务已完成，晚于完成时刻的开始上报不得倒退事实");
          }
        } else if (result.status === "IN_PROGRESS") {
          redundant(attempt, "任务已在进行中，重复开始事件无效");
        } else if (result.status === "PAUSED") {
          // 暂停态下的 STARTED 宽容地视为恢复；暂停区间不计工时。
          result.pausedAt = null;
          result.status = "IN_PROGRESS";
          result.workEpochStart = at;
          effective(attempt);
        } else {
          result.status = "IN_PROGRESS";
          result.startedAt = at;
          result.workEpochStart = at;
          effective(attempt);
        }
        break;
      }
      case "PAUSED": {
        if (result.status === "COMPLETED") {
          reject(attempt, "任务已完成，暂停事件无效");
        } else if (result.status === "PAUSED") {
          redundant(attempt, "任务已处于暂停，重复暂停事件无效");
        } else if (result.status === "PENDING") {
          reject(attempt, "任务尚未开始，无法暂停");
        } else {
          result.status = "PAUSED";
          result.pausedAt = at;
          result.activeWorkMs += at - result.workEpochStart;
          result.workEpochStart = null;
          effective(attempt);
        }
        break;
      }
      case "RESUMED": {
        if (result.status === "COMPLETED") {
          reject(attempt, "任务已完成，恢复事件无效");
        } else if (result.status === "IN_PROGRESS") {
          redundant(attempt, "任务进行中，重复恢复事件无效");
        } else if (result.status === "PENDING") {
          reject(attempt, "任务尚未开始，无法恢复");
        } else {
          // 恢复只开启新的工作纪元；暂停区间（pausedAt → at）不计工时。
          result.status = "IN_PROGRESS";
          result.pausedAt = null;
          result.workEpochStart = at;
          effective(attempt);
        }
        break;
      }
      case "COMPLETED": {
        if (result.status === "COMPLETED") {
          reject(attempt, "完成时间已先行采信，重复完成不得改写");
        } else {
          if (result.status === "PAUSED") {
            result.pausedAt = null;
          }
          result.workEpochStart = null;
          result.status = "COMPLETED";
          result.completedAt = at;
          effective(attempt);
        }
        break;
      }
    }
  }

  return result;
}

export function bindingFor(task, reg) {
  return foldBinding(attemptsFor(task, reg));
}

function applyUnchecked(state, event) {
  switch (event.type) {
    case "FLIGHT_LEG_SCHEDULED": {
      state.legs.set(event.flightLegId, {
        flightLegId: event.flightLegId,
        aircraftRegistration: event.aircraftRegistration,
        turnaroundStart: event.turnaroundStart ?? null,
        scheduledDoorClose: event.scheduledDoorClose,
        createdAt: event.at,
        planVersion: 1,
        planHistory: [
          { version: 1, reason: "初始编排", changedBy: event.changedBy ?? "system", changedAt: event.at, changes: [] },
        ],
        aircraftHistory: [{ aircraftRegistration: event.aircraftRegistration, changedAt: event.at, reason: "初始执飞机号" }],
        tasks: new Map(),
      });
      return;
    }

    case "TASK_SCHEDULED": {
      const leg = state.legs.get(event.flightLegId);
      leg.tasks.set(event.taskCode, {
        taskCode: event.taskCode,
        responsibleUnit: event.responsibleUnit,
        dependsOn: event.dependsOn ?? [],
        plannedStart: event.plannedStart,
        plannedEnd: event.plannedEnd,
        scheduledAt: event.at,
        attempts: [],
      });
      return;
    }

    case "TASK_PROGRESS_REPORTED": {
      const leg = state.legs.get(event.flightLegId);
      const task = leg.tasks.get(event.taskCode);
      task.attempts.push({
        seq: event.seq,
        eventId: event.eventId,
        kind: event.kind,
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt,
        reporter: event.reporter ?? null,
        note: event.note ?? null,
        aircraftRegistration: leg.aircraftRegistration,
        refEventId: event.refEventId ?? null,
        revoked: false,
      });
      state.reportEventIds.set(event.eventId, {
        flightLegId: event.flightLegId,
        taskCode: event.taskCode,
      });
      if (event.kind === "CANCELLED") {
        const ref = task.attempts.find((a) => a.eventId === event.refEventId);
        ref.revoked = true;
      }
      return;
    }

    case "AIRCRAFT_REASSIGNED": {
      const leg = state.legs.get(event.flightLegId);
      leg.aircraftHistory.push({
        aircraftRegistration: event.aircraftRegistration,
        changedAt: event.at,
        reason: event.reason ?? "换机",
      });
      leg.aircraftRegistration = event.aircraftRegistration;
      // 不为新飞机创建任何绑定/进度：首次查询或上报时按全新 PENDING 处理。
      return;
    }

    case "PLAN_ADJUSTED": {
      const leg = state.legs.get(event.flightLegId);
      leg.planVersion += 1;
      for (const change of event.changes) {
        const task = leg.tasks.get(change.taskCode);
        task.plannedStart = change.plannedStart;
        task.plannedEnd = change.plannedEnd;
      }
      leg.planHistory.push({
        version: leg.planVersion,
        reason: event.reason,
        changedBy: event.changedBy ?? null,
        changedAt: event.at,
        changes: event.changes,
      });
      return;
    }
  }
}

/** 从耐久事件完整重放出状态（重启恢复路径）。 */
export function replay(events) {
  const state = createState();
  for (const event of events) applyUnchecked(state, event);
  return state;
}

/* ------------------------------- 命令服务 -------------------------------- */

export class TurnaroundService {
  #state;
  #store;
  #clock;
  #chain = Promise.resolve();

  constructor(store, clock = () => Date.now()) {
    this.#store = store;
    this.#clock = clock;
    this.#state = replay(store.replay());
  }

  get state() {
    return this.#state;
  }

  now() {
    return this.#clock();
  }

  /** 所有命令经单条 Promise 链串行化：并发更新得到全序，当前状态唯一确定。 */
  #serialize(job) {
    const run = this.#chain.then(() => job());
    // 防止单个失败污染整条链。
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #commit(event) {
    validate(this.#state, event);
    const stored = { ...event, seq: this.#store.length + 1 };
    this.#store.appendBatch([stored]);
    applyUnchecked(this.#state, stored);
    return stored;
  }

  scheduleLeg(input) {
    const at = this.#clock();
    const event = {
      type: "FLIGHT_LEG_SCHEDULED",
      at,
      flightLegId: requireString(input, "flightLegId"),
      aircraftRegistration: requireString(input, "aircraftRegistration"),
      turnaroundStart:
        input.turnaroundStart == null ? null : parseInstant(input.turnaroundStart, "turnaroundStart"),
      scheduledDoorClose: parseInstant(
        requireString(input, "scheduledDoorClose"),
        "scheduledDoorClose",
      ),
      changedBy: input.changedBy ?? null,
    };
    return this.#serialize(() => this.#commit(event));
  }

  scheduleTask(legId, input) {
    const at = this.#clock();
    const event = {
      type: "TASK_SCHEDULED",
      at,
      flightLegId: legId,
      taskCode: requireString(input, "taskCode"),
      responsibleUnit: requireString(input, "responsibleUnit"),
      dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn : [],
      plannedStart: parseInstant(requireString(input, "plannedStart"), "plannedStart"),
      plannedEnd: parseInstant(requireString(input, "plannedEnd"), "plannedEnd"),
    };
    return this.#serialize(() => this.#commit(event));
  }

  report(legId, input) {
    const receivedAt = input.receivedAt == null ? this.#clock() : parseInstant(input.receivedAt, "receivedAt");
    const event = {
      type: "TASK_PROGRESS_REPORTED",
      at: receivedAt,
      flightLegId: legId,
      eventId: requireString(input, "eventId"),
      taskCode: requireString(input, "taskCode"),
      kind: requireString(input, "kind"),
      occurredAt: parseInstant(requireString(input, "occurredAt"), "occurredAt"),
      receivedAt,
      reporter: input.reporter ?? null,
      note: input.note ?? null,
      aircraftRegistration: input.aircraftRegistration ?? null,
      refEventId: input.refEventId ?? null,
    };
    return this.#serialize(() => {
      if (this.#state.reportEventIds.has(event.eventId)) {
        return { duplicated: true, event: null };
      }
      return { duplicated: false, event: this.#commit(event) };
    });
  }

  reassign(legId, input) {
    const at = input.occurredAt == null ? this.#clock() : parseInstant(input.occurredAt, "occurredAt");
    const event = {
      type: "AIRCRAFT_REASSIGNED",
      at,
      flightLegId: legId,
      aircraftRegistration: requireString(input, "aircraftRegistration"),
      reason: input.reason ?? null,
      changedBy: input.changedBy ?? null,
    };
    return this.#serialize(() => this.#commit(event));
  }

  adjustPlan(legId, input) {
    const at = input.occurredAt == null ? this.#clock() : parseInstant(input.occurredAt, "occurredAt");
    const changes = (input.changes ?? []).map((change) => ({
      taskCode: requireString(change, "taskCode"),
      plannedStart: parseInstant(requireString(change, "plannedStart"), "plannedStart"),
      plannedEnd: parseInstant(requireString(change, "plannedEnd"), "plannedEnd"),
    }));
    const event = {
      type: "PLAN_ADJUSTED",
      at,
      flightLegId: legId,
      reason: requireString(input, "reason"),
      changedBy: input.changedBy ?? null,
      changes,
    };
    return this.#serialize(() => this.#commit(event));
  }

  /** 用于启动引导：把 fixtures 风格的混合记录灌入空库。 */
  ingestRecord(legId, record) {
    if (record.eventId) {
      return this.report(legId, record);
    }
    if (record.taskCode) {
      return this.scheduleTask(legId, record);
    }
    return this.scheduleLeg(record);
  }
}
