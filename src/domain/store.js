import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 只追加（append-only）的耐久事件日志。
 *
 * 每行一条 JSON（JSONL）。文件只在进程启动时整体重放、之后顺序追加，
 * 因此同一时刻只有一个文件句柄在写，配合进程内串行化即可保证崩溃前
 * fsync 落盘的事件在重启后被完整恢复（判断与重启前一致）。
 */
export class EventStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = [];
    if (filePath && existsSync(filePath)) {
      const text = readFileSync(filePath, "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) this.entries.push(JSON.parse(trimmed));
      }
    }
  }

  get length() {
    return this.entries.length;
  }

  /** 以插入顺序返回全部已持久化事件。 */
  replay() {
    return this.entries.slice();
  }

  /**
   * 持久化一批事件：整批写入一个调用，要么全部落盘要么本批全部不可见。
   * 写成功后事件才进入内存，保证内存状态永远是落盘状态的前缀。
   */
  appendBatch(events) {
    if (events.length === 0) return;
    if (this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const payload = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
      appendFileSync(this.filePath, payload, { encoding: "utf8" });
    }
    this.entries.push(...events);
  }
}
