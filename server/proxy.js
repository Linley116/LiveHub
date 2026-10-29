// 直播流代理：解决 Referer/CORS 限制，并把 m3u8 里的分片地址改写成走本代理。
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { trace } from './lib/trace.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 只代理这些平台的 CDN，避免变成开放代理。 */
const ALLOW = [
  /(^|\.)bilivideo\.com$/, /(^|\.)bilivideo\.cn$/, /(^|\.)hdslb\.com$/, /(^|\.)bilibili\.com$/,
  /(^|\.)huya\.com$/, /(^|\.)huyacdn\.com$/, /(^|\.)msstatic\.com$/, /(^|\.)huya\.cc$/,
  /(^|\.)douyucdn\.cn$/, /(^|\.)douyucdn2\.cn$/, /(^|\.)douyucdn\.com$/, /(^|\.)douyu\.com$/,
  /(^|\.)douyin\.com$/, /(^|\.)douyinvod\.com$/, /(^|\.)douyincdn\.com$/, /(^|\.)douyinpic\.com$/,
  /(^|\.)volccdn\.com$/, /(^|\.)ibytedtos\.com$/, /(^|\.)zjcdn\.com$/, /(^|\.)byteimg\.com$/,
  /(^|\.)bytecdn\.cn$/, /(^|\.)douyinstatic\.com$/, /(^|\.)amemv\.com$/, /(^|\.)bytednsdoc\.com$/,
];

const REFERER = {
  bilibili: 'https://live.bilibili.com/',
  huya: 'https://www.huya.com/',
  douyu: 'https://www.douyu.com/',
  douyin: 'https://live.douyin.com/',
};

function hostAllowed(hostname) {
  return ALLOW.some((re) => re.test(hostname));
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 私有/保留网段，禁止代理过去（防 SSRF） */
function isPrivateIPv4(host) {
  const m = IPV4.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * 抖音的 HLS 变体列表会把域名改成裸 IP（如 http://140.150.1.48/pull-hls-h1.douyincdn.com/...）。
 * 对这种情况需要额外放行，但要求路径里仍然带着已知 CDN 域名，且 IP 不属于内网段。
 */
function ipHostAllowed(url) {
  if (!IPV4.test(url.hostname) || isPrivateIPv4(url.hostname)) return false;
  const tail = url.pathname + url.search;
  return /douyincdn\.com|douyin\.com|douyinvod\.com|bilivideo\.com|hdslb\.com|douyucdn\.cn|huya\.com/.test(tail);
}

function encodeTarget(url) {
  return encodeURIComponent(url);
}

export function proxyURL(platform, url, extra) {
  let out = `/api/proxy?p=${platform}&u=${encodeTarget(url)}`;
  if (extra?.room) out += `&r=${encodeURIComponent(extra.room)}`;
  if (extra?.name) out += `&n=${encodeURIComponent(extra.name)}`;
  // 画质档位：断流重新解析时要按同一档位取，否则会悄悄换成原画/低清
  if (extra?.q !== undefined && extra?.q !== null && extra?.q !== '') out += `&b=${encodeURIComponent(extra.q)}`;
  return out;
}

/**
 * 代理入口。
 * 直播流是长连接，客户端切清晰度/关页面时上游会被中断，undici 抛 `TypeError: terminated`；
 * Express 不会自动捕获 async 异常，不兜住就会变成未捕获异常把主进程弹崩。
 */
export async function proxyHandler(req, res, opts = {}) {
  try {
    await handleProxy(req, res, opts);
  } catch (err) {
    const reason = err.cause?.message || err.message || '未知错误';
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(502).send(`proxy error: ${reason}`);
  }
}

async function handleProxy(req, res, opts = {}) {
  const platform = String(req.query.p || '');
  const target = String(req.query.u || '');
  const roomId = String(req.query.r || '');
  const streamName = String(req.query.n || '');
  const quality = req.query.b === undefined ? '' : String(req.query.b);
  if (!target) return res.status(400).send('missing u');

  let url;
  try {
    url = new URL(target);
  } catch {
    return res.status(400).send('bad u');
  }
  if (!/^https?:$/.test(url.protocol)) return res.status(400).send('bad protocol');
  if (!hostAllowed(url.hostname) && !ipHostAllowed(url)) {
    return res.status(403).send(`host not allowed: ${url.hostname}`);
  }

  const headers = {
    'User-Agent': UA,
    Referer: REFERER[platform] || 'https://live.bilibili.com/',
    Origin: (REFERER[platform] || '').replace(/\/$/, ''),
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(url.href, { headers, redirect: 'follow' });
  } catch (err) {
    const reason = err.cause?.message || err.message || '未知网络错误';
    const code = err.cause?.code ? ` (${err.cause.code})` : '';
    return res.status(502).send(`upstream error: ${reason}${code}`);
  }

  if (!upstream.ok && upstream.status !== 206) {
    console.error(
      `[proxy] ${platform} ${upstream.status} ${url.hostname}${url.pathname.slice(0, 60)}`,
      upstream.status === 403 ? '（多为签名过期，前端重连应绕过解析缓存）' : '',
    );
    res.status(upstream.status);
    res.set('Access-Control-Allow-Origin', '*');
    return res.send(`upstream ${upstream.status}`);
  }

  const ctype = upstream.headers.get('content-type') || '';
  const isPlaylist =
    /mpegurl|x-mpegURL/i.test(ctype) || url.pathname.endsWith('.m3u8') || /\.m3u8$/i.test(url.pathname + url.search);

  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store');

  if (isPlaylist) {
    let text;
    try {
      text = await upstream.text();
    } catch (err) {
      // 上游播放列表读到一半断开：客户端多半已经切走了，直接收尾
      res.destroy();
      return;
    }
    const rewritten = rewritePlaylist(text, url, platform);
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    return res.send(rewritten);
  }

  const isFlv = /x-flv|flv/i.test(ctype) || /\.flv(\?|$)/i.test(url.pathname + url.search);
  if (isFlv) {
    // 虎牙等 CDN 的地址是一次性签名，重连/换线前必须重新解析；解析逻辑在 index.js 里，注入进来避免循环依赖
    const refresh =
      roomId && typeof opts.resolveFresh === 'function'
        ? () => opts.resolveFresh(platform, roomId, streamName, quality)
        : null;
    return streamFlv({ url: url.href, platform, headers, res, upstream, refresh, room: roomId, line: streamName });
  }

  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = upstream.headers.get(h);
    if (v) res.set(h, v);
  }
  res.status(upstream.status);

  if (!upstream.body) return res.end();
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    res.destroy();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * FLV 直播流专用转发：抖动缓冲 + 多连接时间轴对齐。
 *
 * 三个问题一起解决：
 * 1. 虎牙这类 CDN 会在约 127 秒后主动掐断 FLV 连接。等它断了再去重连，中间的空档
 *    （DNS/TLS/跳转/首包，几百毫秒到几秒）会原样传导成播放器缓冲耗尽 → 卡一下。
 *    做法：连接活到一定年纪就提前把下一条建好当「备用连接」，主连接一断立刻顶上，
 *    空档为零。太早浪费带宽、太晚来不及，所以预热时机是观察出来的——第一次断流活
 *    了多少秒，下一轮就提前 FLV_WARMUP_LOOKAHEAD_MS 准备。
 * 2. 新连接和老连接的时间轴对不上（CDN 会把直播边缘往回放几百毫秒甚至几秒，重连后
 *    也可能换一条从 0 开始的时间轴）。这里按 FLV tag 解析出时间戳，把新一段整体平移
 *    到老一段之后，重叠部分按时间戳丢掉。客户端看到的始终是一条连续单调的时间轴，
 *    不会触发重缓冲。
 * 3. 抖音/CDN 的数据是爆发式下发，忽快忽慢。每块数据固定延迟 FLV_JITTER_MS 再转发，
 *    相当于在服务端放一个抖动缓冲，上游短暂停顿不会立刻传导到播放器。
 *
 * 只作用于 FLV（四个平台现在都走 FLV）；HLS 的分片是短文件，走原逻辑。
 */
const FLV_JITTER_MS = Number(process.env.LIVEHUB_FLV_JITTER_MS ?? 800);
const FLV_MAX_QUEUE = 24 * 1024 * 1024;
/** tag 通道上限，防止上游狂奔时把内存吃光 */
const FLV_CHANNEL_MAX = 4000;
/** 换线比预判的断流点提前多久 */
const FLV_ROTATE_LOOKAHEAD_MS = Number(process.env.LIVEHUB_FLV_LOOKAHEAD_MS ?? 15000);
/** 上游静默判定：连接活着但一个 tag 都不来多久算挂死。
 * 斗鱼 xp2p、虎牙 CDN 都出现过「连接保持、数据停了」的状态——
 * 只记日志没用，必须掐掉重连，否则客户端缓冲一定被耗干。 */
const FLV_SILENT_KILL_MS = Number(process.env.LIVEHUB_FLV_SILENT_MS ?? 4000);
/** 换线时机的下限，太早换等于白折腾 */
const FLV_ROTATE_MIN_AGE_MS = 20000;
/**
 * 各平台默认的换线时机：虎牙实测服务端在 120 秒左右掐断，留出 20 秒余量。
 * 0 表示不主动换线——只有真的观察到断流之后，才按学到的寿命去提前换。
 */
const FLV_ROTATE_BY_PLATFORM = { huya: 100000 };

/**
 * FLV tag 还原器：上游按任意大小分块下发，这里拼回一个个完整 tag。
 * 只有拆出 tag 才读得到时间戳，而时间戳是对齐多连接时间轴的唯一依据。
 */
export class FlvTagSplitter {
  constructor(onHeader) {
    this.buf = Buffer.alloc(0);
    this.headered = false;
    this.onHeader = onHeader || null;
  }

  push(chunk) {
    const tags = [];
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

    // 连接开头是 9 字节 FLV 文件头 + 4 字节 PreviousTagSize0，整个响应只给客户端发一次
    if (!this.headered) {
      if (this.buf.length < 13) return tags;
      if (this.buf.subarray(0, 3).toString('latin1') === 'FLV') {
        if (this.onHeader) this.onHeader(this.buf.subarray(0, 13));
        this.buf = this.buf.subarray(13);
      }
      this.headered = true;
    }

    for (;;) {
      if (this.buf.length < 11) break;
      const type = this.buf[0];
      if (type !== 8 && type !== 9 && type !== 18) {
        // 字节错位：往前找一个像 tag 头的起点，别把整条流丢掉
        let i = 1;
        while (i < this.buf.length && this.buf[i] !== 8 && this.buf[i] !== 9 && this.buf[i] !== 18) i += 1;
        this.buf = this.buf.subarray(i);
        continue;
      }
      const size = (this.buf[1] << 16) | (this.buf[2] << 8) | this.buf[3];
      if (size > 8 * 1024 * 1024) { this.buf = this.buf.subarray(1); continue; }
      const total = 11 + size + 4;
      if (this.buf.length < total) break;
      const ts = ((this.buf[7] << 24) | (this.buf[4] << 16) | (this.buf[5] << 8) | this.buf[6]) >>> 0;
      tags.push({ type, ts, buf: this.buf.subarray(0, total) });
      this.buf = this.buf.subarray(total);
    }
    return tags;
  }
}

/** 改写 tag 时间戳：FLV tag 头第 5~8 字节（低 24 位 + 高 8 位），长度字段不受影响 */
function retag(buf, ts) {
  const out = Buffer.from(buf);
  out[4] = (ts >>> 16) & 0xff;
  out[5] = (ts >>> 8) & 0xff;
  out[6] = ts & 0xff;
  out[7] = (ts >>> 24) & 0xff;
  return out;
}

/**
 * 把多段上游连接拼成一条连续时间轴。
 * 每段连接有自己的 seg（baseIn/baseOut），新段的第一个 tag 决定平移量，
 * 落在老段时间轴里的重复内容按时间戳丢掉。
 */
export class FlvTimeline {
  constructor() {
    this.lastIn = -1;
    this.lastOut = -1;
    this.scriptSent = false;
    this.dropped = 0;
  }

  segment() {
    return { baseIn: null, baseOut: null };
  }

  /** 返回要写给客户端的字节；null 表示这条该丢 */
  accept(seg, tag) {
    if (tag.type === 18) {
      if (this.scriptSent) { this.dropped += 1; return null; }
      this.scriptSent = true;
    }

    // 上游时间轴整体回退（部分 CDN 重连后从 0 开始计时）
    if (seg.baseIn !== null && tag.ts + 5000 < seg.baseIn) {
      seg.baseIn = null;
      seg.baseOut = null;
    }

    if (seg.baseIn === null) {
      // 新连接起点落在老连接已经播过的区间：重复内容丢掉，但最多等 1.5 秒。
      // 差得更多说明它根本不是同一条时间轴，那就宁可跳一下也别冻住画面。
      if (this.lastIn >= 0 && tag.ts <= this.lastIn && this.lastIn - tag.ts <= 1500) {
        this.dropped += 1;
        return null;
      }
      seg.baseIn = tag.ts;
      seg.baseOut = this.lastOut < 0 ? tag.ts : this.lastOut + 1;
    }

    const outTs = seg.baseOut + (tag.ts - seg.baseIn);
    // 换线瞬间老连接可能还会漏进来几条（取消是异步的）：只要落在已播位置之后
    // 就已经被新连接替代了，直接丢，避免时间轴倒退
    if (outTs < this.lastOut) { this.dropped += 1; return null; }
    if (tag.ts > this.lastIn) this.lastIn = tag.ts;
    this.lastOut = outTs;
    return outTs === tag.ts ? tag.buf : retag(tag.buf, outTs);
  }
}

async function streamFlv({ url, platform, headers, res, upstream, refresh, room = '', line = '' }) {
  for (const h of ['content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = upstream.headers.get(h);
    if (v) res.set(h, v);
  }
  if (!res.get('content-type')) res.set('Content-Type', 'video/x-flv');
  res.status(200);
  if (!upstream.body) return res.end();

  const tagCtx = { platform, room, line };
  const log = (event, data) => trace(event, { ...tagCtx, ...data });
  log('stream_begin', { jitterMs: FLV_JITTER_MS });

  // ---- 输出侧：抖动队列 ----
  const queue = [];
  let queuedBytes = 0;
  let closed = false;
  let lastWriteAt = Date.now();
  res.on('close', () => { closed = true; });

  const pump = setInterval(() => {
    if (closed) return;
    while (queue.length && Date.now() - queue[0].at >= FLV_JITTER_MS) {
      const item = queue.shift();
      queuedBytes -= item.chunk.length;
      try {
        res.write(item.chunk);
        lastWriteAt = Date.now();
      } catch {
        closed = true;
        return;
      }
    }
  }, 25);

  const enqueue = (chunk) => {
    queue.push({ chunk, at: Date.now() });
    queuedBytes += chunk.length;
  };

  // ---- 中间：tag 通道。多条连接并行，只有 active 那条的数据会进通道 ----
  const timeline = new FlvTimeline();
  const channel = [];
  const conns = new Set();
  let headerSent = false;
  let finished = false;
  let seq = 0;
  let active = null;
  // 上游活跃度：最后一次收到 tag 的时刻。给停滞看门狗用。
  let lastTagAt = Date.now();
  let everTagged = false;

  const drainTask = (async () => {
    for (;;) {
      if (closed) return;
      if (channel.length) {
        const item = channel.shift();
        while (queuedBytes > FLV_MAX_QUEUE && !closed) await sleep(30);
        if (closed) return;
        const buf = timeline.accept(item.conn.seg, item.tag);
        if (buf) enqueue(buf);
        continue;
      }
      if (finished) return;
      await sleep(8);
    }
  })();

  // 空档看门狗：客户端最怕的就是"服务端这边不出数据了"。
  // 记录每次空档的起止和当时的连接状态，下次再卡就能直接看出是谁的问题。
  let gapStart = 0;
  const gapWatch = setInterval(() => {
    if (closed || finished) return;
    const gap = Date.now() - lastWriteAt;
    if (gap > 2000 && !gapStart) {
      gapStart = Date.now() - gap;
      log('gap_begin', {
        conns: conns.size,
        activeAlive: !!active?.alive,
        activeId: active?.id ?? 0,
        channel: channel.length,
        queued: queuedBytes,
      });
    } else if (gap <= 2000 && gapStart) {
      log('gap_end', { ms: Date.now() - gapStart });
      gapStart = 0;
    }
  }, 500);

  const startConn = (body) => {
    const conn = {
      id: ++seq,
      startedAt: Date.now(),
      alive: true,
      seg: timeline.segment(),
      bytes: 0,
      tags: 0,
      abort: null,
    };
    const reader = body && typeof body.getReader === 'function' ? body.getReader() : null;
    if (!reader) return null;
    conns.add(conn);
    conn.reader = reader;
    conn.lastTs = -1;

    const splitter = new FlvTagSplitter((hdr) => {
      if (!headerSent && conn === active) {
        headerSent = true;
        enqueue(Buffer.from(hdr));
      }
    });

    conn.task = (async () => {
      let why = 'done';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (closed) { why = 'client-closed'; break; }
          if (!value || !value.length) continue;
          conn.bytes += value.length;
          const tags = splitter.push(Buffer.from(value));
          if (!tags.length) continue;
          conn.tags += tags.length;
          conn.lastTs = tags[tags.length - 1].ts;
          if (conn !== active) continue;   // 还没换上的连接只把 socket 排空，一个字节都不发
          lastTagAt = Date.now();
          everTagged = true;
          silentFails = 0;
          for (const tag of tags) channel.push({ conn, tag });
          while (channel.length > FLV_CHANNEL_MAX && !closed) await sleep(12);
        }
      } catch (err) {
        // 被服务端掐断（undici 抛 TypeError: terminated）/ 被自己 abort，都走下面统一收尾
        why = err?.cause?.code || err?.message || 'error';
      }
      conn.alive = false;
      conns.delete(conn);
      const life = Number(((Date.now() - conn.startedAt) / 1000).toFixed(1));
      log('conn_end', { connId: conn.id, why, life, bytes: conn.bytes, tags: conn.tags, wasActive: conn === active });
      if (why !== 'killed') {
        console.error(
          `[flv] conn#${conn.id} 结束(${why}) 存活 ${life}s ${conn.bytes}B/${conn.tags}tag`,
        );
      }
      try { await reader.cancel(); } catch {}
    })();

    // 主动换线用：先取消 socket，任务随即退出，不会再被当成「断流」重连
    conn.kill = () => {
      conn.alive = false;
      try { conn.abort?.(); } catch {}
      try { reader.cancel().catch(() => {}); } catch {}
    };

    return conn;
  };

  let currentUrl = url;

  const openFresh = async (target = currentUrl) => {
    const ac = new AbortController();
    let next;
    try {
      next = await fetch(target, { headers, redirect: 'follow', signal: ac.signal });
    } catch {
      return null;
    }
    if (!next || !next.ok || !next.body) return null;
    const conn = startConn(next.body);
    if (conn) conn.abort = () => ac.abort();
    return conn;
  };

  // 备用签名：趁当前这条连接还在正常出数据时，后台预先解析好下一张地址。
  // 关键在「不 await」——平台接口可能会挂住（http helper 默认 15s 超时），
  // 如果等它返回再重连，这段时间播放器一个字节都收不到，缓冲必然见底。
  let spareUrl = null;
  let spareAt = 0;
  let prefetching = false;
  let lastPrefetchAt = 0;

  const prefetch = () => {
    if (!refresh || prefetching || Date.now() - lastPrefetchAt < 45000) return;
    prefetching = true;
    lastPrefetchAt = Date.now();
    Promise.resolve()
      .then(refresh)
      .then((u) => {
        if (u) { spareUrl = u; spareAt = Date.now(); log('spare_ready', {}); }
      })
      .catch(() => {})
      .finally(() => { prefetching = false; });
  };

  const takeSpare = () => {
    if (spareUrl && Date.now() - spareAt < 180000) {
      const u = spareUrl;
      spareUrl = null;
      currentUrl = u;
      log('spare_used', {});
      return u;
    }
    return null;
  };

  // 解析走平台接口，可能慢/挂住，这里也限时，别让它把整个换线流程拖死。
  const refreshUrl = async () => {
    if (!refresh) return null;
    try {
      const next = await Promise.race([refresh(), sleep(3000).then(() => null)]);
      if (next) currentUrl = next;
      return next;
    } catch {
      return null;
    }
  };

  // 等到新连接的直播时间戳追上当前已播位置（新连接会 burst 一段追上边缘）
  const waitCaughtUp = async (conn, timeoutMs) => {
    const t0 = Date.now();
    for (;;) {
      if (!conn.alive) return false;
      if (timeline.lastIn < 0) return true;
      if (conn.lastTs >= timeline.lastIn) return true;
      if (Date.now() - t0 > timeoutMs) return conn.lastTs > 0;
      await sleep(30);
    }
  };

  // 第一段用已经建立好的连接
  active = startConn(upstream.body);
  if (!active) {
    finished = true;
    clearInterval(pump);
    return res.end();
  }

  let fails = 0;
  let silentFails = 0;    // 连续「静默掐掉且新连接也没出数据」的次数，防无限循环
  let cutLife = 0;        // 观察到的「服务端主动断流」寿命
  let learnedAt = 0;      // 学到的换线时机，0 = 还没学到
  let rotateCooldown = 0; // 换线失败后歇一会儿再试
  let rotating = false;

  try {
    while (!closed) {
      await sleep(100);
      if (closed) break;

      // 停滞看门狗：上游「连接活着但不吐数据」（token 过期、CDN 挂死、链路半死）。
      // 观察期放宽一倍（CDN 冷启动慢），出过数据后 4s 没 tag 就判死——
      // 标记 silentKilled 让下面的重连分支处理，但别把这个寿命学进换线时机。
      if (active?.alive && !rotating) {
        const silent = Date.now() - lastTagAt;
        const limit = everTagged ? FLV_SILENT_KILL_MS : FLV_SILENT_KILL_MS * 2;
        if (silent > limit) {
          silentFails += 1;
          if (silentFails >= 8) {
            log('silent_giveup', { attempts: silentFails });
            console.error(`[flv] ${platform} 连续 ${silentFails} 条连接都无数据，结束转发`);
            break;
          }
          log('silent_kill', { connId: active.id, silentMs: silent, everTagged, silentFails });
          console.error(`[flv] ${platform} 上游静默 ${(silent / 1000).toFixed(1)}s，掐掉重连`);
          active.silentKilled = true;
          active.kill();
        }
      }

      if (!active.alive) {
        const life = Date.now() - active.startedAt;

        // 秒断的连接（签名失效 / CDN 并发限制 / 房间刚下播）连续出现就别无限重连
        if (life < 3000) {
          fails += 1;
          if (fails >= 6) break;      // 收尾，让客户端自己走重连逻辑
          await sleep(300 * fails);
        } else {
          fails = 0;
          // 静默掐掉的连接寿命是随机的，不参与「服务端定时断流」的学习
          if (!active.silentKilled && life < 30 * 60000) {
            cutLife = cutLife ? Math.min(cutLife, life) : life;
            learnedAt = Math.max(FLV_ROTATE_MIN_AGE_MS, cutLife - FLV_ROTATE_LOOKAHEAD_MS);
          }
        }

        // 老地址的签名多半已经作废，优先用后台预取的新签名，实在没有才现解析（限时 3s）
        const target = takeSpare() || (await refreshUrl()) || currentUrl;
        const conn = await openFresh(target);
        if (conn) {
          active = conn;
          lastTagAt = Date.now();   // 给新连接一个完整的静默观察窗口
          prefetch();
          log('reconnect_ok', { prevLife: life, refreshed: !!refresh, fails });
          console.error(
            `[flv] ${platform} 重连成功（上一段 ${(life / 1000).toFixed(0)}s` +
            `${refresh ? '，已重新签名' : ''}）`,
          );
          continue;
        }
        fails += 1;
        log('reconnect_fail', { prevLife: life, fails });
        if (fails >= 6) break;
        await sleep(Math.min(300 * fails, 1200));
        continue;
      }

      // 提前换线：在 CDN 掐断之前把下一条建好、等它追上直播边缘，再切过去。
      // 切的时候老连接还在出数据，所以客户端看不到任何空档。
      const rotateAt = learnedAt || FLV_ROTATE_BY_PLATFORM[platform] || 0;
      const age = Date.now() - active.startedAt;
      // 换线前 25 秒就把新签名备好；没有换线策略的平台也每分钟备一次，防意外断流
      if (!spareUrl && !prefetching && age > 30000 && (rotateAt <= 0 || age > rotateAt - 25000)) prefetch();
      if (rotateAt <= 0 || rotating || Date.now() < rotateCooldown) continue;
      if (age < rotateAt) continue;

      rotating = true;
      const t0 = Date.now();
      try {
        const fresh = takeSpare() || (await refreshUrl());
        const conn = await openFresh(fresh || currentUrl);
        if (!conn) {
          rotateCooldown = Date.now() + 5000;
          log('rotate_fail', { stage: 'open', age, hadSpare: !!fresh });
          console.error(`[flv] ${platform} 换线失败：新连接建不起来，继续用旧的`);
          continue;
        }
        const ok = await waitCaughtUp(conn, 1500);
        if (!ok) {
          conn.kill();
          rotateCooldown = Date.now() + 5000;
          log('rotate_fail', {
            stage: 'no-data',
            age,
            connId: conn.id,
            bytes: conn.bytes,
            tags: conn.tags,
            oldAlive: !!active.alive,
            waitMs: Date.now() - t0,
          });
          console.error(`[flv] ${platform} 换线失败：新连接没数据，继续用旧的`);
          continue;
        }
        const old = active;
        active = conn;
        old.kill();
        prefetch();   // 立刻补一张备用签名，供这条连接中途意外断掉时用
        log('rotate_ok', {
          age,
          oldId: old.id,
          newId: conn.id,
          waitMs: Date.now() - t0,
          newBytes: conn.bytes,
        });
        console.error(
          `[flv] ${platform} 换线完成：conn#${old.id} 用了 ${(age / 1000).toFixed(0)}s，` +
          `conn#${conn.id} 已追上直播边缘`,
        );
      } finally {
        rotating = false;
      }
    }
  } finally {
    finished = true;
    clearInterval(gapWatch);
    if (gapStart) log('gap_end', { ms: Date.now() - gapStart, atEnd: true });
    await Promise.race([drainTask, sleep(400)]);
    clearInterval(pump);
    log('stream_end', { closed, droppedTags: timeline.dropped, lastOut: timeline.lastOut });
    for (const conn of [...conns]) {
      try { conn.abort?.(); } catch {}
    }
    if (!closed) {
      // 把队列里剩下的数据排空再收尾
      while (queue.length && !closed) {
        const item = queue.shift();
        try { res.write(item.chunk); } catch { break; }
        await sleep(5);
      }
      try { res.end(); } catch {}
    }
  }
}

/** 把 m3u8 中的分片、密钥、初始化段全部指向本代理 */
function rewritePlaylist(text, baseUrl, platform) {
  const rewrite = (uri) => {
    try {
      return proxyURL(platform, new URL(uri, baseUrl).href);
    } catch {
      return uri;
    }
  };

  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        // #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA / #EXT-X-I-FRAME-STREAM-INF
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewrite(uri)}"`);
      }
      return rewrite(trimmed);
    })
    .join('\n');
}

/** 轻量探测流地址是否还活着（下播后 CDN 会 403/404） */
export async function probeStream(platform, url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: REFERER[platform] || '' },
    });
    return res.ok;
  } catch {
    return false;
  }
}
