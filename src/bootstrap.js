/**
 * 把 fixtures/context.json 风格的混合记录按文件顺序导入空库。
 * 记录类型：leg（航段）/ task（保障任务）/ event（乱序上报）。
 */
export async function importFixture(service, fixture) {
  const results = [];
  let legId = null;

  for (const record of fixture.records ?? []) {
    const type =
      record.type ?? (record.eventId ? "event" : record.taskCode ? "task" : "leg");

    if (type === "leg") {
      legId = record.flightLegId;
      results.push(await service.scheduleLeg(record));
    } else if (type === "task") {
      const targetLeg = record.flightLegId ?? legId;
      if (!targetLeg) throw new Error("任务记录缺少所属航班航段");
      results.push(await service.scheduleTask(targetLeg, record));
    } else if (type === "event") {
      if (!legId) throw new Error("上报记录缺少所属航班航段");
      results.push(await service.report(legId, record));
    }
  }

  return results;
}
