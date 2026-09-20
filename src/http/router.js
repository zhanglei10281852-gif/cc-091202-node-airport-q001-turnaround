import { createServer } from "node:http";
import { ApiError } from "../domain/errors.js";
import { projectLeg } from "../domain/projection.js";

/**
 * HTTP 适配层：只做路由、JSON 编解码与错误映射，业务判断全部来自领域服务。
 * 读接口直接对事件折叠出的当前状态做投影——读模型不落库，因此永远与事件一致。
 */
export function buildServer(service, { onRequest } = {}) {
  const server = createServer(async (request, response) => {
    try {
      await route(service, request, response);
    } catch (error) {
      sendError(response, error);
    } finally {
      onRequest?.(request, response);
    }
  });
  return server;
}

async function route(service, request, response) {
  const url = new URL(request.url ?? "/", "http://turnaround.local");
  const segments = url.pathname.split("/").filter(Boolean); // /api/legs/:id/...

  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, { status: "ok" });
  }

  if (segments[0] !== "api") throw new ApiError(404, "not_found", "接口不存在");

  // POST /api/legs
  if (request.method === "POST" && segments[1] === "legs" && segments.length === 2) {
    const body = await readJson(request);
    const event = await service.scheduleLeg(body);
    return sendJson(response, 201, { ok: true, event: presentEvent(event) });
  }

  // GET /api/legs
  if (request.method === "GET" && segments[1] === "legs" && segments.length === 2) {
    const legs = [...service.state.legs.keys()].map((id) => {
      const leg = service.state.legs.get(id);
      return {
        flightLegId: leg.flightLegId,
        aircraftRegistration: leg.aircraftRegistration,
        planVersion: leg.planVersion,
        scheduledDoorClose: new Date(leg.scheduledDoorClose).toISOString(),
      };
    });
    return sendJson(response, 200, { legs });
  }

  if (segments[1] === "legs" && segments.length >= 3) {
    const legId = decodeURIComponent(segments[2]);

    // POST /api/legs/:id/tasks
    if (request.method === "POST" && segments[3] === "tasks" && segments.length === 4) {
      const body = await readJson(request);
      const event = await service.scheduleTask(legId, body);
      return sendJson(response, 201, { ok: true, event: presentEvent(event) });
    }

    // POST /api/legs/:id/reports
    if (request.method === "POST" && segments[3] === "reports" && segments.length === 4) {
      const body = await readJson(request);
      const result = await service.report(legId, body);
      if (result.duplicated) {
        return sendJson(response, 200, {
          ok: true,
          duplicated: true,
          message: "事件编号已存在，按幂等处理，当前状态未发生改变",
        });
      }
      return sendJson(response, 201, { ok: true, duplicated: false, event: presentEvent(result.event) });
    }

    // POST /api/legs/:id/aircraft
    if (request.method === "POST" && segments[3] === "aircraft" && segments.length === 4) {
      const body = await readJson(request);
      const event = await service.reassign(legId, body);
      return sendJson(response, 201, { ok: true, event: presentEvent(event) });
    }

    // POST /api/legs/:id/plan-revisions
    if (request.method === "POST" && segments[3] === "plan-revisions" && segments.length === 4) {
      const body = await readJson(request);
      const event = await service.adjustPlan(legId, body);
      return sendJson(response, 201, { ok: true, event: presentEvent(event) });
    }

    // GET /api/legs/:id/timeline
    if (request.method === "GET" && segments[3] === "timeline" && segments.length === 4) {
      const leg = legOr404(service, legId);
      return sendJson(response, 200, projectLeg(leg, service.now()));
    }

    // GET /api/legs/:id/delay
    if (request.method === "GET" && segments[3] === "delay" && segments.length === 4) {
      const leg = legOr404(service, legId);
      const view = projectLeg(leg, service.now());
      return sendJson(response, 200, {
        flightLegId: view.flightLegId,
        delayed: view.delayed,
        delayMinutes: view.delayMinutes,
        scheduledDoorClose: view.scheduledDoorClose,
        forecastEarliestDoorClose: view.forecastEarliestDoorClose,
        criticalPath: view.criticalPath,
        delayReason: view.delayReason,
      });
    }

    // GET /api/legs/:id/blockers
    if (request.method === "GET" && segments[3] === "blockers" && segments.length === 4) {
      const leg = legOr404(service, legId);
      const view = projectLeg(leg, service.now());
      return sendJson(response, 200, {
        flightLegId: view.flightLegId,
        blockingTasks: view.blockingTasks,
      });
    }

    // GET /api/legs/:id
    if (request.method === "GET" && segments.length === 3) {
      const leg = legOr404(service, legId);
      return sendJson(response, 200, projectLeg(leg, service.now()));
    }
  }

  throw new ApiError(404, "not_found", "接口不存在");
}

function legOr404(service, legId) {
  const leg = service.state.legs.get(legId);
  if (!leg) throw new ApiError(404, "LEG_NOT_FOUND", `航班航段 ${legId} 不存在`);
  return leg;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "VALIDATION_FAILED", "请求体必须是 JSON 对象");
    }
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_JSON", "请求体不是合法 JSON");
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function sendError(response, error) {
  if (error instanceof ApiError) {
    return sendJson(response, error.status, { error: error.code, message: error.message });
  }
  // 其余错误统一收敛为 500，避免把内部堆栈泄露给运行终端。
  // eslint-disable-next-line no-console
  console.error("[turnaround] 未预期错误:", error);
  sendJson(response, 500, { error: "INTERNAL", message: "服务内部错误" });
}

/** 对外事件不回暴露内部毫秒字段，统一转为 ISO 8601。 */
export function presentEvent(event) {
  if (!event) return event;
  const clone = { ...event };
  for (const key of ["at", "occurredAt", "receivedAt", "plannedStart", "plannedEnd", "turnaroundStart", "scheduledDoorClose"]) {
    if (typeof clone[key] === "number") clone[key] = new Date(clone[key]).toISOString();
  }
  if (Array.isArray(clone.changes)) {
    clone.changes = clone.changes.map((change) => ({
      ...change,
      plannedStart: new Date(change.plannedStart).toISOString(),
      plannedEnd: new Date(change.plannedEnd).toISOString(),
    }));
  }
  return clone;
}
