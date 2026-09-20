/**
 * 业务时刻统一以毫秒时间戳在内部流转；对外只接受/输出带偏移量的 ISO 8601 字符串。
 */

const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseInstant(value, field = "时间") {
  if (typeof value !== "string" || !ISO_RE.test(value)) {
    throw Object.assign(new Error(`${field}必须是带时区偏移量的 ISO 8601 字符串`), {
      code: "INVALID_TIME",
      status: 400,
    });
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw Object.assign(new Error(`${field}无法解析`), { code: "INVALID_TIME", status: 400 });
  }
  return ms;
}

export function toIso(ms) {
  return new Date(ms).toISOString();
}

const clockFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
});

/** 把时刻格式化为运行场景所在时区（Asia/Shanghai）的 HH:mm，用于中文说明。 */
export function formatClock(ms) {
  return clockFormatter.format(new Date(ms));
}
