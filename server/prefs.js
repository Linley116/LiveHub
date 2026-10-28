// 观看偏好存储：每个直播间记住自己的音量、清晰度、线路、悬浮弹幕和弹幕样式。
//
// 为什么不用 localStorage：桌面端每次启动会用随机端口加载页面，
// 而 localStorage 是按 origin（含端口）隔离的，端口一变就等于换了个站点，
// 偏好会全部丢失。存到数据目录里才跟端口、Electron 的用户数据位置都无关。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.LIVEHUB_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'prefs.json');

const LIMIT = 300; // 只留最近进过的房间，关注再多也不会无限膨胀

let cache = null;

async function read() {
  if (cache) return cache;
  try {
    const data = JSON.parse(await fs.readFile(FILE, 'utf8'));
    cache = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function write(all) {
  cache = all;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(all, null, 2), 'utf8');
}

export async function listPrefs() {
  return read();
}

export async function getPrefs(key) {
  const all = await read();
  return all[key] || null;
}

/** 只清洗已知的键，别把乱七八糟的东西写进文件 */
function sanitize(patch) {
  const next = {};
  if (typeof patch.volume === 'number' && Number.isFinite(patch.volume)) {
    next.volume = Math.min(1, Math.max(0, patch.volume));
  }
  if (typeof patch.muted === 'boolean') next.muted = patch.muted;
  if (typeof patch.soundUserSet === 'boolean') next.soundUserSet = patch.soundUserSet;
  if (patch.quality !== undefined) next.quality = String(patch.quality).slice(0, 40);
  if (Number.isFinite(Number(patch.line))) next.line = Math.min(20, Math.max(0, Number(patch.line)));
  if (typeof patch.overlay === 'boolean') next.overlay = patch.overlay;
  if (patch.danmaku && typeof patch.danmaku === 'object') {
    const danmaku = {};
    const clamp = (value, min, max, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    if (patch.danmaku.opacity !== undefined) danmaku.opacity = clamp(patch.danmaku.opacity, 25, 100, 100);
    if (patch.danmaku.fontSize !== undefined) danmaku.fontSize = clamp(patch.danmaku.fontSize, 11, 26, 14);
    if (patch.danmaku.speed !== undefined) danmaku.speed = clamp(patch.danmaku.speed, 5, 20, 10);
    if (['top', 'half', 'full'].includes(patch.danmaku.area)) danmaku.area = patch.danmaku.area;
    if (Object.keys(danmaku).length) next.danmaku = danmaku;
  }
  return next;
}

export async function patchPrefs(key, patch) {
  if (!key || typeof key !== 'string') return null;
  const all = await read();
  const clean = sanitize(patch);
  const prev = all[key] || {};
  const merged = { ...prev, ...clean };
  // 弹幕四项是一次调一项的，要合并而不是整块替换
  if (clean.danmaku) merged.danmaku = { ...(prev.danmaku || {}), ...clean.danmaku };
  merged.updatedAt = Date.now();
  all[key] = merged;

  const keys = Object.keys(all);
  if (keys.length > LIMIT) {
    const stale = keys
      .sort((a, b) => (all[a].updatedAt || 0) - (all[b].updatedAt || 0))
      .slice(0, keys.length - LIMIT);
    for (const old of stale) delete all[old];
  }
  await write(all);
  return merged;
}
