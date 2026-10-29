// 哔哩哔哩直播解析：官方 Web 接口。getInfoByRoom / playurl 有 -352 风控，
// 需要先用 finger/spi 拿 buvid3 设备指纹，带 cookie 就不需要登录。
import { CookieJar, getJSON } from '../lib/http.js';
import { applyAccount } from '../accounts.js';

const QN_NAME = {
  30000: '杜比',
  20000: '4K',
  10000: '原画',
  401: '蓝光',
  400: '蓝光',
  250: '超清',
  150: '高清',
  80: '流畅',
};

const REFERER = 'https://live.bilibili.com/';
const jar = new CookieJar();
let sessionReady = null;

export const meta = { id: 'bilibili', name: '哔哩哔哩', color: '#fb7299' };

async function ensureSession() {
  if (!sessionReady) {
    sessionReady = (async () => {
      try {
        const spi = await getJSON('https://api.bilibili.com/x/frontend/finger/spi', { jar });
        if (spi?.data?.b_3) jar.set('bilibili.com', 'buvid3', spi.data.b_3);
        if (spi?.data?.b_4) jar.set('bilibili.com', 'buvid4', spi.data.b_4);
      } catch {
        /* 指纹拿不到时仍尝试直接请求 */
      }
    })();
  }
  return sessionReady;
}

export async function resolve(roomId, opts = {}) {
  await ensureSession();
  // 每次都重新灌一次：用户可能刚在桌面端登录，下一次解析就该生效
  applyAccount('bilibili', jar);
  const headers = { Referer: REFERER };

  const init = await getJSON(
    `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`,
    { jar, headers },
  );
  if (init.code !== 0) throw new Error(`房间不存在：${init.message || init.msg}`);
  const realId = init.data.room_id;

  const info = await getJSON(
    `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${realId}`,
    { jar, headers },
  );
  if (info.code !== 0) throw new Error(`房间信息获取失败：${info.message || info.code}`);
  const ri = info.data;

  let anchor = '';
  let avatar = '';
  if (ri.uid) {
    try {
      const master = await getJSON(
        `https://api.live.bilibili.com/live_user/v1/Master/info?uid=${ri.uid}`,
        { jar, headers },
      );
      anchor = master?.data?.info?.uname || '';
      avatar = master?.data?.info?.face || '';
    } catch {
      /* 主播信息非核心字段 */
    }
  }

  const result = {
    platform: 'bilibili',
    roomId: String(ri.room_id || realId),
    shortId: String(ri.short_id || ''),
    title: ri.title || '',
    anchor,
    avatar,
    cover: ri.user_cover || ri.keyframe || '',
    online: Number(ri.online || 0),
    live: ri.live_status === 1,
    area: [ri.parent_area_name, ri.area_name].filter(Boolean).join(' · '),
    intro: ri.description || '',
    streams: [],
  };
  if (!result.live) return result;

  const qn = Number(opts.qn) || 10000;
  const play = await getJSON(
    'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo' +
      `?room_id=${realId}&protocol=0,1&format=0,1,2&codec=0&qn=${qn}` +
      '&platform=web&ptype=8&dolby=5&panorama=1',
    { jar, headers },
  );

  if (play.code !== 0) throw new Error(`取流失败：${play.message || play.code}`);
  if (!play.data?.live_status) {
    result.live = false;
    return result;
  }

  const streams = [];
  for (const st of play?.data?.playurl_info?.playurl?.stream || []) {
    const isHls = st.protocol_name === 'http_hls';
    for (const fmt of st.format || []) {
      for (const codec of fmt.codec || []) {
        const node = codec.url_info?.[0];
        if (!node) continue;
        streams.push({
          name: `${QN_NAME[codec.current_qn] || codec.current_qn + 'P'} · ${isHls ? 'HLS' : 'FLV'}`,
          type: isHls ? 'hls' : 'flv',
          url: node.host + codec.base_url + (node.extra || ''),
          qn: codec.current_qn,
          codec: codec.codec_name,
          format: fmt.format_name,
        });
      }
    }
  }

  // 房间支持的清晰度来自 accept_qn，中文名来自 g_qn_desc。
  // 未登录时 B 站会把 current_qn 压到 250，accept_qn 仍然列出原画——正好用来说明「登录后可选」。
  const playurl = play.data.playurl_info?.playurl;
  const qnDesc = new Map((playurl?.g_qn_desc || []).map((q) => [Number(q.qn), q.desc]));
  const accepted = new Set();
  let currentQn = 0;
  for (const st of playurl?.stream || []) {
    for (const fmt of st.format || []) {
      for (const codec of fmt.codec || []) {
        for (const qn of codec.accept_qn || []) accepted.add(Number(qn));
        currentQn = Math.max(currentQn, Number(codec.current_qn) || 0);
      }
    }
  }

  // 没显式指定时服务端按 10000 请求，判断降级要以 10000 作基准
  const requestedQn = Number(opts.qn) || 10000;
  const qualities = [...accepted]
    .sort((a, b) => b - a)
    .map((qn) => ({ id: String(qn), name: qnDesc.get(qn) || `${qn}P`, qn }));

  result.streams = rankStreams(streams);
  result.qualities = qualities;
  result.quality = String(currentQn);
  // 请求了更高的档位却被降级，说明该档位需要登录（B 站直播原画/蓝光账号门槛）
  result.qualityLocked = requestedQn > 0 && requestedQn > currentQn;
  if (result.qualityLocked) {
    result.qualityNote = `B 站只下发了「${qnDesc.get(currentQn) || currentQn}」，登录后可解锁更高清晰度`;
  }
  return result;
}

/**
 * 优先 AVC+FLV，其次 AVC+HLS；码率从高到低，同组合去重。
 * 用 FLV 而不是 HLS：B 站直播的 HLS 分片很短，hls.js 得不停拉清单+分片，
 * 实测 60 秒内停顿 10 次（缓冲甚至出现负值）；同房间换 FLV 后只有 1 次、
 * 缓冲能长到几十秒。直播场景下长连接的 FLV 明显更稳。
 */
function rankStreams(list) {  const score = (s) => (s.codec === 'avc' ? 100 : 0) + (s.type === 'flv' ? 30 : 0) + (s.format === 'fmp4' ? 5 : 0);
  const sorted = [...list].sort((a, b) => b.qn - a.qn || score(b) - score(a));
  const seen = new Set();
  const out = [];
  for (const s of sorted) {
    const key = `${s.qn}|${s.type}|${s.codec}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.slice(0, 8);
}
