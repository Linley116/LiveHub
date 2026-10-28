// 哔哩哔哩弹幕：官方 Web 长连接，认证包 + 30 秒心跳，消息可能是 brotli 压缩的分包。
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import { CookieJar, getJSON, request, sleep } from '../lib/http.js';
import { applyAccount, cookieValue } from '../accounts.js';

export const meta = {
  id: 'bilibili',
  name: '哔哩哔哩',
  note: '官方 Web 长连接（wss），登录后以账号身份进房，可读取并发送聊天弹幕。',
  send: true,
};

const HEADERS = { Referer: 'https://live.bilibili.com/', Origin: 'https://live.bilibili.com' };
const OP = { HEARTBEAT: 2, HEARTBEAT_REPLY: 3, MESSAGE: 5, AUTH: 7, AUTH_REPLY: 8 };

/** 直播间弹幕长度上限，超出 B 站会直接拒 */
export const DANMAKU_MAX_LENGTH = 30;

/** 两次发送之间的最小间隔。B 站限频比这宽松，本地多留余量避免账号被限 */
const SEND_MIN_INTERVAL_MS = 2000;

/**
 * B 站只回数字错误码，这里换成能看懂的原因。
 * 未列出的码沿用 B 站自带的 message，不至于给出「发送失败(-1024)」这种没用的话。
 */
const SEND_ERRORS = {
  '-101': '账号未登录，请先在 LiveHub 里登录 B 站',
  '-102': '账号已被封禁，无法发送弹幕',
  '-111': '登录凭证已失效（csrf 校验失败），请重新登录 B 站',
  '-352': '被 B 站风控拦下，稍等一会儿再试',
  '-400': '请求被 B 站拒绝，可能是内容或频率问题',
  '-403': '没有该直播间的发言权限',
  '-412': '发送过于频繁，已被 B 站限流',
  10030: '直播间不存在或已关闭',
  10031: '你已被该直播间禁言',
  10032: '该直播间已被封禁，无法发言',
  10033: '需要粉丝勋章等级达到要求才能发言',
  10034: '需要绑定手机号才能发言',
  10035: '需要完成实名认证才能发言',
  10036: '需要关注主播才能发言',
  10037: '该直播间开启了粉丝发言限制',
  10040: '弹幕内容包含敏感词，已被拦截',
  10041: '该直播间已关闭弹幕',
  10042: '弹幕内容为空',
  10043: '发送过于频繁，请慢一点',
  10044: '弹幕内容超出长度限制',
  10045: '弹幕内容与上一条重复',
  10046: '需要直播间等级达到要求才能发言',
};

// WBI 混淆表，B站前端常量
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const jar = new CookieJar();
let sessionReady = null;
let wbiCache = null;
let lastSendAt = 0;

/** 当前登录账号的 uid，用来标记「这条弹幕是我发的」 */
const myUid = () => Number(cookieValue('bilibili', 'DedeUserID')) || 0;

async function ensureSession() {
  if (!sessionReady) {
    sessionReady = (async () => {
      try {
        const spi = await getJSON('https://api.bilibili.com/x/frontend/finger/spi', { jar });
        if (spi?.data?.b_3) jar.set('bilibili.com', 'buvid3', spi.data.b_3);
        if (spi?.data?.b_4) jar.set('bilibili.com', 'buvid4', spi.data.b_4);
      } catch {
        /* 没有指纹时多数接口仍可用 */
      }
    })();
  }
  return sessionReady;
}

/**
 * getDanmuInfo 走 -352 风控，必须带 WBI 的 w_rid / wts。
 * 密钥来自 nav 接口下发的 wbi_img，按固定混淆表重排后取前 32 位。
 */
async function getMixinKey() {
  if (wbiCache && Date.now() - wbiCache.at < 3600_000) return wbiCache.key;
  const nav = await getJSON('https://api.bilibili.com/x/web-interface/nav', {
    jar,
    headers: { Referer: 'https://www.bilibili.com/' },
  });
  const img = nav?.data?.wbi_img?.img_url || '';
  const sub = nav?.data?.wbi_img?.sub_url || '';
  const raw = img.split('/').pop().split('.')[0] + sub.split('/').pop().split('.')[0];
  if (raw.length < 32) throw new Error('WBI 密钥获取失败');
  const key = MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32);
  wbiCache = { key, at: Date.now() };
  return key;
}

async function wbiSign(params) {
  const mixin = await getMixinKey();
  const withTs = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(withTs)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(withTs[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixin).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

function encodePacket(op, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16 + payload.length, 0);
  header.writeUInt16BE(16, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt32BE(op, 8);
  header.writeUInt32BE(1, 12);
  return Buffer.concat([header, payload]);
}

function* parsePackets(buffer) {
  let offset = 0;
  while (offset + 16 <= buffer.length) {
    const total = buffer.readUInt32BE(offset);
    if (total < 16 || offset + total > buffer.length) break;
    yield {
      ver: buffer.readUInt16BE(offset + 6),
      op: buffer.readUInt32BE(offset + 8),
      body: buffer.subarray(offset + 16, offset + total),
    };
    offset += total;
  }
}

export async function connect({ roomId, onMessage, onStatus, onClose }) {
  await ensureSession();
  // 登录态能让部分限制登录的直播间正常下发弹幕
  applyAccount('bilibili', jar);
  const uid = Number(cookieValue('bilibili', 'DedeUserID')) || 0;

  const init = await getJSON(
    `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`,
    { jar, headers: HEADERS },
  );
  if (init.code !== 0) throw new Error(`房间不存在：${init.message || init.msg}`);
  const realRoomId = init.data.room_id;

  const info = await getJSON(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${await wbiSign({ id: realRoomId, type: 0 })}`,
    { jar, headers: HEADERS },
  );
  if (info.code !== 0 || !info.data?.token) throw new Error(`弹幕服务器信息获取失败：${info.message || info.code}`);

  const host = info.data.host_list?.[0]?.host || 'broadcastlv.chat.bilibili.com';
  const ws = new WebSocket(`wss://${host}/sub`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Origin: 'https://live.bilibili.com',
    },
    handshakeTimeout: 10_000,
  });

  let heartbeat = null;
  let closed = false;

  const shutdown = (err) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
    onClose?.(err);
  };

  ws.on('open', () => {
    ws.send(
      encodePacket(
        OP.AUTH,
        JSON.stringify({
          uid,
          roomid: realRoomId,
          protover: 3,
          platform: 'web',
          type: 2,
          key: info.data.token,
        }),
      ),
    );
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodePacket(OP.HEARTBEAT, '[object Object]'));
    }, 30_000);
  });

  ws.on('message', (raw) => {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    for (const packet of parsePackets(buffer)) {
      if (packet.op === OP.AUTH_REPLY) {
        onStatus?.('connected', '弹幕已连接');
        continue;
      }
      if (packet.op === OP.HEARTBEAT_REPLY) continue;
      if (packet.op !== OP.MESSAGE) continue;

      let payload = packet.body;
      try {
        if (packet.ver === 2) payload = zlib.inflateSync(payload);
        else if (packet.ver === 3) payload = zlib.brotliDecompressSync(payload);
      } catch {
        continue;
      }

      const bodies = packet.ver === 2 || packet.ver === 3
        ? [...parsePackets(payload)].map((p) => p.body)
        : [payload];

      for (const body of bodies) {
        let json;
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          continue;
        }
        handleCommand(json, onMessage);
      }
    }
  });

  ws.on('close', () => shutdown(null));
  ws.on('error', (err) => shutdown(err));

  return {
    close() {
      shutdown(null);
    },
  };
}

/**
 * 把前端给的 #rrggbb / 数字收敛成 B 站弹幕的十进制颜色；非法值退回白色。
 * 只允许 0x000000–0xFFFFFF，避免用户在输入框里塞进越界数字。
 */
function normalizeColor(value) {
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())) {
    return Number.parseInt(value.trim().slice(1), 16);
  }
  const num = Number(value);
  if (Number.isInteger(num) && num >= 0 && num <= 0xffffff) return num;
  return 0xffffff;
}

/**
 * 以登录账号的身份往直播间发一条弹幕。
 * 走 B 站 Web 端同一个接口：POST /msg/send，凭 cookie 里的 bili_jct 做 csrf。
 */
export async function sendDanmaku({ roomId, content, color, fontSize, mode }) {
  const text = String(content ?? '').trim();
  if (!text) throw Object.assign(new Error('弹幕内容为空'), { sendCode: 'empty' });
  if (text.length > DANMAKU_MAX_LENGTH) {
    throw Object.assign(new Error(`弹幕最长 ${DANMAKU_MAX_LENGTH} 个字`), { sendCode: 'too_long' });
  }

  applyAccount('bilibili', jar);
  const csrf = cookieValue('bilibili', 'bili_jct');
  const uid = Number(cookieValue('bilibili', 'DedeUserID')) || 0;
  if (!csrf || !uid) {
    throw Object.assign(new Error('尚未登录 B 站账号，无法发送弹幕'), { sendCode: 'no_auth' });
  }

  await ensureSession();

  // 短号要换成真实 room_id，否则 B 站按另一间房处理
  const init = await getJSON(
    `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`,
    { jar, headers: HEADERS },
  );
  if (init.code !== 0) throw new Error(`房间不存在：${init.message || init.msg}`);
  const realRoomId = init.data.room_id;

  // 平台限频之外再加一层本地节流，别让多端并发把账号送进冷却
  const waitMs = SEND_MIN_INTERVAL_MS - (Date.now() - lastSendAt);
  if (waitMs > 0) await sleep(waitMs);

  const form = new URLSearchParams({
    bubble: '0',
    msg: text,
    color: String(normalizeColor(color)),
    mode: String(Number.isInteger(Number(mode)) ? Number(mode) : 1),
    fontsize: String(Number.isInteger(Number(fontSize)) ? Number(fontSize) : 25),
    room_type: '0',
    jumpfrom: '0',
    roomid: String(realRoomId),
    rnd: String(Date.now()),
    csrf,
    csrf_token: csrf,
  });

  const res = await request('https://api.live.bilibili.com/msg/send', {
    jar,
    method: 'POST',
    body: form,
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    throw new Error(`B 站返回了无法解析的内容（HTTP ${res.status}）`);
  }
  lastSendAt = Date.now();

  if (json.code !== 0) {
    // 风控码 -352 补一次 WBI 签名重试，签名材料已经在这份 cookie 的 nav 里
    if (json.code === -352) {
      const retried = await sendWithWbi(realRoomId, form, csrf);
      if (retried) return { ok: true, content: text, roomId: realRoomId, timestamp: Date.now() };
    }
    const reason = SEND_ERRORS[String(json.code)] || json.message || json.msg || `B 站拒绝发送（${json.code}）`;
    throw Object.assign(new Error(reason), { sendCode: json.code });
  }

  return { ok: true, content: text, roomId: realRoomId, timestamp: Date.now() };
}

/** 风控兜底：把同样的参数改成 wbi 签名后的 query 再试一次 */
async function sendWithWbi(realRoomId, form, csrf) {
  try {
    const params = {};
    for (const [key, value] of form) params[key] = value;
    const query = await wbiSign({ ...params, roomid: realRoomId, csrf, csrf_token: csrf });
    const res = await request(`https://api.live.bilibili.com/msg/send?${query}`, {
      jar,
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const json = await res.json().catch(() => null);
    return json?.code === 0;
  } catch {
    return false;
  }
}

function handleCommand(json, onMessage) {
  const cmd = String(json.cmd || '').split(':')[0];

  if (cmd === 'DANMU_MSG') {
    const info = json.info || [];
    const content = info[1];
    const user = info[2]?.[1];
    const color = info[0]?.[3];
    if (typeof content === 'string' && content.trim()) {
      onMessage({
        user: user || '匿名',
        content,
        color: typeof color === 'number' && color > 0 ? `#${color.toString(16).padStart(6, '0')}` : '',
        timestamp: Number(info[0]?.[4]) || Date.now(),
        // 带上「这是不是我发的」，前端据此做已发送回显的去重
        self: Number(info[2]?.[0]) === myUid(),
      });
    }
    return;
  }

  // 醒目留言也属于聊天内容，一并显示
  if (cmd === 'SUPER_CHAT_MESSAGE') {
    const data = json.data || {};
    if (data.message) {
      onMessage({
        user: data.user_info?.uname || '醒目留言',
        content: String(data.message),
        color: '#ffd666',
        timestamp: Date.now(),
      });
    }
  }
}
