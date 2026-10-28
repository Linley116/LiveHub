// 抖音弹幕：不在服务端建连，改由桌面端「影子窗口」把页面自己拿到的 im/fetch 响应回灌进来。
//
// 原因：抖音的弹幕长轮询要 a_bogus 签名，签名是页面 JS 用 msToken + 一堆环境参数现算的，
// 与登录态无关。与其移植（易碎），不如让页面自己算，我们从旁把响应体复制一份。
// 纯浏览器模式没有影子窗口，因此当前不能通过这条链路采集抖音弹幕。
export const meta = {
  id: 'douyin',
  name: '抖音',
  note: '由桌面端影子窗口抓取页面 im/fetch 响应；发送同样由桌面端在页面里代发（要 a_bogus 签名）。',
  send: 'desktop',
};

/** 抖音输入框上限 30 字 */
export const DANMAKU_MAX_LENGTH = 30;

/** roomId(web_rid) -> 接收器 */
const receivers = new Map();

/* ---------------- 极简 protobuf 读取 ---------------- */

/** 读 varint；数据不完整时返回 null（跨 chunk 的字段要留到下次） */
function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let cursor = pos;
  while (cursor < buf.length) {
    const byte = buf[cursor++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, cursor];
    shift += 7;
    if (shift > 56) return null;
  }
  return null;
}

/**
 * 顺序读取一段 protobuf，返回已完整解析的字段和消费到的位置。
 * 遇到不完整的字段就停下——剩下的字节留到下一个 chunk。
 */
function walk(buf) {
  const entries = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    const key = readVarint(buf, pos);
    if (!key) return { entries, consumed: start };
    const field = key[0] >> 3;
    const wire = key[0] & 7;
    pos = key[1];

    if (wire === 0) {
      const value = readVarint(buf, pos);
      if (!value) return { entries, consumed: start };
      entries.push({ field, wire, value: value[0] });
      pos = value[1];
    } else if (wire === 1) {
      if (pos + 8 > buf.length) return { entries, consumed: start };
      pos += 8;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      if (!len) return { entries, consumed: start };
      const end = len[1] + len[0];
      if (end > buf.length) return { entries, consumed: start };
      entries.push({ field, wire, value: buf.subarray(len[1], end) });
      pos = end;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) return { entries, consumed: start };
      pos += 4;
    } else {
      // 不认识的 wire type，这段数据没法继续解，直接跳过
      return { entries, consumed: pos };
    }
  }
  return { entries, consumed: pos };
}

const asText = (value) => (Buffer.isBuffer(value) ? value.toString('utf8') : '');

/** 一条 Response 里的消息列表：field 1 = { 1: method, 2: payload } */
function extractChats(entries) {
  const chats = [];
  for (const entry of entries) {
    if (entry.field !== 1 || entry.wire !== 2) continue;
    let method = '';
    let payload = null;
    for (const item of walk(entry.value).entries) {
      if (item.field === 1 && item.wire === 2) method = asText(item.value);
      else if (item.field === 2 && item.wire === 2) payload = item.value;
    }
    if (method !== 'WebcastChatMessage' || !payload) continue;

    let content = '';
    let user = '';
    for (const item of walk(payload).entries) {
      if (item.field === 3 && item.wire === 2) content = asText(item.value);
      else if (item.field === 2 && item.wire === 2) {
        // User: field 3 = 昵称
        for (const field of walk(item.value).entries) {
          if (field.field === 3 && field.wire === 2) user = asText(field.value);
        }
      }
    }
    if (content) chats.push({ user: user || '匿名', content });
  }
  return chats;
}

/* ---------------- 接收器 ---------------- */

export async function connect({ roomId, onMessage, onStatus }) {
  const key = String(roomId);
  const receiver = {
    roomId: key,
    onMessage,
    onStatus,
    gotData: false,
    buffer: Buffer.alloc(0),
  };
  receivers.set(key, receiver);
  onStatus?.('connecting', '正在等待桌面端影子窗口接入抖音弹幕…');

  const timer = setTimeout(() => {
    if (receiver.gotData || receivers.get(key) !== receiver) return;
    onStatus?.(
      'error',
      '抖音弹幕读取需要桌面端，请在 LiveHub 中使用 Electron 桌面版',
    );
  }, 10_000);

  return {
    close() {
      clearTimeout(timer);
      if (receivers.get(key) === receiver) receivers.delete(key);
    },
  };
}

/**
 * 主进程转来的响应体分片（Buffer）。可能跨 chunk 截断，所以按接收器攒着慢慢解。
 * 返回本次新解出的条数，方便调用方打日志。
 */
export function ingest(roomId, chunk) {
  const receiver = receivers.get(String(roomId));
  if (!receiver || !chunk || !chunk.length) return 0;

  receiver.buffer = Buffer.concat([receiver.buffer, chunk]);
  // 单房间最多留 2MB，防止异常数据撑爆内存
  if (receiver.buffer.length > 2 * 1024 * 1024) {
    receiver.buffer = receiver.buffer.subarray(receiver.buffer.length - 1024 * 1024);
  }

  const { entries, consumed } = walk(receiver.buffer);
  if (consumed > 0) receiver.buffer = receiver.buffer.subarray(consumed);

  const chats = extractChats(entries);
  if (chats.length) {
    if (!receiver.gotData) {
      receiver.gotData = true;
      receiver.onStatus?.('connected', '弹幕已连接');
    }
    for (const chat of chats) {
      receiver.onMessage?.({ ...chat, timestamp: Date.now() });
    }
  }
  return chats.length;
}
