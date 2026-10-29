// 直播流代理：解决 Referer/CORS 限制，并把 m3u8 里的分片地址改写成走本代理。
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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

export function proxyURL(platform, url) {
  return `/api/proxy?p=${platform}&u=${encodeTarget(url)}`;
}

/**
 * 代理入口。
 * 直播流是长连接，客户端切清晰度/关页面时上游会被中断，undici 抛 `TypeError: terminated`；
 * Express 不会自动捕获 async 异常，不兜住就会变成未捕获异常把主进程弹崩。
 */
export async function proxyHandler(req, res) {
  try {
    await handleProxy(req, res);
  } catch (err) {
    const reason = err.cause?.message || err.message || '未知错误';
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(502).send(`proxy error: ${reason}`);
  }
}

async function handleProxy(req, res) {
  const platform = String(req.query.p || '');
  const target = String(req.query.u || '');
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
  if (isFlv) return streamFlv({ url: url.href, platform, headers, res, upstream });

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
 * FLV 直播流专用转发：抖动缓冲 + 断流透明重连。
 *
 * 为什么需要：
 * 1. 虎牙的 FLV 连接会被服务端在约 127 秒后关闭，上游一断客户端就看到 EOF，
 *    播放器只能整体重连，表现就是「每两分钟卡一下、然后重新缓冲」。这里在上游
 *    EOF 后自己用同一地址重连（实测时间戳连续：48416622ms → 48539695ms），
 *    跳过新连接重复的 FLV 头，客户端看到的字节流没有断点。
 * 2. 抖音/CDN 的数据是爆发式下发，忽快忽慢。这里对每块数据做固定延迟转发，
 *    相当于在服务端放一个抖动缓冲，上游短暂停顿不会立刻传导到播放器。
 *
 * 只作用于 FLV（所有四个平台现在都走 FLV）；HLS 的分片是短文件，走原逻辑。
 */
const FLV_JITTER_MS = Number(process.env.LIVEHUB_FLV_JITTER_MS ?? 800);
const FLV_MAX_QUEUE = 24 * 1024 * 1024;

async function streamFlv({ url, platform, headers, res, upstream }) {
  for (const h of ['content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = upstream.headers.get(h);
    if (v) res.set(h, v);
  }
  if (!res.get('content-type')) res.set('Content-Type', 'video/x-flv');
  res.status(200);

  const queue = [];
  let queuedBytes = 0;
  let closed = false;
  res.on('close', () => { closed = true; });

  // 定时把「已经等了够久」的数据写出去
  const pump = setInterval(() => {
    if (closed) return;
    while (queue.length && Date.now() - queue[0].at >= FLV_JITTER_MS) {
      const item = queue.shift();
      queuedBytes -= item.chunk.length;
      try {
        res.write(item.chunk);
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

  // 把一条上游连接的数据读进队列。
  // 返回 'done'（正常结束）/ 'error'（被对端掐断，undici 会抛 TypeError: terminated）/
  // 'closed'（客户端已经走了）。三种里前两种都要重连，不能直接收尾——
  // 之前把 error 当结束处理，结果虎牙一断流代理就结束响应。
  const feed = async (reader) => {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        return 'error';
      }
      const { done, value } = chunk;
      if (done) return 'done';
      if (closed) { try { await reader.cancel(); } catch {} return 'closed'; }
      if (value && value.length) {
        while (queuedBytes > FLV_MAX_QUEUE && !closed) await sleep(60);
        enqueue(Buffer.from(value));
      }
    }
  };

  let firstChunk = true;
  let fails = 0;

  try {
    // 第一段用已经建立好的连接
    let reader = upstream.body ? upstream.body.getReader() : null;
    if (!reader) return res.end();

    for (;;) {
      const why = await feed(reader);
      if (closed || why === 'closed') break;
      await sleep(why === 'error' ? 60 : 120);

      // 重连
      let next;
      try {
        next = await fetch(url, { headers, redirect: 'follow' });
      } catch {
        next = null;
      }
      if (!next || !next.ok || !next.body) {
        fails += 1;
        if (fails >= 3) break;      // 连续失败就放弃，让客户端自己重连
        await sleep(400 * fails);
        continue;
      }
      reader = next.body.getReader();
      // 重连后的第一块如果带 FLV 头（FLV\x01 + 9 字节头 + 4 字节 PreviousTagSize0），去掉
      const { done, value } = await reader.read();
      if (done) continue;
      let chunk = Buffer.from(value);
      if (chunk.length >= 13 && chunk.slice(0, 3).toString() === 'FLV') chunk = chunk.slice(13);
      enqueue(chunk);
      firstChunk = false;
      fails = 0;
    }
  } catch {
    // 上游异常：让客户端看到结束，走它自己的重连
  } finally {
    clearInterval(pump);
    if (!closed) {
      // 把队列里剩下的数据排空再收尾
      while (queue.length && !closed) {
        const item = queue.shift();
        try { res.write(item.chunk); } catch { break; }
        await sleep(10);
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
