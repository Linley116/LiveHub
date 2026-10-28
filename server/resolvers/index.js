// 平台注册表 + 输入识别
import * as bilibili from './bilibili.js';
import * as huya from './huya.js';
import * as douyu from './douyu.js';
import * as douyin from './douyin.js';
import { request } from '../lib/http.js';

export const PLATFORMS = {
  bilibili: { ...bilibili.meta, resolve: bilibili.resolve },
  huya: { ...huya.meta, resolve: huya.resolve },
  douyu: { ...douyu.meta, resolve: douyu.resolve },
  douyin: { ...douyin.meta, resolve: douyin.resolve },
};

export const PLATFORM_IDS = Object.keys(PLATFORMS);

const HOST_RULES = [
  { platform: 'bilibili', test: /(^|\.)bilibili\.com$/ },
  { platform: 'bilibili', test: /(^|\.)b23\.tv$/ },
  { platform: 'huya', test: /(^|\.)huya\.com$/ },
  { platform: 'douyu', test: /(^|\.)douyu\.com$/ },
  { platform: 'douyin', test: /(^|\.)douyin\.com$/ },
  { platform: 'douyin', test: /(^|\.)iesdouyin\.com$/ },
];

const SHORT_HOSTS = new Set(['b23.tv', 'v.douyin.com', 'v.huya.com', 'm.douyin.com']);

/**
 * 把用户粘贴的任意内容识别成 { platform, roomId }。
 * 支持：完整链接、短链、`平台 房间号`、`平台:房间号`、纯数字（需配合平台参数）。
 */
export async function parseInput(input, fallbackPlatform) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('请输入直播间链接或房间号');

  // 纯数字
  if (/^\d+$/.test(raw)) {
    if (!fallbackPlatform) throw new Error('纯房间号需要指定平台，例如 `bilibili 6` 或直接粘贴直播间链接');
    return { platform: fallbackPlatform, roomId: raw };
  }

  // 平台前缀：`bilibili 6` / `虎牙:660000` / `douyu/9999`
  const prefix = raw.match(/^([a-zA-Z\u4e00-\u9fa5]+)\s*[:\s/]\s*(\d+)$/);
  if (prefix) {
    const platform = normalizePlatform(prefix[1]);
    if (platform) return { platform, roomId: prefix[2] };
  }

  // URL
  let url;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    throw new Error('无法识别的输入，请粘贴直播间链接或 `平台 房间号`');
  }

  const host = url.hostname.replace(/^www\./, '');
  const rule = HOST_RULES.find((r) => r.test.test(host));
  if (!rule) throw new Error(`暂不支持的站点：${host}`);

  if (SHORT_HOSTS.has(host)) {
    const real = await followShortLink(url.href);
    if (real) return parseInput(real, rule.platform);
  }

  const roomId = extractRoomId(rule.platform, url);
  if (!roomId) throw new Error('链接里没有解析到房间号');
  return { platform: rule.platform, roomId };
}

function normalizePlatform(word) {
  const w = word.toLowerCase();
  if (['bilibili', 'b站', 'bili', '哔哩哔哩', '哔哩'].includes(w)) return 'bilibili';
  if (['huya', '虎牙'].includes(w)) return 'huya';
  if (['douyu', '斗鱼'].includes(w)) return 'douyu';
  if (['douyin', '抖音', 'dy'].includes(w)) return 'douyin';
  return null;
}

function extractRoomId(platform, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (platform === 'douyin') {
    // live.douyin.com/<web_rid>
    const m = url.pathname.match(/\/(\d{4,})/);
    return m ? m[1] : null;
  }
  if (platform === 'bilibili') {
    if (parts[0] === 'blanc' || parts[0] === 'blackboard') return parts[1] || null;
    return /^\d+$/.test(parts[0] || '') ? parts[0] : null;
  }
  // huya / douyu：/<roomid>
  const m = url.pathname.match(/(\d{2,})/);
  return m ? m[1] : null;
}

async function followShortLink(href) {
  try {
    const res = await request(href, { redirect: 'manual', headers: { Referer: 'https://live.douyin.com/' } });
    return res.headers.get('location') || null;
  } catch {
    return null;
  }
}

export async function resolveRoom(platform, roomId, opts = {}) {
  const p = PLATFORMS[platform];
  if (!p) throw new Error(`未知平台：${platform}`);
  return p.resolve(roomId, opts);
}
