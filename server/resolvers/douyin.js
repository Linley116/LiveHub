// 抖音直播解析：web/enter 接口，靠 ttwid 设备指纹即可访问，流地址在 stream_url 里。
import { CookieJar, getJSON, request } from '../lib/http.js';
import { applyAccount } from '../accounts.js';

const jar = new CookieJar();
let sessionReady = null;
let sessionAt = 0;
// ttwid 会过期，而且首次拿不到页面时不能把失败结果一直缓存着——
// 否则一次网络抖动会让之后所有解析都走空会话，表现就是「抖音时好时坏」。
const SESSION_TTL = 30 * 60 * 1000;

export const meta = { id: 'douyin', name: '抖音', color: '#00f2ea' };

const ENTER_PARAMS = {
  aid: '6383',
  app_name: 'douyin_web',
  live_id: '1',
  device_platform: 'web',
  language: 'zh-CN',
  enter_from: 'web_live',
  cookie_enabled: 'true',
  screen_width: '1920',
  screen_height: '1080',
  browser_language: 'zh-CN',
  browser_platform: 'MacIntel',
  browser_name: 'Chrome',
  browser_version: '131.0.0.0',
};

const QUALITY_LABEL = {
  FULL_HD1: '原画',
  HD1: '高清',
  SD1: '标清',
  SD2: '标清 2',
  LD1: '流畅',
  LD2: '流畅 2',
  ORIGION: '原画',
};

async function ensureSession(roomId, { force = false } = {}) {
  const fresh = sessionReady && Date.now() - sessionAt < SESSION_TTL;
  if (fresh && !force) return sessionReady;

  sessionAt = Date.now();
  sessionReady = request(`https://live.douyin.com/${roomId || ''}`, {
    jar,
    headers: { Referer: 'https://live.douyin.com/' },
  })
    .catch(() => null)
    .then((res) => {
      if (!res) {
        // 拿不到页面就把缓存作废，下次进来重新握手，而不是一直用坏会话
        sessionReady = null;
        sessionAt = 0;
      }
      return res;
    });
  return sessionReady;
}

/** 请求 enter 接口；返回 null 表示没拿到房间数据（风控/会话失效都长这样） */
async function fetchEnter(rid) {
  const qs = new URLSearchParams({ ...ENTER_PARAMS, web_rid: rid });
  const res = await getJSON(`https://live.douyin.com/webcast/room/web/enter/?${qs}`, {
    jar,
    headers: {
      Referer: `https://live.douyin.com/${rid}`,
      Accept: 'application/json, text/plain, */*',
    },
  });
  return res?.data?.data?.[0] ? res : null;
}

export async function resolve(roomId, opts = {}) {
  const rid = String(roomId).trim();
  await ensureSession(rid);
  applyAccount('douyin', jar);

  let res = await fetchEnter(rid);
  if (!res) {
    // 十有八九是 ttwid 过期或被风控拦了一次：重握手再试一遍，能自愈绝大多数偶发失败
    await ensureSession(rid, { force: true });
    applyAccount('douyin', jar);
    res = await fetchEnter(rid);
  }
  if (!res) throw new Error('房间不存在，或抖音触发了风控验证');

  const room = res.data.data[0];
  const user = res?.data?.user || {};
  const live = Number(room.status) === 2;

  const result = {
    platform: 'douyin',
    roomId: String(room.web_rid || rid),
    title: room.title || '',
    anchor: user.nickname || '',
    avatar: pickURL(user.avatar_thumb) || '',
    cover: pickURL(room.cover) || '',
    online: Number(room.stats?.total_user || room.user_count_str || 0),
    live,
    area: room.room_tag?.[0]?.tag_name || '',
    streams: [],
  };
  if (!live) return result;

  result.streams = extractStreams(room.stream_url);
  if (!result.streams.length) {
    throw new Error('抖音未返回可播放地址，可能需要先在浏览器完成一次验证');
  }

  // 抖音一次就把所有档位下发完了，前端直接本地切档，不需要重新请求
  const seenQuality = new Set();
  result.qualities = [];
  for (const stream of result.streams) {
    if (!stream.quality || seenQuality.has(stream.quality)) continue;
    seenQuality.add(stream.quality);
    result.qualities.push({
      id: stream.quality,
      name: stream.name.replace(/\s*·\s*(HLS|FLV)$/, ''),
    });
  }
  result.quality = result.qualities[0]?.id || '';
  result.qualityMode = 'local';
  return result;
}

function pickURL(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  const list = obj.url_list || obj.uri_list;
  if (Array.isArray(list) && list.length) return list[0];
  if (obj.url) return obj.url;
  return '';
}

/** 抖音流地址有两种下发格式：结构化 stream_url 和 JSON 字符串 pull_data.stream_data */
function extractStreams(streamUrl) {
  const out = [];
  if (!streamUrl) return out;

  const hls = streamUrl.hls_pull_url_map || {};
  for (const [key, url] of Object.entries(hls)) {
    if (!url) continue;
    out.push({ name: `${QUALITY_LABEL[key] || key} · HLS`, type: 'hls', url, quality: key });
  }

  const flv = streamUrl.flv_pull_url || {};
  for (const [key, url] of Object.entries(flv)) {
    if (!url) continue;
    out.push({ name: `${QUALITY_LABEL[key] || key} · FLV`, type: 'flv', url, quality: key });
  }

  if (streamUrl.hls_pull_url) {
    out.push({ name: '原画 · HLS', type: 'hls', url: streamUrl.hls_pull_url });
  }

  if (!out.length) {
    const raw =
      streamUrl.pull_data?.stream_data ||
      streamUrl.live_core_sdk_data?.pull_data?.stream_data;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        for (const item of parsed.data || []) {
          const main = item.main || {};
          if (main.hls) out.push({ name: '原画 · HLS', type: 'hls', url: main.hls });
          if (main.flv) out.push({ name: '原画 · FLV', type: 'flv', url: main.flv });
        }
      } catch {
        /* 忽略解析失败，交给上层报错 */
      }
    }
  }

  const order = { ORIGION: 0, FULL_HD1: 0, HD1: 1, SD1: 2, SD2: 3, LD1: 4, LD2: 5 };
  return out.sort(
    (a, b) =>
      (order[a.quality] ?? 9) - (order[b.quality] ?? 9) ||
      (a.type === 'hls' ? -1 : 1),
  );
}
