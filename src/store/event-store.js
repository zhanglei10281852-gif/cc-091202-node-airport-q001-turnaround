// 只追加的事件存储：所有事实以 JSONL 落盘，启动时重放恢复。
// 写入经过单条串行队列，并发上报只会形成确定的一条日志顺序。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DomainError, reduceLeg } from "../domain/timeline.js";

export class EventStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.eventsByLeg = new Map(); // legId -> 原始事件数组（落盘顺序）
    this.knownIds = new Set(); // 全局 eventId 去重
    this.writeChain = Promise.resolve();
  }

  load() {
    if (!existsSync(this.filePath)) return;
    const lines = readFileSync(this.filePath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed);
      this.#ingest(event);
    }
  }

  #ingest(event) {
    if (this.knownIds.has(event.eventId)) {
      throw new DomainError(`事件编号重复: ${event.eventId}`, 409, "duplicate_event");
    }
    this.knownIds.add(event.eventId);
    if (!this.eventsByLeg.has(event.legId)) this.eventsByLeg.set(event.legId, []);
    this.eventsByLeg.get(event.legId).push(event);
  }

  /** 串行化“校验 + 追加”，并发请求也只会产生唯一确定的日志顺序。 */
  append(event) {
    const result = this.writeChain.then(() => this.#appendNow(event));
    // 失败不能击穿串行链，否则后续请求会被跳过。
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #appendNow(event) {
    return new Promise((resolve, reject) => {
      try {
        if (this.knownIds.has(event.eventId)) {
          throw new DomainError(`事件编号重复: ${event.eventId}`, 409, "duplicate_event");
        }
        const priorEvents = this.eventsByLeg.get(event.legId) ?? [];
        if (event.kind !== "LEG_SCHEDULED" && priorEvents.length === 0) {
          throw new DomainError(`航段不存在: ${event.legId}`, 404, "leg_not_found");
        }
        // 计划版本号在串行锁内分配，并发修订也只会得到唯一递增版本。
        if (event.kind === "PLAN_REVISED") {
          const leg = reduceLeg(priorEvents);
          event = { ...event, version: leg.planVersion + 1 };
        }
        validateEvent(event, priorEvents);

        mkdirSync(dirname(this.filePath), { recursive: true });
        appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);
        this.#ingest(event);
        resolve(event);
      } catch (error) {
        reject(error);
      }
    });
  }

  listLegs() {
    return [...this.eventsByLeg.keys()];
  }

  getEvents(legId) {
    return this.eventsByLeg.get(legId) ?? null;
  }

  /** 重放得到当前航段聚合；重启后对同一日志得到同一结果。 */
  getLeg(legId) {
    const events = this.getEvents(legId);
    if (!events) return null;
    return reduceLeg(events);
  }
}

const TASK_KINDS = new Set(["STARTED", "PAUSED", "RESUMED", "COMPLETED"]);

function validateEvent(event, priorEvents) {
  if (!event.kind) throw new DomainError("事件缺少 kind");
  if (!event.occurredAt) throw new DomainError("事件缺少 occurredAt");
  if (Number.isNaN(Date.parse(event.occurredAt))) {
    throw new DomainError(`occurredAt 不是合法时间: ${event.occurredAt}`);
  }

  if (event.kind === "LEG_SCHEDULED") return;

  const leg = reduceLeg(priorEvents);
  if (!leg) throw new DomainError("航段尚未建立", 404, "leg_not_found");
  const taskCodes = new Set(leg.tasks.map((t) => t.code));

  if (TASK_KINDS.has(event.kind)) {
    if (!event.taskCode || !taskCodes.has(event.taskCode)) {
      throw new DomainError(`事件引用了不存在的任务: ${event.taskCode}`);
    }
    // 试运行：保证该事件落盘后任何时候重放都不会失败。
    reduceLeg([...priorEvents, event]);
    return;
  }

  if (event.kind === "REVOKED") {
    if (!event.refEventId) throw new DomainError("REVOKED 事件需要 refEventId");
    const target = priorEvents.find((e) => e.eventId === event.refEventId);
    if (!target) throw new DomainError(`被撤销事件不存在: ${event.refEventId}`, 404);
    if (!TASK_KINDS.has(target.kind)) {
      throw new DomainError("只能撤销任务上报（STARTED/PAUSED/RESUMED/COMPLETED）");
    }
    const alreadyRevoked = priorEvents.some(
      (e) => e.kind === "REVOKED" && e.refEventId === event.refEventId,
    );
    if (alreadyRevoked) throw new DomainError("该上报已被撤销", 409);
    return;
  }

  if (event.kind === "AIRCRAFT_CHANGED") {
    if (!event.newRegistration) throw new DomainError("AIRCRAFT_CHANGED 需要 newRegistration");
    reduceLeg([...priorEvents, event]);
    return;
  }

  if (event.kind === "PLAN_REVISED") {
    if (!event.changes || typeof event.changes !== "object") {
      throw new DomainError("PLAN_REVISED 需要 changes");
    }
    for (const code of Object.keys(event.changes)) {
      if (!taskCodes.has(code)) throw new DomainError(`修订引用了不存在的任务: ${code}`);
    }
    if (!event.reason) throw new DomainError("人工修订计划必须填写 reason");
    reduceLeg([...priorEvents, { ...event, version: reduceLeg(priorEvents).planVersion + 1 }]);
    return;
  }

  throw new DomainError(`未知事件类型: ${event.kind}`);
}
