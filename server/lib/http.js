// 轻量 HTTP 客户端：带 cookie 保持的 fetch 封装，供各平台解析器共用。
const UA_WEB =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** 极简 cookie jar。同一平台多次请求之间共享登录/设备指纹。 */
export class CookieJar {
  constructor() {
    this.map = new Map();
  }

  store(url, res) {
    const host = new URL(url).hostname;
    const list = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const raw of list) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name || value === '""') continue;
      this.map.set(`${host}|${name}`, value);
    }
  }

  /** 手动写入指定域下的 cookie（域写顶级域名即可对子域生效） */
  set(domain, name, value) {
    this.map.set(`${domain}|${name}`, value);
  }

  get(domain, name) {
    return this.map.get(`${domain}|${name}`);
  }

  /**
   * 批量载入形如 "a=1; b=2" 的 cookie 串。
   * 用于注入用户在桌面端登录后拿到的登录态。
   */
  loadCookieString(domain, cookie) {
    for (const part of String(cookie || '').split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (name && value) this.map.set(`${domain}|${name}`, value);
    }
  }

  /** 导出指定域下的 cookie 串 */
  dump(domain) {
    const parts = [];
    for (const [key, value] of this.map) {
      const [host, name] = key.split('|');
      if (host === domain) parts.push(`${name}=${value}`);
    }
    return parts.join('; ');
  }

  header(url) {
    const host = new URL(url).hostname;
    const parts = [];
    for (const [key, value] of this.map) {
      const [h, name] = key.split('|');
      if (host === h || host.endsWith(`.${h}`)) {
        parts.push(`${name}=${value}`);
      }
    }
    return parts.join('; ');
  }
}

/**
 * 发起请求并自动带上该平台 cookie。
 * @param {string} url
 * @param {{ jar?: CookieJar, headers?: Record<string,string>, method?: string, body?: any, redirect?: RequestRedirect, timeout?: number }} opts
 */
export async function request(url, opts = {}) {
  const { jar, headers = {}, method = 'GET', body, redirect = 'follow', timeout = 15000 } = opts;
  const h = {
    'User-Agent': UA_WEB,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...headers,
  };
  if (jar) {
    const cookie = jar.header(url);
    if (cookie) h.Cookie = cookie;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, { method, headers: h, body, redirect, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (jar) jar.store(url, res);
  return res;
}

export async function getJSON(url, opts = {}) {
  const res = await request(url, opts);
  let text;
  try {
    text = await res.text();
  } catch (err) {
    // 上游连接中途断开（undici 的 terminated）在这里收口，别让它冒成未捕获异常
    throw new HttpError(`读取响应失败：${err.message}`, res.status, '');
  }
  if (!res.ok) {
    throw new HttpError(`HTTP ${res.status} ${res.statusText}`, res.status, text.slice(0, 300));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError('返回内容不是 JSON', res.status, text.slice(0, 300));
  }
}

export async function getText(url, opts = {}) {
  const res = await request(url, opts);
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw new HttpError(`读取响应失败：${err.message}`, res.status, '');
  }
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status, text.slice(0, 300));
  return text;
}

export class HttpError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export const UAS = { web: UA_WEB, mobile: UA_MOBILE };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
