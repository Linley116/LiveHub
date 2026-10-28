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
  try {
    const text = await fs.readFile(FILE, 'utf8');
    const data = JSON.parse(text);
    cache = Array.isArray(data.rooms) ? data.rooms : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function write(rooms) {
  cache = rooms;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify({ rooms }, null, 2), 'utf8');
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
