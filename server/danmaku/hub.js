// 弹幕会徽中心：按 (platform, roomId) 管理一条连接，多端订阅共享，最后一个订阅离开后延时关闭。
import * as bilibili from './bilibili.js';
import * as douyu from './douyu.js';
import * as huya from './huya.js';
import * as douyin from './douyin.js';
import { isLoggedIn } from '../accounts.js';

export const CONNECTORS = { bilibili, douyu, huya, douyin };

/**
 * 发送能力有两种实现：
 *   server —— 连接器自己实现 sendDanmaku（B 站，HTTP 直发）
 *   desktop —— 签名/登录态都在页面里，交给桌面端在真实页面里代发（斗鱼/虎牙/抖音）
 */
const sendModeOf = (platform) => {
  const connector = CONNECTORS[platform];
  if (!connector) return false;
  if (typeof connector.sendDanmaku === 'function') return 'server';
  return connector.meta.send === 'desktop' ? 'desktop' : false;
};

const canSend = (platform) => Boolean(sendModeOf(platform));

const RETRY_BASE_MS = 1500;
const RETRY_MAX_MS = 30_000;
const IDLE_CLOSE_MS = 60_000;
const BACKLOG_MAX = 60;

const sessions = new Map();

function publicStatus(session) {
  return {
    platform: session.platform,
    roomId: session.roomId,
    state: session.state,
    message: session.message,
    read: CONNECTORS[session.platform]?.meta.read !== false,
    send: canSend(session.platform),
    sendMode: sendModeOf(session.platform),
    loggedIn: isLoggedIn(session.platform),
    maxLength: maxLengthOf(session.platform),
    updatedAt: session.updatedAt,
  };
}

function emitStatus(session, state, message) {
  session.state = state;
  session.message = message;
  session.updatedAt = Date.now();
  const payload = publicStatus(session);
  for (const send of session.subscribers) send('status', payload);
}

function emitMessage(session, msg) {
  const item = {
    platform: session.platform,
    roomId: session.roomId,
    user: String(msg.user ?? ''),
    content: String(msg.content ?? ''),
    color: msg.color || '',
    timestamp: msg.timestamp || Date.now(),
    // 「这条是本人发的」要透传给前端，否则自己发的弹幕会回显两遍
    self: !!msg.self,
  };
  if (!item.content) return;
  session.backlog.push(item);
  if (session.backlog.length > BACKLOG_MAX) session.backlog.shift();
  for (const send of session.subscribers) send('message', item);
}

function scheduleRetry(session, reason) {
  if (session.closed) return;
  session.retry += 1;
  const delay = Math.min(RETRY_BASE_MS * 2 ** (session.retry - 1), RETRY_MAX_MS);
  emitStatus(
    session,
    'reconnecting',
    `${reason || '连接中断'}，${Math.round(delay / 1000)} 秒后重连（第 ${session.retry} 次）`,
  );
  clearTimeout(session.retryTimer);
  session.retryTimer = setTimeout(() => {
    session.handle = null;
    start(session);
  }, delay);
}

async function start(session) {
  if (session.closed) return;
  const connector = CONNECTORS[session.platform];
  emitStatus(session, 'connecting', `正在连接${connector.meta.name}弹幕…`);
  try {
    session.handle = await connector.connect({
      roomId: session.roomId,
      onMessage: (msg) => emitMessage(session, msg),
      onStatus: (state, message) => emitStatus(session, state, message),
      onClose: (err) => {
        if (session.closed) return;
        if (err?.fatal) {
          emitStatus(session, 'error', err.message);
          return;
        }
        scheduleRetry(session, err?.message);
      },
    });
    if (!session.closed) session.retry = 0;
  } catch (err) {
    console.error(`[danmaku] ${session.platform}:${session.roomId} 连接失败:`, err.message);
    if (err.fatal) {
      emitStatus(session, 'error', err.message);
      return;
    }
    scheduleRetry(session, err.message);
  }
}

function createSession(platform, roomId) {
  const session = {
    platform,
    roomId,
    subscribers: new Set(),
    backlog: [],
    state: 'connecting',
    message: '正在准备弹幕通道…',
    updatedAt: Date.now(),
    closed: false,
    retry: 0,
    handle: null,
    retryTimer: null,
    idleTimer: null,
  };
  start(session);
  return session;
}

function teardown(key, session) {
  if (session.subscribers.size) return;
  session.closed = true;
  clearTimeout(session.retryTimer);
  clearTimeout(session.idleTimer);
  try {
    session.handle?.close?.();
  } catch {
    /* 关闭失败无所谓，进程退出也会回收 */
  }
  sessions.delete(key);
}

/**
 * 订阅某个房间的弹幕。send(kind, payload) 用来把事件推给 SSE 客户端。
 * 返回取消订阅函数。
 */
export function subscribe(platform, roomId, send) {
  if (!CONNECTORS[platform]) throw new Error(`不支持的平台：${platform}`);
  const key = `${platform}:${roomId}`;
  let session = sessions.get(key);
  if (!session) {
    session = createSession(platform, roomId);
    sessions.set(key, session);
  }
  clearTimeout(session.idleTimer);
  session.idleTimer = null;
  session.subscribers.add(send);

  send('status', publicStatus(session));
  for (const msg of session.backlog) send('message', msg);

  return () => {
    session.subscribers.delete(send);
    if (!session.subscribers.size) {
      session.idleTimer = setTimeout(() => teardown(key, session), IDLE_CLOSE_MS);
    }
  };
}

/**
 * 影子窗口回灌的响应体分片。只有抖音这种「服务端连不上、由页面代抓」的连接器会实现 ingest。
 * 返回本次解出的弹幕条数。
 */
export function ingestDanmaku(platform, roomId, buffers) {
  const connector = CONNECTORS[platform];
  if (!connector || typeof connector.ingest !== 'function') return 0;
  let total = 0;
  for (const buffer of buffers) total += connector.ingest(roomId, buffer);
  return total;
}

/** 弹幕长度上限的兜底值：各平台自己的上限优先 */
export const DANMAKU_MAX_LENGTH = bilibili.DANMAKU_MAX_LENGTH || 30;

/** 某平台实际允许的字数 */
export function maxLengthOf(platform) {
  return CONNECTORS[platform]?.DANMAKU_MAX_LENGTH || DANMAKU_MAX_LENGTH;
}

/**
 * 发一条弹幕。平台不支持发送或被平台拒绝都抛 Error（带 sendCode）。
 * @param {string} platform
 * @param {string} roomId
 * @param {{ content: string, color?: string|number }} payload
 */
export async function sendDanmaku(platform, roomId, payload) {
  const connector = CONNECTORS[platform];
  if (!connector) throw Object.assign(new Error(`不支持的平台：${platform}`), { sendCode: 'unknown_platform' });
  const mode = sendModeOf(platform);
  if (mode === 'desktop') {
    throw Object.assign(
      new Error(`${connector.meta.name}的弹幕需要在桌面端发送（签名与登录态都在页面里）`),
      { sendCode: 'need_desktop' },
    );
  }
  if (typeof connector.sendDanmaku !== 'function') {
    throw Object.assign(new Error(`暂不支持往${connector.meta.name}发送弹幕`), { sendCode: 'unsupported' });
  }
  const limit = maxLengthOf(platform);
  const content = String(payload?.content ?? '').trim().slice(0, limit);
  return connector.sendDanmaku({ roomId, ...payload, content });
}

/**
 * 回查「这条弹幕是不是真的进了直播间」。
 * 依据是平台回推进了该房间的 backlog —— 用户发弹幕时正在看这个房间，流是现成的。
 * 桌面端页面判据（DOM 里出现文本）在某些平台不成立（斗鱼就不把回显写进 body.innerText），
 * 这时用这条做第二判据。
 */
export function findEcho(platform, roomId, content, sinceMs = 30_000) {
  const session = sessions.get(`${platform}:${roomId}`);
  // 没有活跃订阅就无从判断：返回 null，让调用方别把「查不到」当成「没发出去」
  if (!session) return null;
  const text = String(content ?? '').trim();
  if (!text) return null;
  const since = Date.now() - sinceMs;
  return session.backlog.some((item) => item.content.trim() === text && item.timestamp >= since);
}

/** 平台能力 + 当前是否有活跃连接 */
export function getDanmakuStatus(platform) {
  const connector = CONNECTORS[platform];
  if (!connector) return null;
  const active = [...sessions.values()].filter((session) => session.platform === platform);
  return {
    platform,
    name: connector.meta.name,
    read: connector.meta.read !== false,
    send: canSend(platform),
    sendMode: sendModeOf(platform),
    loggedIn: isLoggedIn(platform),
    maxLength: maxLengthOf(platform),
    state: active.length ? active[0].state : 'idle',
    message: active.length ? active[0].message : `进入房间后自动连接${connector.meta.name}弹幕`,
    activeRooms: active.length,
    note: connector.meta.note || '',
  };
}
