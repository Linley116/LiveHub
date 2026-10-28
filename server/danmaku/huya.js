// 虎牙弹幕：wsapi.huya.com 消息组订阅（命令 16），接收单条/批量推送（命令 7/22）。
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { getJSON } from '../lib/http.js';
import { TARS_TYPE, TarsReader, TarsWriter } from './tars.js';

export const meta = {
  id: 'huya',
  name: '虎牙',
  note: 'wsapi.huya.com 消息组订阅读取弹幕；发送由桌面端在页面里代发（TAF RPC 依赖页面登录态）。',
  send: 'desktop',
};

/** 虎牙输入框上限 30 字 */
export const DANMAKU_MAX_LENGTH = 30;

const HOST = 'wss://wsapi.huya.com/';
const HUYA_UA = 'webh5&2608121011&websocket';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CMD = { PUSH: 7, SUBSCRIBE: 16, SUBSCRIBE_RESULT: 17, GROUP_PUSH: 22 };
const URI_CHAT = 1400;

/**
 * 按 Tars 规范消费一个结构体：读到 STRUCT_END 为止。
 * 不能用「tag 超过上限就回退」的写法——嵌套结构体没有消费完，
 * 外层会把内层的字段当成自己的字段，整条消息就此错位。
 */
function parseStruct(reader, handlers) {
  while (!reader.done) {
    const { type, tag } = reader.head();
    if (type === TARS_TYPE.STRUCT_END) return;
    const handler = handlers[tag];
    if (handler) handler(reader, type);
    else reader.skip(type);
  }
}

function readStringList(reader, type) {
  const count = reader.readListSize(type);
  const values = [];
  for (let i = 0; i < count; i++) {
    const item = reader.head();
    if (item.type === TARS_TYPE.STRING1 || item.type === TARS_TYPE.STRING4) {
      values.push(reader.string(item.type));
    } else {
      reader.skip(item.type);
    }
  }
  return values;
}

function readPushList(reader, type) {
  const count = reader.readListSize(type);
  const items = [];
  for (let i = 0; i < count; i++) {
    const element = reader.head();
    if (element.type !== TARS_TYPE.STRUCT_BEGIN) {
      reader.skip(element.type);
      continue;
    }
    const item = { uri: -1, message: null };
    while (!reader.done) {
      const field = reader.head();
      if (field.type === TARS_TYPE.STRUCT_END) break;
      if (field.tag === 0) item.uri = reader.int(field.type);
      else if (field.tag === 1) item.message = reader.bytes(field.type);
      else reader.skip(field.type);
    }
    items.push(item);
  }
  return items;
}

async function resolveRoom(roomId) {
  const raw = await getJSON(
    `https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=${encodeURIComponent(roomId)}&showSecret=1`,
    { headers: { Referer: 'https://www.huya.com/', Origin: 'https://www.huya.com' } },
  );
  if (raw.status !== 200 || !raw.data) throw new Error(`房间信息获取失败（${raw.message || raw.status}）`);
  const data = raw.data;
  const stream = data.stream?.baseSteamInfoList?.[0];
  if (!stream) throw new Error('房间未开播，暂时没有弹幕');

  // 当前 wsapi 按主播 uid 订阅；profileInfo.uid 是页面协议使用的权威字段。
  const presenterUid = String(
    data.profileInfo?.uid || data.liveData?.yyid || stream.lPresenterUid || stream.lChannelId || '',
  );
  if (!presenterUid || presenterUid === '0') throw new Error('虎牙房间缺少主播 UID，无法订阅弹幕');
  return presenterUid;
}

function buildBaseInfo() {
  const guid = crypto.randomBytes(16).toString('hex');
  const writer = new TarsWriter()
    .int(0, 0)
    .string(guid, 1)
    .string(HUYA_UA, 2)
    .string('HUYA&ZH&2052', 3)
    .string('', 4)
    .string('', 5)
    .int(0, 6)
    .string('', 7)
    .string('', 8)
    .string('', 9);
  return encodeURIComponent(writer.toBuffer().toString('base64'));
}

function buildSubscribe(presenterUid) {
  const payload = new TarsWriter()
    .stringList([`live:${presenterUid}`, `chat:${presenterUid}`], 0)
    .string('', 1);
  return new TarsWriter()
    .int(CMD.SUBSCRIBE, 0)
    .bytes(payload.toBuffer(), 1)
    .toBuffer();
}

function parseChat(buffer) {
  const chat = { user: '', content: '' };
  parseStruct(new TarsReader(buffer), {
    0: (reader, type) => {
      if (type === TARS_TYPE.STRUCT_BEGIN) {
        parseStruct(reader, {
          2: (r, fieldType) => { chat.user = r.string(fieldType); },
        });
      } else reader.skip(type);
    },
    3: (reader, type) => { chat.content = reader.string(type); },
  });
  return chat;
}

function parseSinglePush(buffer) {
  const push = { uri: -1, message: null };
  parseStruct(new TarsReader(buffer), {
    1: (reader, type) => { push.uri = reader.int(type); },
    2: (reader, type) => { push.message = reader.bytes(type); },
  });
  return push;
}

function parseGroupPush(buffer) {
  const result = { items: [] };
  parseStruct(new TarsReader(buffer), {
    1: (reader, type) => { result.items = readPushList(reader, type); },
  });
  return result;
}

export async function connect({ roomId, onMessage, onStatus, onClose }) {
  const presenterUid = await resolveRoom(roomId);
  const url = `${HOST}?baseinfo=${buildBaseInfo()}`;
  const ws = new WebSocket(url, {
    headers: { 'User-Agent': BROWSER_UA, Origin: 'https://www.huya.com' },
    handshakeTimeout: 10_000,
    // 虎牙 wsapi 会接受 permessage-deflate，但社区实测启用后会停止推送。
    perMessageDeflate: false,
  });

  let closed = false;
  let subscribed = false;
  let subscribeTimer = null;

  const shutdown = (err) => {
    if (closed) return;
    closed = true;
    clearTimeout(subscribeTimer);
    try { ws.terminate(); } catch { /* ignore */ }
    onClose?.(err);
  };

  ws.on('open', () => {
    ws.send(buildSubscribe(presenterUid));
    onStatus?.('connecting', '已连接虎牙弹幕服务，正在订阅房间');
    subscribeTimer = setTimeout(() => shutdown(new Error('等待虎牙房间订阅确认超时')), 12_000);
  });

  ws.on('message', (raw) => {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (process.env.HUYA_DEBUG) console.log('[huya] wsapi raw', buffer.length, buffer.toString('hex').slice(0, 160));
    try {
      const frame = { command: -1, payload: null };
      parseStruct(new TarsReader(buffer), {
        0: (reader, type) => { frame.command = reader.int(type); },
        1: (reader, type) => { frame.payload = reader.bytes(type); },
      });

      if (frame.command === CMD.SUBSCRIBE_RESULT && frame.payload) {
        let resultCode = -1;
        let groups = [];
        parseStruct(new TarsReader(frame.payload), {
          0: (reader, type) => { resultCode = reader.int(type); },
          1: (reader, type) => { groups = readStringList(reader, type); },
        });
        if (resultCode !== 0) {
          const err = new Error(`虎牙房间订阅失败（错误码 ${resultCode}）`);
          err.fatal = true;
          shutdown(err);
          return;
        }
        if (groups.length && !groups.includes(`chat:${presenterUid}`)) {
          const err = new Error('虎牙未确认聊天弹幕订阅');
          err.fatal = true;
          shutdown(err);
          return;
        }
        subscribed = true;
        clearTimeout(subscribeTimer);
        onStatus?.('connected', '虎牙弹幕已连接');
        return;
      }

      if (frame.command === CMD.PUSH && frame.payload) {
        const push = parseSinglePush(frame.payload);
        if (push.uri === URI_CHAT && push.message) emitChat(push.message);
      } else if (frame.command === CMD.GROUP_PUSH && frame.payload) {
        for (const push of parseGroupPush(frame.payload).items) {
          if (push.uri === URI_CHAT && push.message) emitChat(push.message);
        }
      }
    } catch (err) {
      if (process.env.HUYA_DEBUG) console.warn('[huya] wsapi parse error:', err.message);
    }
  });

  function emitChat(payload) {
    if (!subscribed) return;
    const chat = parseChat(payload);
    if (chat.content) {
      onMessage({ user: chat.user || '匿名', content: chat.content, timestamp: Date.now() });
    }
  }

  ws.on('close', () => shutdown(null));
  ws.on('error', (err) => shutdown(err));

  return { close: () => shutdown(null) };
}
