// 平台账号：登录 Cookie 由桌面端登录窗口同步进来，取流与弹幕共用同一份。
// 浏览器模式下没有 Electron session，可以走 POST /api/accounts/:platform 手动写入。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 打包成 App 后 .app 内部是只读的，数据目录由主进程指到 userData
const DATA_DIR = process.env.LIVEHUB_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'accounts.json');

export const ACCOUNT_PLATFORMS = ['bilibili', 'huya', 'douyu', 'douyin'];

/** cookie 落域：写顶级域即可覆盖该平台所有子域 */
const DOMAIN = {
  bilibili: 'bilibili.com',
  huya: 'huya.com',
  douyu: 'douyu.com',
  douyin: 'douyin.com',
};

/** 出现任意一个即视为已登录 */
const AUTH_COOKIE = {
  bilibili: ['SESSDATA'],
  huya: ['yyuid', 'udb_uid'],
  douyu: ['acf_uid', 'acf_auth'],
  douyin: ['sessionid', 'sessionid_ss'],
};

let cache = {};
let cacheAt = 0;
let cacheMtime = -1;
let writeChain = Promise.resolve();

/** 把 "a=1; b=2" 解析成 Map */
export function parseCookie(cookie) {
  const map = new Map();
  for (const part of String(cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) map.set(name, value);
  }
  return map;
}

/** 归一化：去重、去空白，保证同名 cookie 后写的生效 */
function normalizeCookie(cookie) {
  const map = parseCookie(cookie);
  return [...map].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * 读磁盘。文件很小，用同步读 + mtime 比对即可；
 * 1 秒内复用内存，避免每次解析都 stat。
 */
function load() {
  const now = Date.now();
  if (now - cacheAt < 1000) return cache;
  cacheAt = now;
  try {
    const stat = fs.statSync(FILE);
    if (stat.mtimeMs !== cacheMtime) {
      cacheMtime = stat.mtimeMs;
      cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    }
  } catch {
    cache = {};
    cacheMtime = -1;
  }
  return cache;
}

function persist(data) {
  cache = data;
  cacheAt = Date.now();
  writeChain = writeChain
    .then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await fsp.writeFile(FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      cacheMtime = (await fsp.stat(FILE)).mtimeMs;
      cacheAt = Date.now();
    })
    .catch((err) => console.error('[accounts] 写入失败:', err.message));
  return writeChain;
}

/** 脱敏：只给外部看「有没有登录」，不回传完整 cookie */
function publicAccount(platform, record) {
  if (!record?.cookie) {
    return { platform, loggedIn: false, nickname: '', updatedAt: 0, cookiePreview: '' };
  }
  const map = parseCookie(record.cookie);
  const auth = (AUTH_COOKIE[platform] || []).find((name) => map.get(name));
  return {
    platform,
    loggedIn: Boolean(auth),
    nickname: record.nickname || '',
    updatedAt: record.updatedAt || 0,
    cookieCount: map.size,
    // 只暴露关键 cookie 的存在与否，方便前端解释「为什么还算未登录」
    hasAuthCookie: Boolean(auth),
  };
}

export function listAccounts() {
  const all = load();
  return ACCOUNT_PLATFORMS.map((platform) => publicAccount(platform, all[platform]));
}

export function getAccount(platform) {
  const record = load()[platform];
  return record?.cookie ? record : null;
}

export function getCookie(platform) {
  return getAccount(platform)?.cookie || '';
}

/** 取单个 cookie 值，弹幕登录参数要用 */
export function cookieValue(platform, name) {
  return parseCookie(getCookie(platform)).get(name) || '';
}

export function isLoggedIn(platform) {
  return publicAccount(platform, getAccount(platform)).loggedIn;
}

export async function saveAccount(platform, cookie, extra = {}) {
  const normalized = normalizeCookie(cookie);
  if (!normalized) throw new Error('cookie 为空');
  const all = { ...load() };
  all[platform] = {
    cookie: normalized,
    nickname: extra.nickname || all[platform]?.nickname || '',
    updatedAt: Date.now(),
  };
  await persist(all);
  return publicAccount(platform, all[platform]);
}

export async function setNickname(platform, nickname) {
  const all = { ...load() };
  if (!all[platform]?.cookie) return null;
  all[platform] = { ...all[platform], nickname: String(nickname || '').slice(0, 40) };
  await persist(all);
  return publicAccount(platform, all[platform]);
}

export async function removeAccount(platform) {
  const all = { ...load() };
  delete all[platform];
  await persist(all);
  return publicAccount(platform, null);
}

/**
 * 把登录 cookie 灌进解析器自己的 jar。
 * 每次解析前调用，用户中途登录也能立刻生效。
 */
export function applyAccount(platform, jar) {
  const cookie = getCookie(platform);
  if (!cookie) return false;
  jar.loadCookieString(DOMAIN[platform], cookie);
  return true;
}

/** 平台首页地址，桌面端登录窗口和 curl 兜底都用得上 */
export const LOGIN_URL = {
  bilibili: 'https://passport.bilibili.com/login',
  huya: 'https://www.huya.com/',
  douyu: 'https://www.douyu.com/',
  douyin: 'https://www.douyin.com/',
};

/**
 * 用 cookie 反查昵称，同时充当「这份 cookie 到底还有没有效」的验证。
 * 只有 B 站有免签的 nav 接口，其余平台先按 cookie 关键字段判断。
 */
export async function probeNickname(platform, cookie) {
  if (platform !== 'bilibili') return '';
  const { CookieJar, getJSON } = await import('./lib/http.js');
  const jar = new CookieJar();
  jar.loadCookieString(DOMAIN.bilibili, cookie);
  const nav = await getJSON('https://api.bilibili.com/x/web-interface/nav', {
    jar,
    headers: { Referer: 'https://www.bilibili.com/' },
  });
  if (nav.code !== 0) throw new Error(nav.message || `B 站返回 ${nav.code}`);
  if (!nav.data?.isLogin) throw new Error('这份 Cookie 里没有有效的 B 站登录信息');
  return nav.data.uname || '';
}
