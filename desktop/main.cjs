// LiveHub 桌面端主进程：内嵌启动本地服务，主窗口加载同一个 Web UI。
// 账号登录走独立的平台登录窗口（persist 分区），登录成功后把 cookie 同步给本地服务，
// 之后自研播放器取流、弹幕连接都用这份登录态。
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const shadow = require('./shadow.cjs');

/** 数据目录：打包后指到 userData，开发时是仓库里的 data/ */
let dataDir = null;
const sender = require('./sender.cjs');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PLATFORMS = ['bilibili', 'huya', 'douyu', 'douyin'];

const PLATFORM_META = {
  bilibili: {
    name: '哔哩哔哩',
    loginUrl: 'https://passport.bilibili.com/login',
    domain: 'bilibili.com',
    authCookies: ['SESSDATA'],
  },
  huya: {
    name: '虎牙',
    loginUrl: 'https://www.huya.com/',
    domain: 'huya.com',
    authCookies: ['yyuid', 'udb_uid'],
  },
  douyu: {
    name: '斗鱼',
    loginUrl: 'https://www.douyu.com/',
    domain: 'douyu.com',
    authCookies: ['acf_uid', 'acf_auth'],
  },
  douyin: {
    name: '抖音',
    loginUrl: 'https://www.douyin.com/',
    domain: 'douyin.com',
    authCookies: ['sessionid', 'sessionid_ss'],
  },
};

let mainWindow = null;
let httpServer = null;
let serverPort = null;
const loginWindows = new Map();

/** 把 Express 起在随机端口上，避免和用户自己 npm start 的实例打架 */
async function bootServer() {
  const entry = pathToFileURL(path.join(__dirname, '..', 'server', 'index.js')).href;
  const mod = await import(entry);
  const started = await mod.startServer({ port: 0 });
  httpServer = started.server;
  return started.port;
}

/** cookie 是否属于该平台的域名 */
function cookieBelongs(platform, cookie) {
  const host = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  const base = PLATFORM_META[platform].domain;
  return host === base || host.endsWith(`.${base}`);
}

/** 导出该平台分区下的整份 cookie，形如 "a=1; b=2" */
async function exportCookie(platform) {
  const ses = session.fromPartition(`persist:${platform}`);
  const cookies = await ses.cookies.get({});
  return cookies
    .filter((cookie) => cookie.value && cookieBelongs(platform, cookie))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function hasAuthCookie(platform) {
  const ses = session.fromPartition(`persist:${platform}`);
  const cookies = await ses.cookies.get({});
  const names = PLATFORM_META[platform].authCookies;
  return cookies.some(
    (cookie) => names.includes(cookie.name) && cookie.value && cookieBelongs(platform, cookie),
  );
}

async function serverAccounts() {
  if (!serverPort) return [];
  const res = await fetch(`http://127.0.0.1:${serverPort}/api/accounts`);
  return res.json();
}

/**
 * 把分区里的 cookie 推给本地服务。
 * 没登录时只用来补设备指纹（ttwid / buvid3 这类），不能覆盖服务端已有的登录态——
 * 否则用户在浏览器模式手动粘的 Cookie 会被桌面端的匿名 cookie 冲掉。
 */
async function syncAccount(platform) {
  if (!serverPort) return null;
  const cookie = await exportCookie(platform);
  if (!cookie) return null;

  if (!(await hasAuthCookie(platform))) {
    const existing = await serverAccounts().catch(() => []);
    if (existing.find((item) => item.platform === platform)?.cookieCount) return null;
  }

  const res = await fetch(`http://127.0.0.1:${serverPort}/api/accounts/${platform}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `同步失败（${res.status}）`);
  mainWindow?.webContents.send('livehub:accounts-changed');
  return data;
}

async function syncAllAccounts() {
  for (const platform of PLATFORMS) {
    try {
      await syncAccount(platform);
    } catch (err) {
      console.error(`[accounts] ${platform} 同步失败:`, err.message);
    }
  }
}

/** 打开平台官方登录页；检测到登录 cookie 后自动同步并关窗 */
function openLogin(platform) {
  const meta = PLATFORM_META[platform];
  if (!meta) return { ok: false, error: '未知平台' };

  const existing = loginWindows.get(platform);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return { ok: true, reused: true };
  }

  const win = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 420,
    minHeight: 560,
    title: `登录 ${meta.name}`,
    parent: mainWindow || undefined,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      partition: `persist:${platform}`,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  loginWindows.set(platform, win);
  win.once('ready-to-show', () => win.show());

  // 平台的登录页偶尔会 window.open 出扫码窗，允许在同一个窗口里打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    win.loadURL(url);
    return { action: 'deny' };
  });

  const timer = setInterval(async () => {
    if (win.isDestroyed()) return;
    try {
      if (await hasAuthCookie(platform)) {
        clearInterval(timer);
        await syncAccount(platform).catch((err) =>
          console.error(`[accounts] ${platform} 同步失败:`, err.message),
        );
        setTimeout(() => {
          if (!win.isDestroyed()) win.close();
        }, 600);
      }
    } catch {
      /* 页面还没加载完时忽略 */
    }
  }, 1200);

  win.on('closed', async () => {
    clearInterval(timer);
    loginWindows.delete(platform);
    // 用户手动关窗也再同步一次，避免「登录了但没检测到」的情况
    try {
      await syncAccount(platform);
    } catch {
      /* 没登录就静默跳过 */
    }
    mainWindow?.webContents.send('livehub:accounts-changed');
  });

  win.loadURL(meta.loginUrl);
  return { ok: true };
}

/** 退出登录：清空该平台分区的 cookie，并删掉服务端账号 */
async function logout(platform) {
  const meta = PLATFORM_META[platform];
  if (!meta) return { ok: false, error: '未知平台' };
  const ses = session.fromPartition(`persist:${platform}`);
  await ses.clearStorageData({ storages: ['cookies', 'localstorage'] });
  if (serverPort) {
    await fetch(`http://127.0.0.1:${serverPort}/api/accounts/${platform}`, { method: 'DELETE' });
  }
  mainWindow?.webContents.send('livehub:accounts-changed');
  return { ok: true };
}

function registerIpc() {
  ipcMain.handle('livehub:login', (_event, platform) => openLogin(String(platform)));
  ipcMain.handle('livehub:logout', (_event, platform) => logout(String(platform)));
  ipcMain.handle('livehub:sync-account', (_event, platform) => syncAccount(String(platform)));
  shadow.registerShadowIpc();
  sender.registerSenderIpc();
}

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#101216',
    title: 'LiveHub',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 站外链接交给系统浏览器，不在应用里乱开窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 打包后 .app 内部是只读的（且在 /Applications 下），
 * 所以把数据目录指到 userData：关注列表和账号 cookie 都写这里，升级重装不会丢。
 * 必须在 import server 之前设好——服务端模块在加载时就会读这个环境变量。
 */
function prepareDataDir() {
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  process.env.LIVEHUB_DATA_DIR = dir;
  dataDir = dir;

  // 首次启动：把打包时带上的关注列表铺进去（只含房间，不含任何账号 cookie）
  const rooms = path.join(dir, 'rooms.json');
  const seed = path.join(__dirname, '..', 'seed', 'rooms.json');
  if (!fs.existsSync(rooms) && fs.existsSync(seed)) {
    try {
      fs.copyFileSync(seed, rooms);
    } catch (err) {
      console.error('[seed] 关注列表初始化失败:', err.message);
    }
  }
  return dir;
}

app.whenReady().then(async () => {
  prepareDataDir();

  // 平台原页 / 登录窗口的登录态按 partition 落地，第二次进来还是已登录
  for (const platform of PLATFORMS) {
    const ses = session.fromPartition(`persist:${platform}`);
    ses.setUserAgent(UA);
  }

  try {
    serverPort = await bootServer();
    shadow.setServerPort(serverPort);
    sender.setServerPort(serverPort);
    // 发送窗口首次打开时用服务端保存的 cookie 补齐分区：
    // 用户若是「浏览器模式粘贴 cookie」登录的，persist 分区里其实没有登录态
    sender.setCookieSource((platform) => {
      try {
        const file = path.join(dataDir || path.join(__dirname, '..', 'data'), 'accounts.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data?.[platform]?.cookie || '';
      } catch {
        return '';
      }
    });
    registerIpc();
    await createWindow(serverPort);
    // 上次登录留下的 cookie 再推一次，保证服务端和 session 一致
    syncAllAccounts().catch(() => {});
  } catch (err) {
    console.error('启动失败:', err);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort) createWindow(serverPort);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  shadow.closeAllShadows();
  sender.closeAllSenders();
  httpServer?.close();
  httpServer = null;
});
