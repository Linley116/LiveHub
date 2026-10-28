// 抖音弹幕影子窗口。
//
// 背景：抖音弹幕长轮询要 a_bogus 签名，签名是页面 JS 用 msToken + 一堆环境参数现算的，
// 跟登录态无关。与其把这套签名移植到服务端（易碎，改一次崩一次），
// 不如开一个隐藏窗口加载官方直播间页，让页面自己算、自己收，我们从旁把响应体复制一份。
//
// 我们只做三件事：加载页面 → 收 preload 抄送的响应体分片 → 攒一攒回灌给本地服务解码。
const path = require('node:path');
const { ipcMain, BrowserWindow } = require('electron');

/** roomId -> { win, roomId, queue, timer } */
const shadowWindows = new Map();

/** 攒够 150ms 再发：一个 progress 事件可能只有几十字节，逐个打 HTTP 太浪费 */
const FLUSH_MS = 150;
/** 单次最多回灌 48 个分片，防止页面瞬间灌爆请求体 */
const MAX_FRAMES = 48;

let serverPort = null;

/** 本地服务端口由主进程注入，服务没起来时不接受任何影子窗口 */
function setServerPort(port) {
  serverPort = port || null;
}

function getShadows() {
  return shadowWindows;
}

function openShadow(roomId) {
  const key = String(roomId || '');
  if (!key) return { ok: false, error: '缺少房间号' };
  if (!serverPort) return { ok: false, error: '本地服务还没就绪' };

  const existing = shadowWindows.get(key);
  if (existing && !existing.win.isDestroyed()) return { ok: true, reused: true };

  const win = new BrowserWindow({
    show: false,
    width: 960,
    height: 620,
    webPreferences: {
      // 和登录窗口共用分区，页面能拿到登录态，弹幕里的用户名才是全的
      partition: 'persist:douyin',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 隐藏窗口默认会被节流，长轮询过一会儿就断了，必须显式关掉
      backgroundThrottling: false,
      preload: path.join(__dirname, 'shadow-preload.cjs'),
      additionalArguments: [`--livehub-room=${key}`],
    },
  });
  win.webContents.setAudioMuted(true);

  const entry = { win, roomId: key, queue: [], timer: null };
  shadowWindows.set(key, entry);

  win.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error(`[danmaku] 抖音影子窗口加载失败 ${code} ${desc}`);
  });
  win.on('closed', () => {
    clearTimeout(entry.timer);
    shadowWindows.delete(key);
  });

  win.loadURL(`https://live.douyin.com/${key}`).catch((err) => {
    console.error('[danmaku] 抖音影子窗口打开失败:', err.message);
  });
  return { ok: true };
}

function closeShadow(roomId) {
  const key = String(roomId || '');
  const entry = shadowWindows.get(key);
  if (!entry) return { ok: true };
  clearTimeout(entry.timer);
  entry.timer = null;
  if (!entry.win.isDestroyed()) entry.win.destroy();
  shadowWindows.delete(key);
  return { ok: true };
}

function closeAllShadows() {
  for (const entry of shadowWindows.values()) {
    clearTimeout(entry.timer);
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }
  shadowWindows.clear();
}

/** preload 抄送来的一个分片（base64） */
function queueChunk(roomId, b64) {
  const entry = shadowWindows.get(String(roomId));
  if (!entry || !serverPort || !b64) return;
  entry.queue.push(b64);
  // 万一页面一次推太多，丢最早的，别让内存堆起来
  if (entry.queue.length > MAX_FRAMES * 4) {
    entry.queue.splice(0, entry.queue.length - MAX_FRAMES * 4);
  }
  if (entry.timer) return;
  entry.timer = setTimeout(() => flushChunks(entry), FLUSH_MS);
}

async function flushChunks(entry) {
  entry.timer = null;
  const frames = entry.queue.splice(0, MAX_FRAMES);
  if (!frames.length) return;
  // 还有剩余就接着排下一次，避免单帧过大把队列饿死
  if (entry.queue.length) entry.timer = setTimeout(() => flushChunks(entry), FLUSH_MS);
  if (!serverPort) return;
  try {
    await fetch(`http://127.0.0.1:${serverPort}/api/danmaku/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'douyin', room: entry.roomId, frames }),
    });
  } catch {
    /* 服务重启的瞬间会失败，下一批自然就恢复了 */
  }
}

function registerShadowIpc() {
  ipcMain.handle('livehub:danmaku-open', (_event, roomId) => openShadow(roomId));
  ipcMain.handle('livehub:danmaku-close', (_event, roomId) => closeShadow(roomId));
  ipcMain.on('livehub:danmaku-chunk', (_event, payload) => {
    if (!payload || !payload.roomId || !payload.b64) return;
    queueChunk(payload.roomId, payload.b64);
  });
}

module.exports = {
  setServerPort,
  getShadows,
  openShadow,
  closeShadow,
  closeAllShadows,
  queueChunk,
  registerShadowIpc,
};
