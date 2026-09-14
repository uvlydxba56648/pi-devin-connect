import { appendFileSync, mkdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

/**
 * Debug log for the devin-connect extension.
 *
 * On by default: ~/.pi/agent/logs/devin-connect.log
 *   DEVIN_CONNECT_LOG=/path/to/file.log   — custom path; "off" disables
 *   DEVIN_CONNECT_DEBUG=0|false|off       — disable
 *
 * Format: JSON lines, one event per line: {t, ms, tag, msg, ...data}
 * Rotates when the file exceeds ~2 MB (keeps the last ~1 MB).
 */

const explicit = process.env.DEVIN_CONNECT_LOG;
const disabled =
  explicit === "off" ||
  /^(0|false|off|no)$/i.test(process.env.DEVIN_CONNECT_DEBUG ?? "");
const enabled = !disabled;
const path = explicit && explicit !== "off" ? explicit : join(os.homedir(), ".pi/agent/logs/devin-connect.log");
const t0 = Date.now();

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_BYTES = 1024 * 1024;

let dirReady = false;
let sizeChecked = false;

export function log(tag: string, msg: string, data?: Record<string, unknown>): void {
  if (!enabled) return;
  try {
    if (!dirReady) {
      mkdirSync(dirname(path), { recursive: true });
      dirReady = true;
    }
    if (!sizeChecked) {
      sizeChecked = true;
      try {
        const st = statSync(path);
        if (st.size > MAX_BYTES) {
          const buf = readFileSync(path);
          writeFileSync(path, buf.subarray(buf.length - KEEP_BYTES));
        }
      } catch {
        // file doesn't exist yet — fine
      }
    }
    const line = JSON.stringify({ t: new Date().toISOString(), ms: Date.now() - t0, tag, msg, ...data });
    appendFileSync(path, line + "\n");
  } catch {
    // never let logging break the stream
  }
}

export function logPath(): string | null {
  return enabled ? path : null;
}
