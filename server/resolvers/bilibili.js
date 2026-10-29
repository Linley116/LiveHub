// 哔哩哔哩直播解析：官方 Web 接口。getInfoByRoom / playurl 有 -352 风控，
// 需要先用 finger/spi 拿 buvid3 设备指纹，带 cookie 就不需要登录。
import { CookieJar, getJSON, UAS } from '../lib/http.js';
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
        // B 站每个档位会给多个 CDN 节点（url_info）。以前只用第 0 个，
        // 碰上那个节点不好就无解。这里把前 3 个都下发，作为用户**手动**可选线路
        // （不做自动切换：实测卡顿多是用户侧链路整体降速，换节点救不了）。
        const nodes = (codec.url_info || []).slice(0, 3);
        nodes.forEach((node, hostIndex) => {
          if (!node) return;
          const baseName = `${QN_NAME[codec.current_qn] || codec.current_qn + 'P'} · ${isHls ? 'HLS' : 'FLV'}`;
          streams.push({
            name: hostIndex ? `${baseName} · 线路${hostIndex + 1}` : baseName,
            type: isHls ? 'hls' : 'flv',
            url: node.host + codec.base_url + (node.extra || ''),
            qn: codec.current_qn,
            codec: codec.codec_name,
            format: fmt.format_name,
            hostIndex,
          });
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

  result.streams = await verifyNodes(rankStreams(streams));
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
    const key = `${s.qn}|${s.type}|${s.codec}|${s.hostIndex || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.slice(0, 12);
}

/**
 * 节点探测（借鉴 DTV 的「先验证再交付」）：B 站的 CDN 节点时不时有死的/半死的，
 * 用户手动换线点进去就是黑屏。这里对排在前面的 FLV 节点并行发一次探测——
 * 建连 + 读到第一块字节就算活，2.5s 超时。探测失败的挪到队尾（不删，
 * 手动选择的自由保留），探测请求头和代理转发用的完全一致，避免误判。
 */
async function verifyNodes(streams) {
  const flvList = streams.filter((s) => s.type === 'flv').slice(0, 6);
  if (flvList.length < 2) return streams;   // 就一条没得挑，别多此一举
  const results = await Promise.all(
    flvList.map(async (s) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 2500);
      try {
        const res = await fetch(s.url, {
          headers: {
            'User-Agent': UAS.web,
            Referer: 'https://live.bilibili.com/',
            Origin: 'https://live.bilibili.com',
            Accept: '*/*',
          },
          redirect: 'follow',
          signal: ac.signal,
        });
        if (!res.ok || !res.body) return [s, false];
        const reader = res.body.getReader();
        const first = await reader.read();
        try { await reader.cancel(); } catch {}
        return [s, !first.done && !!first.value?.length];
      } catch {
        return [s, false];
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const dead = new Set(results.filter(([, ok]) => !ok).map(([s]) => s));
  if (!dead.size) return streams;
  console.error(`[bilibili] 节点探测：${dead.size}/${flvList.length} 个 FLV 节点无响应，已挪到队尾`);
  return [...streams.filter((s) => !dead.has(s)), ...streams.filter((s) => dead.has(s))];
}
