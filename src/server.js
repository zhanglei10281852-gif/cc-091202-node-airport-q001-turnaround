import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildServer } from "./http/router.js";
import { EventStore } from "./domain/store.js";
import { TurnaroundService } from "./domain/turnaround.js";
import { importFixture } from "./bootstrap.js";

/**
 * 进程装配：
 *   1) 打开只追加事件日志（默认 data/events.jsonl，可用 EVENT_FILE 覆盖，
 *      设为 "memory" 时不落盘，仅供测试）；
 *   2) 从日志整体重放，重启后的判断与重启前一致；
 *   3) 仅当日志为空且 SEED_FIXTURE 未关闭时，导入 fixtures/context.json
 *      作为初始场景；
 *   4) 挂上 HTTP 路由。
 */
export async function buildApp({ clock, eventFile, seed = true } = {}) {
  const filePath = eventFile ?? (process.env.EVENT_FILE || resolve("data/events.jsonl"));
  const store = new EventStore(filePath === "memory" ? null : filePath);
  const service = new TurnaroundService(store, clock);

  if (seed && store.length === 0) {
    const fixturePath = resolve(process.env.FIXTURE_PATH || "fixtures/context.json");
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    await importFixture(service, fixture);
  }

  return { service, server: buildServer(service) };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const { server } = await buildApp();
  server.listen(port, "0.0.0.0");
  // eslint-disable-next-line no-console
  console.log(`[turnaround] 过站协同服务已启动，监听 ${port}，事件日志 ${process.env.EVENT_FILE || "data/events.jsonl"}`);
}
