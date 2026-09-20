import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { EventStore } from "./store/event-store.js";
import { DomainError, buildLegScheduled, parseTime, projectTimeline } from "./domain/timeline.js";

export function buildApp(store) {
  async function readJson(request) {
    if (request.method === "GET") return {};
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new DomainError("请求体不是合法 JSON");
    }
  }

  function send(response, status, body) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }

  const routes = [];
  const route = (method, pattern, handler) => {
    routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });
  };

  route("GET", "/health", async () => ({ status: "ok" }));

  route("POST", "/legs", async (req, body, now) => {
    const event = buildLegScheduled(body, now());
    await store.append(event);
    return { legId: event.legId, eventId: event.eventId, planVersion: 0 };
  });

  route("GET", "/legs", async () => ({
    legs: store.listLegs().map((legId) => {
      const leg = store.getLeg(legId);
      return {
        legId,
        flightNumber: leg.flightNumber,
        aircraftRegistration: leg.aircraftRegistration,
        scheduledOffBlock: leg.scheduledOffBlock,
        planVersion: leg.planVersion,
      };
    }),
  }));

  route("GET", "/legs/(?<legId>[^/]+)", async (req) => {
    const leg = store.getLeg(req.params.legId);
    if (!leg) throw new DomainError("航段不存在", 404, "leg_not_found");
    const asOf = req.query.asOf ? parseTime(req.query.asOf, "asOf") : undefined;
    return projectTimeline(leg, asOf);
  });

  route("GET", "/legs/(?<legId>[^/]+)/events", async (req) => {
    const events = store.getEvents(req.params.legId);
    if (!events) throw new DomainError("航段不存在", 404, "leg_not_found");
    return { legId: req.params.legId, events };
  });

  // 责任单位上报：开始 / 暂停 / 恢复 / 完成。
  route("POST", "/legs/(?<legId>[^/]+)/tasks/(?<taskCode>[^/]+)/reports", async (req, body, now) => {
    const kind = body.kind;
    if (!["STARTED", "PAUSED", "RESUMED", "COMPLETED"].includes(kind)) {
      throw new DomainError("kind 必须是 STARTED/PAUSED/RESUMED/COMPLETED");
    }
    if (!body.occurredAt) throw new DomainError("上报必须包含 occurredAt（事实发生时刻）");
    const event = {
      eventId: body.eventId ?? `evt-${randomUUID()}`,
      kind,
      legId: req.params.legId,
      taskCode: req.params.taskCode,
      occurredAt: body.occurredAt,
      receivedAt: body.receivedAt ?? now(),
      responsibleUnit: body.responsibleUnit ?? body.unit ?? null,
      note: body.note ?? null,
    };
    await store.append(event);
    return summarize(req.params.legId, event.eventId);
  });

  // 撤销一条错误上报（例如同一工作被报成多个完成时间）。
  route("POST", "/legs/(?<legId>[^/]+)/revocations", async (req, body, now) => {
    if (!body.refEventId) throw new DomainError("必须提供 refEventId");
    const event = {
      eventId: body.eventId ?? `rev-${randomUUID()}`,
      kind: "REVOKED",
      legId: req.params.legId,
      refEventId: body.refEventId,
      occurredAt: body.occurredAt ?? now(),
      receivedAt: now(),
      reason: body.reason ?? null,
    };
    await store.append(event);
    return summarize(req.params.legId, event.eventId);
  });

  // 换机：旧机进度归档，新机从零开始，不自动继承。
  route("POST", "/legs/(?<legId>[^/]+)/aircraft-change", async (req, body, now) => {
    if (!body.newRegistration) throw new DomainError("必须提供 newRegistration");
    const event = {
      eventId: body.eventId ?? `ac-${randomUUID()}`,
      kind: "AIRCRAFT_CHANGED",
      legId: req.params.legId,
      newRegistration: body.newRegistration,
      occurredAt: body.occurredAt ?? now(),
      receivedAt: now(),
      reason: body.reason ?? null,
    };
    await store.append(event);
    return summarize(req.params.legId, event.eventId);
  });

  // 人工修订计划：版本号由存储层在串行锁内分配，理由随事件留存。
  route("POST", "/legs/(?<legId>[^/]+)/plan-revisions", async (req, body, now) => {
    if (!body.changes || Object.keys(body.changes).length === 0) {
      throw new DomainError("必须提供至少一项 changes");
    }
    if (!body.reason) throw new DomainError("人工修订计划必须填写 reason");
    const event = {
      eventId: body.eventId ?? `plan-${randomUUID()}`,
      kind: "PLAN_REVISED",
      legId: req.params.legId,
      changes: body.changes,
      reason: body.reason,
      occurredAt: body.occurredAt ?? now(),
      receivedAt: now(),
    };
    const stored = await store.append(event);
    return summarize(req.params.legId, stored.eventId);
  });

  function summarize(legId, eventId) {
    const projection = projectTimeline(store.getLeg(legId));
    return {
      accepted: true,
      eventId,
      planVersion: projection.leg.planVersion,
      aircraftRegistration: projection.leg.aircraftRegistration,
      criticalPath: projection.criticalPath,
    };
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const query = Object.fromEntries(url.searchParams);
      const now = () => new Date().toISOString();

      const match = routes.find(
        (r) => r.method === request.method && path.match(r.pattern),
      );
      if (!match) {
        send(response, 404, { error: "not_found" });
        return;
      }
      const params = path.match(match.pattern).groups ?? {};
      const body = await readJson(request);
      const result = await match.handler({ params, query }, body, now);
      send(response, 200, result);
    } catch (error) {
      if (error instanceof DomainError) {
        send(response, error.status, { error: error.code, message: error.message });
        return;
      }
      send(response, 500, { error: "internal_error", message: error.message });
    }
  });

  return server;
}

export function buildServer(options = {}) {
  const store = options.store ?? new EventStore(options.eventLogPath ?? process.env.EVENT_LOG_PATH ?? "data/events.jsonl");
  store.load();
  return buildApp(store);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  buildServer().listen(port, "0.0.0.0");
}
