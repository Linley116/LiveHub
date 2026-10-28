// 斗鱼直播解析：破解其 web-encrypt 签名（getEncryption + MD5 链）后调用 getH5PlayV1。
import crypto from 'node:crypto';
import { CookieJar, getJSON, request } from '../lib/http.js';
import { applyAccount } from '../accounts.js';

const HEADERS = { Referer: 'https://www.douyu.com/' };
const DEFAULT_DID = '10000000000000000000000000001501';

const jar = new CookieJar();
let sessionReady = null;
let keyCache = null; // { data, expire }

export const meta = { id: 'douyu', name: '斗鱼', color: '#ff7900' };

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

async function ensureSession() {
  if (!sessionReady) {
    sessionReady = request('https://www.douyu.com/', { jar, headers: HEADERS }).catch(() => null);
  }
  return sessionReady;
}

/**
 * 拉取签名密钥。斗鱼把密钥放在 /wgapi/livenc/liveweb/websec/getEncryption，
 * 返回里的 key / rand_str / enc_time 参与后续哈希链。
 */
async function getKey(did) {
  if (keyCache && keyCache.expire > Date.now() + 10_000) return keyCache.data;
  const res = await getJSON(
    `https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption?did=${did}`,
    { jar, headers: HEADERS },
  );
  if (res.error !== 0 || !res.data?.key) throw new Error(`斗鱼密钥获取失败：${res.msg || res.error}`);
  keyCache = { data: res.data, expire: Number(res.data.expire_at) * 1000 };
  return keyCache.data;
}

/**
 * 复刻页面 web-encrypt 的 sign(type=stream)：
 *   u = rand_str; 循环 enc_time 次 u = md5(u + key); 最后 u = md5(u + key + rid + ts)
 */
function sign(keyData, rid, ts) {
  const { key, rand_str: rand, enc_time: rounds, is_special: special } = keyData;
  const suffix = Number(special) === 1 ? '' : `${rid}${ts}`;
  let u = rand;
  for (let i = 0; i < Number(rounds || 1); i++) u = md5(u + key);
  return md5(u + key + suffix);
}

async function getStream(rid, opts = {}) {
  await ensureSession();
  const did = jar.map.get('www.douyu.com|dy_did') || DEFAULT_DID;
  const keyData = await getKey(did);
  const ts = Math.floor(Date.now() / 1000);
  const auth = sign(keyData, rid, ts);
  const rate = Number(opts.rate ?? -1);

  const body = new URLSearchParams({
    enc_data: keyData.enc_data,
    tt: String(ts),
    did,
    auth,
    cdn: opts.cdn || '',
    ver: 'Douyu_new',
    rate: String(rate),
    hevc: '0',
    fa: '0',
    ive: '0',
  }).toString();

  const res = await getJSON(`https://www.douyu.com/lapi/live/getH5PlayV1/${rid}`, {
    jar,
    method: 'POST',
    headers: {
      ...HEADERS,
      Referer: `https://www.douyu.com/${rid}`,
      Origin: 'https://www.douyu.com',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json, text/plain, */*',
    },
    body,
  });

  if (Number(res.error) !== 0) throw new Error(`斗鱼取流失败：${res.msg}（code ${res.error}）`);
  return res.data;
}

export async function resolve(roomId, opts = {}) {
  const rid = String(roomId).replace(/\D/g, '') || String(roomId);
  await ensureSession();
  applyAccount('douyu', jar);

  const info = await getJSON(`https://www.douyu.com/betard/${rid}`, { jar, headers: HEADERS });
  const room = info?.room || {};

  const result = {
    platform: 'douyu',
    roomId: String(room.room_id || rid),
    title: room.room_name || '',
    anchor: room.nickname || '',
    avatar: room.owner_avatar || '',
    cover: room.room_pic || '',
    online: Number(room.online || 0),
    live: Number(room.show_status) === 1,
    area: room.cate_name || '',
    streams: [],
  };
  if (!room.room_id) throw new Error('房间不存在');
  if (!result.live) return result;

  let data;
  try {
    data = await getStream(result.roomId, opts);
  } catch (err) {
    // 指定档位拿不到（多半是原画要登录，或该档位已下线）时回退到自动，保证有画面
    if (opts.rate !== undefined && Number(opts.rate) >= 0) {
      data = await getStream(result.roomId, { ...opts, rate: -1 });
      result.qualityFallback = err.message;
    } else {
      throw err;
    }
  }

  // 斗鱼的 rate 数字越小越清晰：0 = 原画，4 = 蓝光；未登录只能拿到 4
  const qualities = (data.multirates || [])
    .map((r) => ({ id: String(r.rate), name: r.name, rate: Number(r.rate) }))
    .sort((a, b) => a.rate - b.rate);

  const base = `${data.rtmp_url}/${data.rtmp_live}`.replace(/^http:\/\//, 'https://');
  result.streams.push({
    name: `${data.rtmp_cdn || '默认'} · FLV`,
    type: 'flv',
    url: base,
    rate: data.rate,
  });

  // 换其他 CDN 线路，主线路异常时可切；URL 相同的线路去重
  const seen = new Set([base]);
  for (const c of (data.cdnsWithName || []).slice(1, 4)) {
    try {
      const alt = await getStream(result.roomId, { ...opts, cdn: c.cdn });
      if (!alt.rtmp_live) continue;
      const url = `${alt.rtmp_url}/${alt.rtmp_live}`.replace(/^http:\/\//, 'https://');
      if (seen.has(url)) continue;
      seen.add(url);
      result.streams.push({ name: `${c.name} · FLV`, type: 'flv', url, rate: alt.rate });
    } catch {
      /* 备用线路失败不影响主流程 */
    }
  }

  result.qualities = qualities;
  result.quality = String(data.rate);
  // 请求了更高档位（数字更小）却拿到更低档，说明该档位有账号门槛
  const requestedRate = opts.rate === undefined || opts.rate === '' ? -1 : Number(opts.rate);
  result.qualityLocked = requestedRate >= 0 && requestedRate < Number(data.rate);
  if (result.qualityLocked) {
    const want = qualities.find((q) => q.rate === requestedRate)?.name || requestedRate;
    const got = qualities.find((q) => q.rate === Number(data.rate))?.name || data.rate;
    result.qualityNote = `斗鱼只下发了「${got}」，「${want}」需要登录斗鱼账号`;
  }
  return result;
}
