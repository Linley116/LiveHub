// 本地 JSON 存储：保存关注列表（不落任何账号信息）
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 打包成 App 后 .app 内部是只读的，数据目录由主进程指到 userData
const DATA_DIR = process.env.LIVEHUB_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'rooms.json');

let cache = null;

async function read() {
  if (cache) return cache;
  // 主文件解析失败时退回上一次的备份：写坏一个字符也不至于整库读不出来
  for (const file of [FILE, `${FILE}.bak`]) {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      cache = Array.isArray(data.rooms) ? data.rooms : [];
      if (file !== FILE) console.warn('[store] rooms.json 解析失败，已从 .bak 恢复');
      return cache;
    } catch {
      /* 试下一个 */
    }
  }
  cache = [];
  return cache;
}

let writeQueue = Promise.resolve();

async function write(rooms) {
  cache = rooms;
  const body = JSON.stringify({ rooms }, null, 2);
  // 排队串行 + 临时文件原子替换：
  // 原来直接 writeFile 主文件，两个进程/两次写撞在一起就会留下半截 JSON
  // （已真实发生过一次，rooms.json 末尾多一个 '}' 导致整库读不出来）。
  writeQueue = writeQueue
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.${process.pid}.tmp`;
      await fs.writeFile(tmp, body, 'utf8');
      try {
        await fs.copyFile(FILE, `${FILE}.bak`);
      } catch {
        /* 首次写入时还没有旧文件 */
      }
      await fs.rename(tmp, FILE);
    })
    .catch((error) => {
      console.warn('[store] 写入 rooms.json 失败：', error.message);
    });
  await writeQueue;
}

export const roomKey = (platform, roomId) => `${platform}:${roomId}`;

export async function listRooms() {
  return read();
}

export async function getRoom(key) {
  const rooms = await read();
  return rooms.find((r) => r.key === key) || null;
}

export async function addRoom(room) {
  const rooms = await read();
  const key = roomKey(room.platform, room.roomId);
  const exists = rooms.find((r) => r.key === key);
  if (exists) return { room: exists, added: false };
  const record = { key, order: rooms.length, addedAt: Date.now(), ...room };
  rooms.push(record);
  await write(rooms);
  return { room: record, added: true };
}

export async function updateRoom(key, patch) {
  const rooms = await read();
  const idx = rooms.findIndex((r) => r.key === key);
  if (idx === -1) return null;
  rooms[idx] = { ...rooms[idx], ...patch };
  await write(rooms);
  return rooms[idx];
}

export async function removeRoom(key) {
  const rooms = await read();
  const next = rooms.filter((r) => r.key !== key);
  if (next.length === rooms.length) return false;
  next.forEach((r, i) => (r.order = i));
  await write(next);
  return true;
}

export async function reorderRooms(keys) {
  const rooms = await read();
  const map = new Map(rooms.map((r) => [r.key, r]));
  const next = keys.map((k) => map.get(k)).filter(Boolean);
  for (const r of rooms) if (!keys.includes(r.key)) next.push(r);
  next.forEach((r, i) => (r.order = i));
  await write(next);
  return next;
}
