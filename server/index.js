// LiveHub 服务端：聚合四个平台的直播解析 + 流代理 + 关注列表存储
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { PLATFORMS, parseInput, resolveRoom } from './resolvers/index.js';
import * as accounts from './accounts.js';
import { proxyHandler, proxyURL } from './proxy.js';
import { addRoom, getRoom, listRooms, removeRoom, reorderRooms, roomKey, updateRoom } from './store.js';
import { DANMAKU_MAX_LENGTH, findEcho, getDanmakuStatus, ingestDanmaku, sendDanmaku, subscribe } from './danmaku/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 7788;

const app = express();
// 影子窗口回灌的是 protobuf 二进制（base64 后更大），上限放宽到 2MB
app.use(express.json({ limit: '2mb' }));

// 15 秒内复用解析结果，避免前端重连时把平台接口打爆
const cache = new Map();
const CACHE_TTL = 15_000;

async function resolveCached(platform, roomId, opts = {}) {
  const key = `${platform}:${roomId}:${opts.qn || opts.rate || opts.ratio || opts.quality || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
  const data = await resolveRoom(platform, roomId, opts);
  cache.set(key, { at: Date.now(), data });
  return data;
}

function withProxy(data, platform) {
  return {
    ...data,
    key: roomKey(platform, data.roomId),
    author: PLATFORMS[platform]?.name || platform,
    // 封面同样走代理：各平台图片 CDN 会校验 Referer，直连在浏览器里多半 403
    cover: data.cover ? proxyURL(platform, data.cover) : '',
    streams: (data.streams || []).map((s) => ({ ...s, url: proxyURL(platform, s.url) })),
  };
}

app.get('/api/platforms', (_req, res) => {
  res.json(
    Object.values(PLATFORMS).map((p) => ({ id: p.id, name: p.name, color: p.color })),
  );
});

/**
 * 账号：桌面端登录窗口把整份 cookie 推给这里，解析器和弹幕连接器共用。
 * cookie 只存在本机 data/accounts.json，接口不回传完整内容。
 */
app.get('/api/accounts', (_req, res) => {
  res.json(
    accounts.listAccounts().map((item) => ({
      ...item,
      name: PLATFORMS[item.platform]?.name || item.platform,
      color: PLATFORMS[item.platform]?.color || '',
      loginUrl: accounts.LOGIN_URL[item.platform],
    })),
  );
});

app.post('/api/accounts/:platform', async (req, res) => {
  const platform = String(req.params.platform || '');
  if (!accounts.ACCOUNT_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: '未知平台' });
  }
  const cookie = String(req.body?.cookie || '').trim();
  if (!cookie) return res.status(400).json({ error: '缺少 cookie' });

  try {
    let nickname = String(req.body?.nickname || '').trim();
    if (!nickname) nickname = await accounts.probeNickname(platform, cookie).catch(() => '');
    const saved = await accounts.saveAccount(platform, cookie, { nickname });
    cache.clear(); // 登录后立刻重算，别让 15 秒的旧结果继续压着清晰度
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/accounts/:platform', async (req, res) => {
  const platform = String(req.params.platform || '');
  if (!accounts.ACCOUNT_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: '未知平台' });
  }
  const removed = await accounts.removeAccount(platform);
  cache.clear();
  res.json(removed);
});

app.get('/api/danmaku/status', (req, res) => {
  const platform = String(req.query.platform || '');
  const status = getDanmakuStatus(platform);
  if (!status || !PLATFORMS[platform]) return res.status(400).json({ error: '未知平台' });
  // maxLength 用平台自己的上限（各平台不一样），不要在这里覆盖成全局兜底值
  res.json(status);
});

/**
 * 发送弹幕：以 LiveHub 里登录的账号身份发出去。
 * 平台拒绝时把原因翻成中文再回给前端，前端直接 toast 展示。
 */
app.post('/api/danmaku/send', async (req, res) => {
  const platform = String(req.body?.platform || '');
  const roomId = String(req.body?.room || '');
  const content = String(req.body?.content ?? '');
  if (!PLATFORMS[platform] || !roomId) {
    return res.status(400).json({ error: '缺少 platform 或 room 参数' });
  }
  if (!content.trim()) return res.status(400).json({ error: '弹幕内容为空' });

  try {
    const result = await sendDanmaku(platform, roomId, {
      content,
      color: req.body?.color,
    });
    res.json(result);
  } catch (err) {
    console.error(`[danmaku] ${platform}:${roomId} 发送失败:`, err.message);
    // 未登录 / 不支持 / 需要桌面端代发 属于配置问题，用 400 让前端给出可操作的提示
    const configError = ['no_auth', 'unsupported', 'unknown_platform', 'need_desktop'].includes(err.sendCode);
    res.status(configError ? 400 : 429).json({ error: err.message, code: err.sendCode || 'failed' });
  }
});

/**
 * 回查回显：桌面端在页面里发完弹幕后，用来确认「平台真的收了吗」。
 * 有些平台（斗鱼）不把回显写进页面 DOM，只能靠平台回推来判定。
 */
app.get('/api/danmaku/echo', (req, res) => {
  const platform = String(req.query.platform || '');
  const roomId = String(req.query.room || '');
  const content = String(req.query.content || '');
  if (!PLATFORMS[platform] || !roomId) return res.status(400).json({ error: '缺少 platform 或 room' });
  const since = Number(req.query.since) || 30_000;
  const seen = findEcho(platform, roomId, content, Math.min(Math.max(since, 5_000), 120_000));
  // known=false 表示这个房间当前没有活跃弹幕流，结论不可用
  res.json({ seen: seen === true, known: seen !== null });
});

/**
 * 影子窗口回灌：桌面端把抖音页面 im/fetch 的响应体分片 POST 上来。
 * 服务端只做解码和分发，不保存任何东西。
 */
app.post('/api/danmaku/ingest', (req, res) => {
  const platform = String(req.body?.platform || '');
  const roomId = String(req.body?.room || '');
  const frames = Array.isArray(req.body?.frames) ? req.body.frames : [];
  if (!PLATFORMS[platform] || !roomId || !frames.length) {
    return res.status(400).json({ error: '缺少 platform / room / frames' });
  }
  const buffers = [];
  for (const frame of frames.slice(0, 64)) {
    if (typeof frame === 'string' && frame) buffers.push(Buffer.from(frame, 'base64'));
  }
  const decoded = ingestDanmaku(platform, roomId, buffers);
  res.json({ ok: true, decoded });
});

/**
 * 弹幕推送用 SSE：单向、自动重连，比再开一条 WebSocket 简单。
 * 同一个房间的多个页面共享一条上游连接。
 */
app.get('/api/danmaku/stream', (req, res) => {
  const platform = String(req.query.platform || '');
  const roomId = String(req.query.room || '');
  if (!PLATFORMS[platform] || !roomId) return res.status(400).json({ error: '缺少 platform 或 room 参数' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const send = (kind, payload) => {
    if (res.writableEnded) return;
    res.write(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  let unsubscribe = () => {};
  try {
    unsubscribe = subscribe(platform, roomId, send);
  } catch (err) {
    send('status', { platform, roomId, state: 'error', message: err.message, read: false, send: false });
    res.end();
    return;
  }

  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 20_000);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

app.get('/api/rooms', async (_req, res) => {
  const rooms = await listRooms();
  res.json(rooms.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(decorateRoom));
});

/**
 * 批量刷新目录里的开播状态。
 * 逐个 resolve 会让平台接口立刻限流，所以限制并发 + 最小间隔；
 * 单个房间失败时保留上一次的状态，只记下原因，避免整张目录变灰。
 */
const REFRESH_CONCURRENCY = 3;
const REFRESH_MIN_INTERVAL = 45_000;

app.post('/api/rooms/refresh', async (req, res) => {
  const force = !!req.body?.force;
  const rooms = await listRooms();
  const now = Date.now();
  const targets = rooms.filter(
    (room) => force || !room.lastChecked || now - room.lastChecked > REFRESH_MIN_INTERVAL,
  );

  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const room = targets[cursor++];
      try {
        const data = await resolveRoom(room.platform, room.roomId);
        await updateRoom(room.key, {
          title: data.title || room.title,
          anchor: data.anchor || room.anchor,
          avatar: data.avatar || room.avatar,
          cover: data.cover || room.cover,
          area: data.area || room.area,
          online: Number(data.online) || 0,
          live: !!data.live,
          lastChecked: Date.now(),
          lastError: '',
        });
      } catch (err) {
        console.error(`[refresh] ${room.key} 刷新失败:`, err.message);
        await updateRoom(room.key, { lastChecked: Date.now(), lastError: err.message });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(REFRESH_CONCURRENCY, targets.length) }, () => worker()),
  );

  const updated = await listRooms();
  res.json({
    rooms: updated.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(decorateRoom),
    refreshed: targets.length,
    failed: updated.filter((room) => room.lastError).length,
  });
});

function decorateRoom(room) {
  return {
    ...room,
    cover: room.cover ? proxyURL(room.platform, room.cover) : '',
    avatar: room.avatar ? proxyURL(room.platform, room.avatar) : '',
  };
}

app.post('/api/rooms', async (req, res) => {
  try {
    const { input, platform: hint } = req.body || {};
    const { platform, roomId } = await parseInput(input, hint);
    // 先落盘，之后尽力补充主播名、封面与开播状态；元数据失败不会丢掉用户导入的房间。
    const { room, added } = await addRoom({
      platform,
      roomId,
      title: `${PLATFORMS[platform].name} 房间 ${roomId}`,
      anchor: '',
      cover: '',
      avatar: '',
      live: false,
      lastChecked: null,
    });
    let result = room;
    let pending = room.lastChecked === null;
    if (pending) {
      try {
        const data = await resolveCached(platform, room.roomId);
        result = await updateRoom(room.key, {
          title: data.title || room.title,
          anchor: data.anchor || '',
          avatar: data.avatar || '',
          cover: data.cover || '',
          online: Number(data.online) || 0,
          live: !!data.live,
          lastChecked: Date.now(),
        });
        pending = false;
      } catch {
        // 保留基础房间记录，之后仍可从 LiveHub 内的观看页重新解析。
      }
    }
    res.json({ ...decorateRoom(result), added, pending });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/rooms/:key', async (req, res) => {
  const ok = await removeRoom(req.params.key);
  res.json({ ok });
});

app.post('/api/rooms/reorder', async (req, res) => {
  const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
  res.json(await reorderRooms(keys));
});

app.patch('/api/rooms/:key', async (req, res) => {
  const patch = {};
  if (typeof req.body?.title === 'string') patch.customTitle = req.body.title.slice(0, 80);
  if (typeof req.body?.pinned === 'boolean') patch.pinned = req.body.pinned;
  const room = await updateRoom(req.params.key, patch);
  res.json(room || { error: '房间不存在' });
});

app.get('/api/resolve', async (req, res) => {
  const platform = String(req.query.platform || '');
  const roomId = String(req.query.room || '');
  if (!PLATFORMS[platform] || !roomId) return res.status(400).json({ error: '缺少 platform 或 room 参数' });

  try {
    const data = await resolveCached(platform, roomId, {
      qn: req.query.qn,
      rate: req.query.rate,
      ratio: req.query.ratio,
      quality: req.query.quality,
    });
    const payload = withProxy(data, platform);
    // 顺手更新本地缓存里的房间标题/在线状态
    const existing = await getRoom(payload.key);
    if (existing) {
      await updateRoom(payload.key, {
        title: data.title,
        anchor: data.anchor,
        cover: data.cover,
        live: data.live,
        online: Number(data.online) || 0,
        lastChecked: Date.now(),
      });
    }
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/proxy', proxyHandler);

app.use('/vendor/hls.js', express.static(path.join(ROOT, 'node_modules/hls.js/dist')));
app.use('/vendor/mpegts.js', express.static(path.join(ROOT, 'node_modules/mpegts.js/dist')));
app.use(express.static(path.join(ROOT, 'web')));

// async 路由抛错不会自动进 Express 的默认处理，这里统一收口
app.use((err, req, res, _next) => {
  console.error(`[http] ${req.method} ${req.originalUrl} →`, err.message);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: '服务端处理异常' });
});

/**
 * 直播流是长连接，客户端切清晰度/关页面时会主动断开上游，
 * undici 抛 `TypeError: terminated` / EPIPE 属于正常现象，不能让它把整个进程带走。
 */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
});

/** 启动 HTTP 服务。桌面端直接调用（端口传 0 让系统分配），CLI 走下面的直接运行分支。 */
export function startServer({ port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      console.log(`\n  LiveHub 已启动  →  http://127.0.0.1:${actual}\n`);
      resolve({ server, port: actual });
    });
    server.once('error', reject);
  });
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  startServer().catch((err) => {
    console.error('LiveHub 启动失败:', err.message);
    process.exit(1);
  });
}
