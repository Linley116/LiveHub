// 服务端排障日志：打包后的 app 里 stdout 看不到，代理的换线/断流/空档事件必须落盘，
// 否则用户说「又卡了一下」时无从下手。写在 data 目录，和 rooms.json 放一起。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.LIVEHUB_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'proxy.jsonl');
const MAX_BYTES = 1.5 * 1024 * 1024;

let ready = false;
let bytes = 0;

function ensure() {
  if (ready) return;
  ready = true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    bytes = fs.statSync(FILE).size;
  } catch {
    bytes = 0;
  }
  if (bytes > MAX_BYTES) {
    try { fs.truncateSync(FILE, 0); bytes = 0; } catch {}
  }
}

/** 记一条代理事件（JSONL）。events 量很小，同步写不会影响拉流。 */
export function trace(event, data = {}) {
  ensure();
  const now = new Date();
  const localAt = now.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
  const line = `${JSON.stringify({ at: now.toISOString(), localAt, event, ...data })}\n`;
  bytes += line.length;
  try {
    fs.appendFileSync(FILE, line);
  } catch {
    return;
  }
  if (bytes > MAX_BYTES) {
    try { fs.truncateSync(FILE, 0); bytes = 0; } catch {}
  }
}

export const traceFile = FILE;
