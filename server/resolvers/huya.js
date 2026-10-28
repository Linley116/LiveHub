// 虎牙直播解析：mp 接口拿房间信息 + 本地重算 anticode 得到长连接 FLV。
//
// 关键点（2026-10 实测）：mp 接口下发的 sFlvAntiCode 里 **没有 seqid**，
// CDN 只按 wsTime 给一个 1~7 秒的窗口就 close，重复请求还是同一段缓存。
// 解决办法不是换 token，而是拿 ANTICODE 里的 fm/ctype/t + 主播 uid 自己重算：
//   seqid    = presenterUid + Date.now()
//   secret   = md5(`${seqid}|${ctype}|${t}`)
//   calcUid  = rotl32(low32(presenterUid), 8)
//   wsSecret = md5(`${fmPrefix}_${calcUid}_${streamName}_${secret}_${wsTime}`)
//   fmPrefix = base64decode(fm).split('_')[0]
// 算法与 biliup / yt-dlp 的实现一致，实测可稳定拉流（12 秒 3.4MB 持续推流）。
import crypto from 'node:crypto';
import { CookieJar, getJSON, request } from '../lib/http.js';
import { applyAccount } from '../accounts.js';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  Referer: 'https://www.huya.com/',
  Origin: 'https://www.huya.com',
  Accept: '*/*',
  'User-Agent': DESKTOP_UA,
};

const jar = new CookieJar();
let sessionReady = null;

async function ensureSession() {
  if (!sessionReady) {
    sessionReady = request('https://www.huya.com/', { jar, headers: HEADERS }).catch(() => null);
  }
  return sessionReady;
}

const CDN_LABEL = {
  AL: '阿里云',
  TX: '腾讯云',
  HW: '华为云',
  WS: '网宿',
  AL13: '阿里云 13',
  HUYA: '虎牙',
  HS: '金山云',
  TX15: '腾讯云 15',
  HS24: '金山云 24',
};

const CDN_PRIORITY = { tx: 0, al: 1, hs: 2 };

export const meta = { id: 'huya', name: '虎牙', color: '#ff9600' };

const md5 = (text) => crypto.createHash('md5').update(text).digest('hex');

/** 低 32 位循环左移 8 位，高位原样保留（对应虎牙的 convert_uid） */
function rotateUid(uid) {
  const value = BigInt(uid || 0);
  const low = value & 0xffffffffn;
  const rotated = ((low << 8n) | (low >> 24n)) & 0xffffffffn;
  return ((value & ~0xffffffffn) | rotated).toString();
}

/**
 * 用页面的 anticode 参数重算一份带 seqid 的签名。
 * 拿不到 fm 时原样返回，让 CDN 决定行为（至少还能出画面）。
 */
function buildAntiCode(streamName, antiCode, presenterUid) {
  const query = new URLSearchParams(antiCode || '');
  const fmRaw = query.get('fm');
  if (!fmRaw) return antiCode || '';

  const ctype = query.get('ctype') || 'huya_live';
  const platformId = query.get('t') || '100';
  const isWap = platformId === '103';

  const uid = BigInt(presenterUid || 0);
  const now = Date.now();
  const seqId = (uid + BigInt(now)).toString();
  const secret = md5(`${seqId}|${ctype}|${platformId}`);
  const calcUid = rotateUid(uid);

  let fmPrefix;
  try {
    fmPrefix = Buffer.from(decodeURIComponent(fmRaw), 'base64').toString('utf8').split('_')[0];
  } catch {
    return antiCode || '';
  }

  // wsTime 是十六进制秒；剩余有效期不足 20 分钟就换成 24 小时后
  const nowSec = Math.floor(now / 1000);
  let wsTime = query.get('wsTime') || '';
  if ((parseInt(wsTime, 16) || 0) < nowSec + 20 * 60) {
    wsTime = (nowSec + 24 * 3600).toString(16);
  }

  const signUid = isWap ? uid.toString() : calcUid;
  const wsSecret = md5(`${fmPrefix}_${signUid}_${streamName}_${secret}_${wsTime}`);
  const fs = query.get('fs') || 'bgct';

  const parts = [
    `wsSecret=${wsSecret}`,
    `wsTime=${wsTime}`,
    `seqid=${seqId}`,
    `ctype=${ctype}`,
    'ver=1',
    `fs=${fs}`,
    `fm=${encodeURIComponent(fmRaw)}`,
    `t=${platformId}`,
  ];
  if (isWap) {
    parts.push(`uid=${uid.toString()}`, `uuid=${Math.floor(Math.random() * 0xffffffff)}`);
  } else {
    parts.push(`u=${calcUid}`);
  }
  return parts.join('&');
}

/** 从 baseSteamInfoList 提取可用的 CDN 线路 */
function extractCandidates(data) {
  const list = data.stream?.baseSteamInfoList || [];
  const fallbackUid = Number(list[0]?.lPresenterUid) || Number(list[0]?.lChannelId) || 0;
  const out = [];
  for (const item of list) {
    if (!item.sFlvUrl || !item.sStreamName || !item.sFlvAntiCode) continue;
    if (Number(item.iWebPriorityRate) < 0) continue;
    out.push({
      cdn: String(item.sCdnType || ''),
      flvUrl: String(item.sFlvUrl).replace(/\/$/, ''),
      suffix: String(item.sFlvUrlSuffix || 'flv'),
      streamName: String(item.sStreamName),
      antiCode: String(item.sFlvAntiCode),
      presenterUid: Number(item.lPresenterUid) || fallbackUid,
    });
  }
  // 腾讯 > 阿里 > 金山，稳定性和起播速度综合排序
  out.sort(
    (a, b) =>
      (CDN_PRIORITY[a.cdn.toLowerCase()] ?? 3) - (CDN_PRIORITY[b.cdn.toLowerCase()] ?? 3),
  );
  return out;
}

/**
 * 清晰度档位：优先 liveData.bitRateInfo（含「蓝光10M」这种 iBitRate=0 的原画档），
 * 缺失时退回 stream.flv.rateArray。iBitRate=0 表示原画，取流时不带 ratio。
 */
function extractQualities(data) {
  const tiers = [];
  const push = (id, name) => {
    if (!name) return;
    if (tiers.some((tier) => tier.id === id)) return;
    tiers.push({ id, name, bitRate: Number(id) || 0 });
  };

  let info = [];
  try {
    info = JSON.parse(data.liveData?.bitRateInfo || '[]');
  } catch {
    info = [];
  }
  for (const item of info) push(String(Number(item.iBitRate) || 0), item.sDisplayName);

  for (const item of data.stream?.flv?.rateArray || []) {
    push(String(Number(item.iBitRate) || 0), item.sDisplayName);
  }

  if (!tiers.length) tiers.push({ id: '0', name: '原画', bitRate: 0 });
  // iBitRate=0 是原画（最高），排序时按最高码率处理
  const weight = (bitRate) => (bitRate > 0 ? bitRate : Number.POSITIVE_INFINITY);
  return tiers.sort((a, b) => weight(b.bitRate) - weight(a.bitRate));
}

/** 拼流地址：ratio=0（原画）时不带 ratio 参数，交给 CDN 给最高码率 */
function buildStreamUrl(candidate, antiCode, ratio) {
  const base = `${candidate.flvUrl}/${candidate.streamName}.${candidate.suffix}`;
  let url = `${base}?${antiCode}&codec=264`;
  if (ratio > 0) url += `&ratio=${ratio}`;
  return url.replace(/^http:\/\//, 'https://');
}

export async function resolve(roomId, opts = {}) {
  await ensureSession();
  applyAccount('huya', jar);

  const raw = await getJSON(
    `https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=${encodeURIComponent(roomId)}&showSecret=1`,
    { jar, headers: HEADERS },
  );
  if (raw.status !== 200 || !raw.data) {
    throw new Error(`房间不存在或接口异常（${raw.message || raw.status}）`);
  }

  const data = raw.data;
  const ld = data.liveData || {};
  const pi = data.profileInfo || {};
  const live = data.liveStatus === 'ON' || data.realLiveStatus === 'ON';

  const result = {
    platform: 'huya',
    roomId: String(ld.profileRoom || roomId),
    // 虎牙页面上的「直播间标题」位是 roomName，主播没设标题时它会是空串，
    // 此时页面改显示 introduction（主播公告，如「感谢 xx 的至尊守护」）。照这个顺序补，别退回占位符。
    title: ld.roomName || ld.introduction || pi.sRoomName || '',
    anchor: ld.nick || pi.sNick || '',
    avatar: ld.avatar180 || pi.sAvatar180 || '',
    cover: ld.screenshot || '',
    online: Number(ld.userCount || 0),
    live,
    area: ld.gameFullName || '',
    intro: ld.introduction || '',
    qualities: [],
    quality: '',
    qualityMode: 'remote',
    streams: [],
  };
  if (!live || !data.stream) return result;

  result.qualities = extractQualities(data);
  const requested = Number(opts.ratio || 0);
  const ratio = Number.isFinite(requested) && requested > 0 ? requested : 0;

  const candidates = extractCandidates(data);
  if (!candidates.length) throw new Error('虎牙未下发可用的 CDN 线路');

  // 同房间所有 CDN 的 streamName 相同，签名只算一次
  const antiCode = buildAntiCode(candidates[0].streamName, candidates[0].antiCode, candidates[0].presenterUid);

  for (const candidate of candidates.slice(0, 4)) {
    result.streams.push({
      name: `${CDN_LABEL[candidate.cdn] || candidate.cdn} · FLV`,
      type: 'flv',
      url: buildStreamUrl(candidate, antiCode, ratio),
      bitRate: ratio,
      cdn: candidate.cdn,
    });
  }

  result.quality = String(ratio);
  return result;
}
