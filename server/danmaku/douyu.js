// 斗鱼弹幕：自有 STT 帧 + 文本 key@=value 协议，跑在 WebSocket 上。
// 帧结构（抓包实测）：[4B 总长-4][4B 总长-4][4B 689][payload + \0]
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { CookieJar, getJSON } from '../lib/http.js';
import { applyAccount, cookieValue } from '../accounts.js';

export const meta = {
  id: 'douyu',
  name: '斗鱼',
  note: '官方弹幕 WebSocket，STT 帧格式；读取由服务端直连，发送由桌面端在页面里代发。',
  // 发送交给桌面端：签名/登录态都在页面里，服务端过不了 wsproxy 的客户端校验
  send: 'desktop',
};

/** 网页端输入框上限 50 字 */
export const DANMAKU_MAX_LENGTH = 50;

const HEADERS = { Referer: 'https://www.douyu.com/' };
// 2026-10 实测：wsproxy.douyu.com 的 6671 / 6673 对所有 loginreq 一律回 401000206，
// danmuproxy.douyu.com:8501 匿名即可 LOGIN OK 并正常收弹幕。按可用性排序，失败再换下一条。
const HOSTS = ['wss://danmuproxy.douyu.com:8501/', 'wss://wsproxy.douyu.com:6673/'];
const jar = new CookieJar();

function encodeFrame(text) {
  const body = Buffer.from(`${text}\0`, 'utf8');
  const total = 12 + body.length;
  const head = Buffer.alloc(12);
  head.writeInt32LE(total - 4, 0);
  head.writeInt32LE(total - 4, 4);
  head.writeInt32LE(689, 8);
  return Buffer.concat([head, body]);
}

function decodeFrames(buffer) {
  return buffer
    .toString('utf8')
    .split('\0')
    .map((chunk) => {
      const at = chunk.indexOf('type@=');
      return at >= 0 ? chunk.slice(at) : '';
    })
    .filter(Boolean);
}

function parseKV(message) {
  const out = {};
  for (const part of message.split('/')) {
    const sep = part.indexOf('@=');
    if (sep <= 0) continue;
    out[part.slice(0, sep)] = part.slice(sep + 2).replace(/@S/g, '/').replace(/@A/g, '@');
  }
  return out;
}

async function resolveRoom(roomId) {
  try {
    applyAccount('douyu', jar);
    const info = await getJSON(`https://www.douyu.com/betard/${encodeURIComponent(roomId)}`, {
      jar,
      headers: HEADERS,
    });
    return String(info?.room?.room_id || roomId);
  } catch {
    return String(roomId);
  }
}

/**
 * 登录包参数照抄网页端（2026-10 抓包）：
 *   .../devid@=/ct@=0/pt@=2/cvr@=0/tvr@=7/apd@=/jwt@=/rt@=/vk@=/ver@=20220825/...
 * 少任何一个（尤其 vk@=）都会被判 401000206。
 * 登录态来自网页 cookie：acf_uid/acf_auth/acf_ltkid/acf_biz/acf_stk/acf_ct
 * —— 这正是「保存账号」能救活斗鱼弹幕的原因：匿名连接会被限流到基本收不到消息。
 */
function buildLogin(roomId) {
  // devid 必须是 32 位十六进制，短了会被判参数错误
  const devid = crypto.randomBytes(16).toString('hex');
  const rt = Math.floor(Date.now() / 1000);
  const uid = cookieValue('douyu', 'acf_uid');
  const auth = cookieValue('douyu', 'acf_auth');
  const ltkid = cookieValue('douyu', 'acf_ltkid');
  const biz = cookieValue('douyu', 'acf_biz');
  const stk = cookieValue('douyu', 'acf_stk');
  const ct = cookieValue('douyu', 'acf_ct') || '0';
  // 网页端 2026 版登录帧额外带 jwt（acf_dmjwt_token），里面已含 uid/ltkid/stk，
  // 不带的话部分线路只给匿名权限，发送会被拒。
  const jwt = cookieValue('douyu', 'acf_dmjwt_token');
  return (
    `type@=loginreq/roomid@=${roomId}/dfl@=/username@=${uid || ''}/password@=${auth || ''}/` +
    `ltkid@=${ltkid || ''}/biz@=${biz || ''}/stk@=${stk || ''}/devid@=${devid}/ct@=${ct}/` +
    `pt@=2/cvr@=0/tvr@=7/apd@=/jwt@=${jwt || ''}/rt@=${rt}/vk@=/ver@=20220825/aver@=218101901/` +
    `dmbt@=chrome/dmbv@=156/`
  );
}

/**
 * 连一条线并完成登录。
 * 关键：WebSocket 握手成功不代表可用——wsproxy 会正常握手、再拿 401000206 拒绝登录。
 * 所以必须等到 loginres 才算成功，否则换下一条线。
 */
function joinHost(host, roomId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(host, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Origin: 'https://www.douyu.com',
      },
      handshakeTimeout: 8_000,
    });

    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      if (err) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        reject(err);
      } else {
        resolve(ws);
      }
    };

    const onError = (err) => settle(err);
    const onMessage = (raw) => {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      for (const frame of decodeFrames(buffer)) {
        const data = parseKV(frame);
        if (data.type === 'loginres') {
          ws.send(encodeFrame(`type@=joingroup/rid@=${roomId}/gid@=-9999/`));
          ws.send(encodeFrame('type@=get/msgtype@=oni/'));
          settle(null);
          return;
        }
        if (data.type === 'error') {
          settle(new Error(`斗鱼弹幕返回错误：${data.code || '未知'}`));
          return;
        }
      }
    };

    const timer = setTimeout(() => settle(new Error('斗鱼弹幕登录超时')), 9_000);
    ws.once('open', () => ws.send(encodeFrame(buildLogin(roomId))));
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

async function joinRoom(roomId) {
  let lastError = null;
  for (const host of HOSTS) {
    try {
      return await joinHost(host, roomId);
    } catch (err) {
      lastError = err;
      console.error(`[douyu] ${host} 登录失败:`, err.message);
    }
  }
  throw lastError || new Error('斗鱼弹幕服务器连接失败');
}

export async function connect({ roomId, onMessage, onStatus, onClose }) {
  const realRoomId = await resolveRoom(roomId);
  const ws = await joinRoom(realRoomId);

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

  onStatus?.('connected', '弹幕已连接');

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        encodeFrame(
          `type@=keeplive/vbw@=0/cdn@=/tick@=${Math.floor(Date.now() / 1000)}/kd@=/alg_ver@=1.0/key_ver@=1.1/`,
        ),
      );
    }
  }, 30_000);

  ws.on('message', (raw) => {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    for (const frame of decodeFrames(buffer)) {
      const data = parseKV(frame);

      if (data.type === 'error') {
        shutdown(new Error(`斗鱼弹幕返回错误：${data.code || '未知'}`));
        return;
      }

      if (data.type === 'chatmsg' && data.txt) {
        const color = Number(data.col);
        onMessage({
          user: data.nn || '匿名',
          content: data.txt,
          // col 是弹幕颜色；默认值 0/1 表示不染色，用 1 以下的深色会在深色底上看不清
          color: Number.isFinite(color) && color > 1 ? `#${color.toString(16).padStart(6, '0')}` : '',
          // cst 已经是毫秒时间戳，不要再乘 1000
          timestamp: Number(data.cst) || Date.now(),
        });
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

// 斗鱼发送由桌面端在真实页面里代发（见 desktop/sender.cjs）：
// 官方发送通道必须走 wsproxy，而它对非浏览器客户端的 TLS 指纹一律返回 401000206，
// 服务端无论如何构造登录帧都过不去；danmuproxy 能登录但会静默丢弃 chatmessage 帧（实测）。