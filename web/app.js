/* LiveHub: 本地主播目录、应用内单房间播放器与弹幕面板。 */
const $ = (selector, root = document) => root.querySelector(selector);

const PLATFORM = {
  bilibili: { name: '哔哩哔哩', short: 'B站', color: '#fb7299' },
  huya: { name: '虎牙', short: '虎牙', color: '#ff9a22' },
  douyu: { name: '斗鱼', short: '斗鱼', color: '#ff7d32' },
  douyin: { name: '抖音', short: '抖音', color: '#25d8d2' },
};

const IS_DESKTOP = !!window.livehub?.isDesktop;

const state = {
  rooms: [],
  selectedCreator: 'all',
  platform: 'all',
  query: '',
  sort: 'live',
  adding: false,
  currentRoom: null,
  refreshing: false,
  lastRefreshAt: 0,
  accounts: [],
  theme: 'follow',   // follow | light | dark
  rail: false,       // 侧栏折叠成 80px 头像轨
  favCollapsed: false, // 特别关注区是否收起
  resizing: false,   // 侧栏折叠动画进行中
};

const player = {
  hls: null,
  flv: null,
  streams: [],
  requestId: 0,
  overlay: false,
  qualities: [],
  quality: '',
  qualityMode: 'remote',
  platform: '',
  line: 0,
  watchdog: null,
  // 用户手动调过声音后就不再被「重连即静音」覆盖（否则重连一次音量选择就丢了）
  soundUserSet: false,
  // 正在恢复观看偏好的过程中，别把「恢复动作」当成用户改动再写回偏好
  applyingPrefs: false,
  // 悬浮弹幕要等弹幕通道就绪才能开，先记着（undefined = 这次不用恢复）
  pendingOverlay: undefined,
  // 看门狗用来判断播放位置是否倒退
  lastTime: null,
  // 连续拿到「短分片」的次数，连续多次就退回官方页
  shortStreams: 0,
  // 连续超阈值的次数，攒够几次才追帧
  lagHits: 0,
  // 近期「等数据」的时间戳，用于判断是否该自动降档
  starveMarks: [],
  degrading: false,
  // 拆流/重连期间忽略错误事件，否则会形成重连死循环
  clearing: false,
  reconnecting: false,
  // 用来区分「分片流结束」和「HLS 时长正常增长」
  lastDuration: -1,
  durationStableAt: 0,
};

const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

const platform = (id) => PLATFORM[id] || { name: id || '未知平台', short: id || '直播', color: '#8b90a0' };
const fmtNum = (value) => {
  const number = Number(value) || 0;
  if (number >= 1e8) return `${(number / 1e8).toFixed(1)}亿`;
  if (number >= 1e4) return `${(number / 1e4).toFixed(1)}万`;
  return String(number);
};
/**
 * 直播间标题。
 * 虎牙这类平台在主播没设置标题时，返回的 roomName 是空串（页面上的 host-name 也是空的），
 * 并不是我们解析失败。这时退回主播名，别显示「虎牙 房间 123456」这种占位符。
 */
const roomName = (room) =>
  room.customTitle || room.title || room.anchor || `${platform(room.platform).short} 房间 ${room.roomId}`;
const creatorName = (room) => room.anchor || room.importedName || room.customTitle || `${platform(room.platform).short} ${room.roomId}`;
const creatorKey = (room) => room.anchor
  ? `name:${room.anchor.trim().toLocaleLowerCase()}`
  : `room:${room.platform}:${room.roomId}`;

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const error = new Error(data.error || `请求失败 (${response.status})`);
    // 带上错误码，前端要据此区分「发言受限」和其他失败
    if (data.code) error.code = data.code;
    throw error;
  }
  return data;
}

/* ---------------- 开播状态刷新 ---------------- */

const REFRESH_INTERVAL_MS = 180_000;

// 只有「会影响卡片显示」的字段变了才重渲染，避免每次轮询都闪一下
const roomsSignature = (rooms) =>
  rooms
    .map((room) => `${room.key}:${room.live ? 1 : 0}:${Number(room.online) || 0}:${room.title || ''}`)
    .join('|');

function relativeTime(timestamp) {
  if (!timestamp) return '尚未检查';
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return '刚刚更新';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前更新`;
  return `${Math.floor(diff / 3_600_000)} 小时前更新`;
}

function renderHeaderNote() {
  const note = $('#headerNoteText');
  if (!note) return;
  const latest = Math.max(0, ...state.rooms.map((room) => room.lastChecked || 0));
  const checkedAt = state.lastRefreshAt || latest;
  // 正在直播的数量已在副标题里，右侧只留更新时间，别把同一个数字说两遍
  note.textContent = state.rooms.length ? relativeTime(checkedAt) : '还没有导入房间';
  // 更新时间并入刷新按钮后，"过期"状态挂在按钮上（数字变琥珀色）
  $('#refreshRooms')?.classList.toggle(
    'is-stale',
    state.rooms.length > 0 && Date.now() - checkedAt > 15 * 60_000,
  );
}

function updateRefreshUi() {
  const button = $('#refreshRooms');
  if (!button) return;
  button.disabled = state.refreshing || state.rooms.length === 0;
  button.classList.toggle('is-busy', state.refreshing);
  $('#refreshLabel').textContent = state.refreshing ? '刷新中' : '刷新';
  renderHeaderNote();
}

async function refreshRooms({ force = false, silent = true } = {}) {
  if (state.refreshing || !state.rooms.length) return;
  state.refreshing = true;
  updateRefreshUi();
  const before = roomsSignature(state.rooms);
  try {
    const result = await api('/api/rooms/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    state.rooms = result.rooms;
    state.lastRefreshAt = Date.now();
    if (roomsSignature(state.rooms) !== before) render();
    else renderHeaderNote();
    if (!silent) {
      toast(
        result.failed
          ? `已刷新 ${result.refreshed} 个房间，${result.failed} 个暂时取不到状态`
          : result.refreshed
            ? `已刷新 ${result.refreshed} 个房间`
            : '开播状态都是最新的',
      );
    }
  } catch (error) {
    if (!silent) toast(error.message);
  } finally {
    state.refreshing = false;
    updateRefreshUi();
  }
}

function getCreators() {
  const groups = new Map();
  for (const room of state.rooms) {
    const key = creatorKey(room);
    if (!groups.has(key)) {
      groups.set(key, { key, name: creatorName(room), rooms: [], live: false, pinned: false, avatar: '', platform: room.platform, online: 0 });
    }
    const group = groups.get(key);
    group.rooms.push(room);
    // 头像：优先用「正在直播」房间的头像（一般同一个人，但避免离线占位图），否则用第一个
    if (room.avatar && (!group.avatar || room.live)) group.avatar = room.avatar;
    if (room.live) {
      group.live = true;
      group.online = Math.max(group.online, Number(room.online) || 0);
    }
    // 同一主播只要有一个房间被标为特别关注，整组就置顶
    if (room.pinned) group.pinned = true;
  }
  // 开播的冒泡到前列，组内再按名称排
  const list = [...groups.values()];
  list.sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name, 'zh-CN'));
  return list;
}

function renderSidebar() {
  const creators = getCreators();
  $('#creatorCount').textContent = creators.length;
  $('#roomCount').textContent = state.rooms.length;

  const pinned = creators.filter((creator) => creator.pinned);
  const rest = creators.filter((creator) => !creator.pinned);
  const liveCreators = rest.filter((creator) => creator.live);
  const offlineCreators = rest.filter((creator) => !creator.live);

  // compact = 特别关注里的一行版：只留头像 + 名字，不占第二行
  const itemHTML = (creator, compact = false) => {
    const p = platform(creator.platform);
    const img = creator.avatar
      ? `<img class="creator-avatar-img" src="${escapeHTML(creator.avatar)}" alt="" loading="lazy" decoding="async" onerror="this.classList.add('is-broken')">`
      : '';
    const primaryRoom = creator.live ? (creator.rooms.find((room) => room.live) || creator.rooms[0]) : creator.rooms[0];
    const title = roomName(primaryRoom) || (creator.live ? '直播中' : '未开播');
    const dot = `<span class="nav-dot ${creator.live ? 'is-on' : 'is-off'}" title="${creator.live ? '直播中' : '未开播'}" aria-label="${creator.live ? '直播中' : '未开播'}"></span>`;
    const watchingThis = state.currentRoom && creatorKey(state.currentRoom) === creator.key;
    return `<button class="creator-nav ${compact ? 'is-pinned' : ''} ${watchingThis ? 'is-selected' : ''} ${creator.live ? 'is-live' : ''}" data-creator="${escapeHTML(creator.key)}" draggable="true">
      <span class="creator-avatar" style="--platform-color:${p.color}">
        ${img}
        <span class="creator-avatar-fallback" aria-hidden="true">${escapeHTML(creator.name.slice(0, 1))}</span>
      </span>
      <span class="nav-body">
        <span class="nav-name" title="${escapeHTML(creator.name)}">${escapeHTML(creator.name)}</span>
        ${compact ? '' : `<span class="nav-title${creator.live ? '' : ' is-off'}" title="${escapeHTML(title)}">${escapeHTML(title)}</span>`}
      </span>
      ${dot}
    </button>`;
  };

  // ---- 特别关注：独立区块，不参与下面列表的滚动 ----
  const block = $('#favBlock');
  const head = $('#favToggle');
  const items = $('#favItems');
  const empty = $('#favEmpty');
  const collapsed = state.favCollapsed && pinned.length > 0;

  block.classList.toggle('is-empty', pinned.length === 0);
  block.classList.toggle('is-collapsed', collapsed);
  if (head) {
    head.hidden = pinned.length === 0;
    head.setAttribute('aria-expanded', String(!collapsed));
  }
  if (empty) empty.hidden = pinned.length > 0;
  const count = $('#favCount');
  if (count) count.textContent = `${pinned.length} 位`;
  if (items) items.innerHTML = collapsed ? '' : pinned.map((creator) => itemHTML(creator, true)).join('');

  // ---- 我的主播：唯一的滚动容器 ----
  // 开播/未开播不再画横线：绿点/灰点已经表达了状态，多一条线只是噪音
  const parts = [];
  for (const creator of liveCreators) parts.push(itemHTML(creator));
  for (const creator of offlineCreators) parts.push(itemHTML(creator));
  const list = $('#streamerList');
  list.innerHTML = parts.join('');

  const sep = $('#favSep');
  if (sep) sep.hidden = collapsed || !(pinned.length && rest.length);

  bindCreatorEvents();
  syncFavOverflow();
}

/** 置顶区溢出时给底部渐隐（CSS 无法自己判断是否溢出） */
function syncFavOverflow() {
  requestAnimationFrame(() => {
    const items = $('#favItems');
    if (!items) return;
    items.classList.toggle('is-overflow', items.scrollHeight > items.clientHeight + 2);
  });
}

/** 侧栏条目事件（两处容器共用）：点击进房、右键移除、拖拽置顶 */
function bindCreatorEvents() {
  document.querySelectorAll('#favItems [data-creator], #streamerList [data-creator]').forEach((button) => {
    const key = button.dataset.creator;
    button.addEventListener('click', () => {
      const target = pickCreatorRoom(key);
      if (!target) return;
      if (state.currentRoom?.key === target.key) return;     // 就是当前这个，别重连
      location.hash = `#/room/${encodeURIComponent(target.key)}`;
    });
    // 折叠态：文字没了，靠气泡补名字和当前直播标题
    button.addEventListener('mouseenter', () => showRailTip(button));
    button.addEventListener('focus', () => showRailTip(button));
    button.addEventListener('mouseleave', hideRailTip);
    button.addEventListener('blur', hideRailTip);
    // 右键：复用卡片上的移除确认弹窗
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      removeCreator(key);
    });
    button.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', key);
      event.dataTransfer.effectAllowed = 'move';
      button.classList.add('is-dragging');
      hideRailTip();
    });
    button.addEventListener('dragend', () => button.classList.remove('is-dragging'));
  });
}

/**
 * 拖拽投放：拖进「特别关注」块 = 加入置顶，拖回下方列表 = 取消。
 * 只在启动时绑一次（容器是静态节点，内部内容每次渲染都会换）。
 */
function bindSidebarDnd() {
  const block = $('#favBlock');
  const list = $('#streamerList');
  if (!block || !list || block.dataset.bound === '1') return;
  block.dataset.bound = '1';

  const setOver = (on) => block.classList.toggle('is-over', on);

  block.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setOver(true);
  });
  block.addEventListener('dragleave', (event) => {
    if (!block.contains(event.relatedTarget)) setOver(false);
  });
  block.addEventListener('drop', (event) => {
    event.preventDefault();
    setOver(false);
    const key = event.dataTransfer?.getData('text/plain');
    if (key) setCreatorPinned(key, true);
  });

  // 列表任意位置都可放：拖回来 = 取消置顶
  list.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  list.addEventListener('drop', (event) => {
    event.preventDefault();
    const key = event.dataTransfer?.getData('text/plain');
    if (key) setCreatorPinned(key, false);
  });
}

/** 把某位主播的所有房间标为特别关注 / 取消 */
async function setCreatorPinned(key, pinned) {
  const rooms = state.rooms.filter((room) => creatorKey(room) === key);
  if (!rooms.length) return;
  if (rooms.every((room) => Boolean(room.pinned) === pinned)) return;
  const name = creatorName(rooms[0]);
  rooms.forEach((room) => { room.pinned = pinned; });
  renderSidebar();
  try {
    await Promise.all(rooms.map((room) =>
      api(`/api/rooms/${encodeURIComponent(room.key)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      })));
    toast(pinned ? `已把「${name}」加入特别关注` : `已取消「${name}」的特别关注`);
  } catch (error) {
    rooms.forEach((room) => { room.pinned = !pinned; });
    renderSidebar();
    toast(error.message);
  }
}

/** 侧栏右键删除：把这位主播的房间全部移除（复用卡片上的确认弹窗） */
async function removeCreator(key) {
  const rooms = state.rooms.filter((room) => creatorKey(room) === key);
  if (!rooms.length) return;
  const name = creatorName(rooms[0]);
  const more = rooms.length > 1 ? `（共 ${rooms.length} 个房间）` : '';
  if (!(await confirmDialog({
    title: '移除主播',
    text: `将从主播库移除「${name}」${more}，随时可以重新导入。`,
    confirmText: '移除',
  }))) return;
  try {
    await Promise.all(rooms.map((room) =>
      api(`/api/rooms/${encodeURIComponent(room.key)}`, { method: 'DELETE' })));
    const keys = new Set(rooms.map((room) => room.key));
    state.rooms = state.rooms.filter((room) => !keys.has(room.key));
    if (state.currentRoom && keys.has(state.currentRoom.key)) location.hash = '#/';
    render();
    toast(`已移除「${name}」`);
  } catch (error) {
    toast(error.message);
  }
}

/** 侧栏切台用：同一位主播优先给正在直播的房间 */
function pickCreatorRoom(key) {
  if (!key || key === 'all') return null;
  const rooms = state.rooms.filter((room) => creatorKey(room) === key);
  return rooms.find((room) => room.live) || rooms[0] || null;
}

/* ---------------- 外观（跟随系统 / 日间 / 夜间）---------------- */

const THEME_KEY = 'livehub:theme';
const RAIL_KEY = 'livehub:rail';
const FAV_KEY = 'livehub:favCollapsed';
const themeQuery = window.matchMedia('(prefers-color-scheme: dark)');
const THEME_NAME = { follow: '跟随系统', light: '日间', dark: '夜间' };
const THEME_ICON = {
  follow: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M9 20h6M12 16.5V20" /></svg>',
  light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M18.4 5.6l-1.5 1.5M7.1 16.9l-1.5 1.5" /></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z" /></svg>',
};

function readStoredTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'follow') return saved;
  } catch { /* 隐私模式下 localStorage 可能不可用 */ }
  return 'follow';
}

/** 当前实际生效的主题（跟随系统时看系统偏好） */
function resolvedTheme() {
  if (state.theme === 'light' || state.theme === 'dark') return state.theme;
  return themeQuery.matches ? 'dark' : 'light';
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  // 主进程同步窗口底色：拉伸窗口时露出的底色不能还是另一个主题的
  window.livehub?.setTheme?.(theme);

  const button = $('#themeBtn');
  if (button) {
    const icon = button.querySelector('.theme-ico');
    if (icon) icon.innerHTML = THEME_ICON[state.theme];
    const label = `外观：${THEME_NAME[state.theme]}`;
    button.setAttribute('aria-label', label);
    button.title = label;
  }
  const value = $('#themeValue');
  if (value) value.textContent = THEME_NAME[state.theme];
  $('#themeMenu')?.querySelectorAll('[data-theme-mode]').forEach((item) => {
    const active = item.dataset.themeMode === state.theme;
    item.setAttribute('aria-checked', String(active));
    const key = item.querySelector('.k');
    if (key) key.textContent = active ? '使用中' : '';
  });
}

function setTheme(next) {
  state.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* 忽略 */ }
  applyTheme();
}

function toggleThemeMenu(force) {
  const menu = $('#themeMenu');
  const button = $('#themeBtn');
  if (!menu || !button) return;
  const open = typeof force === 'boolean' ? force : menu.hidden;
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
}

/* ---------------- 侧栏折叠 ---------------- */

let railTimer;
let restoreGridColumns = null;

/**
 * 算出「切换完成后」会有几列。
 * 直接用 token 解析，不去临时套类量 DOM——那样会先把宽度改成目标值，
 * 连续样式变更被浏览器合并，CSS 过渡根本不会启动（实测点下去就瞬移到位）。
 * 公式与 CSS 的 auto-fill 一致：floor((可用宽 + 间距) / (最小列宽 + 间距))
 */
function targetColumns(rail) {
  const grid = $('#roomGrid');
  const catalog = $('#catalog');
  if (!grid || !catalog || !grid.offsetWidth) return 0;   // 观看页里网格是隐藏的
  const root = getComputedStyle(document.documentElement);
  const railW = parseFloat(root.getPropertyValue(rail ? '--rail-w-rail' : '--rail-w')) || (rail ? 80 : 280);
  const cardMin = parseFloat(root.getPropertyValue('--card-min')) || 198;
  const gridStyle = getComputedStyle(grid);
  const gap = parseFloat(gridStyle.columnGap) || 14;
  const maxW = parseFloat(gridStyle.maxWidth) || Infinity;
  const catalogStyle = getComputedStyle(catalog);
  const padding = (parseFloat(catalogStyle.paddingLeft) || 0) + (parseFloat(catalogStyle.paddingRight) || 0);
  const available = Math.min(window.innerWidth - railW - padding, maxW);
  if (!available || available <= 0) return 0;
  return Math.max(1, Math.floor((available + gap) / (cardMin + gap)));
}

function pinGridColumns(count) {
  const grid = $('#roomGrid');
  if (!grid || !count) return;
  const previous = grid.style.gridTemplateColumns;
  grid.style.gridTemplateColumns = `repeat(${count}, minmax(0, 1fr))`;
  restoreGridColumns = () => { grid.style.gridTemplateColumns = previous; };
}

function applyRail() {
  const shell = $('.hub-shell');
  if (!shell) return;
  const changed = shell.classList.contains('is-rail') !== state.rail;
  const button = $('#railToggle');
  if (!changed) {
    if (button) {
      const label = state.rail ? '展开侧栏' : '收起侧栏';
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    if (!state.rail) hideRailTip();
    return;
  }

  // 1) 先退毛玻璃 / 关命中（只重绘，不重排）
  state.resizing = true;
  shell.classList.add('is-resizing');

  // 2) 同帧钉住目标列数，然后才开始过渡：动画过程中只变宽、不变列数
  restoreGridColumns?.();
  pinGridColumns(targetColumns(state.rail));
  shell.classList.toggle('is-rail', state.rail);

  if (button) {
    const label = state.rail ? '展开侧栏' : '收起侧栏';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = state.rail
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>';
  }

  clearTimeout(railTimer);
  railTimer = setTimeout(() => {
    // 3) 再等一帧恢复毛玻璃，别让"重排"和"12 个角标重新模糊"撞在同一帧
    requestAnimationFrame(() => {
      state.resizing = false;
      shell.classList.remove('is-resizing');
      restoreGridColumns?.();     // 交还 auto-fill，此时列数已等于目标，不会跳
      restoreGridColumns = null;
      syncPlayerAspect();
    });
  }, 190);
  if (!state.rail) hideRailTip();
}

function hideRailTip() {
  const tip = $('#railTip');
  if (tip) tip.hidden = true;
}

/** 折叠态下文字全没了，气泡是唯一能看全「谁、在播什么」的地方 */
function showRailTip(button) {
  if (!state.rail) return;
  const tip = $('#railTip');
  if (!tip) return;
  const name = button.querySelector('.nav-name')?.textContent || '';
  if (!name) return;
  const title = button.querySelector('.nav-title')?.textContent || '';
  tip.innerHTML = `<b>${escapeHTML(name)}</b>${title ? `<small>${escapeHTML(title)}</small>` : ''}`;
  tip.hidden = false;
  const roster = $('.roster');
  if (!roster) return;
  const base = roster.getBoundingClientRect();
  const rect = button.getBoundingClientRect();
  tip.style.left = `${roster.offsetWidth + 6}px`;
  tip.style.top = `${Math.max(8, rect.top - base.top + rect.height / 2 - tip.offsetHeight / 2)}px`;
}

function renderPlatformFilters() {
  const counts = new Map();
  for (const room of state.rooms) counts.set(room.platform, (counts.get(room.platform) || 0) + 1);
  const platformIds = Object.keys(PLATFORM).filter((id) => counts.has(id));
  $('#platformFilters').innerHTML = [
    `<button class="filter-chip ${state.platform === 'all' ? 'is-selected' : ''}" data-platform="all">全部平台</button>`,
    ...platformIds.map((id) => `<button class="filter-chip ${state.platform === id ? 'is-selected' : ''}" data-platform="${id}">
      <i style="--platform-color:${platform(id).color}"></i>${platform(id).short}
    </button>`),
  ].join('');
  $('#platformFilters').querySelectorAll('[data-platform]').forEach((button) => {
    button.addEventListener('click', () => {
      state.platform = button.dataset.platform;
      renderRooms();
      renderPlatformFilters();
    });
  });
}

function getVisibleRooms() {
  const query = state.query.trim().toLocaleLowerCase();
  const rooms = state.rooms.filter((room) => {
    const matchesCreator = state.selectedCreator === 'all' || creatorKey(room) === state.selectedCreator;
    const matchesPlatform = state.platform === 'all' || room.platform === state.platform;
    const text = [creatorName(room), roomName(room), room.area, room.roomId, platform(room.platform).name]
      .join(' ').toLocaleLowerCase();
    return matchesCreator && matchesPlatform && (!query || text.includes(query));
  });

  const order = (a, b) => (a.order ?? 0) - (b.order ?? 0);
  if (state.sort === 'online') rooms.sort((a, b) => (Number(b.online) || 0) - (Number(a.online) || 0) || order(a, b));
  else if (state.sort === 'added') rooms.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  else if (state.sort === 'name') rooms.sort((a, b) => creatorName(a).localeCompare(creatorName(b), 'zh-CN'));
  else rooms.sort((a, b) => Number(!!b.live) - Number(!!a.live) || (Number(b.online) || 0) - (Number(a.online) || 0) || order(a, b));
  return rooms;
}

function renderCard(room) {
  const p = platform(room.platform);
  const creator = creatorName(room);
  // 主播没设标题时，卡片这行改显示分区——上行已经是主播名，再重复一遍没意义
  const title = room.customTitle || room.title || room.area || roomName(room);
  const cover = room.cover
    ? `<img class="room-cover-image" src="${escapeHTML(room.cover)}" loading="lazy" decoding="async" alt="${escapeHTML(creator)} 的直播封面" onerror="this.remove()">`
    : `<div class="cover-placeholder" style="--platform-color:${p.color}"><span>${escapeHTML(creator.slice(0, 1))}</span></div>`;
  const pending = room.pending || room.lastChecked === null;
  // 状态只在封面上留一个信号：直播中（红点）/ 待更新（黄点）。
  // 未开播不再放胶囊，封面压灰 + 居中「未开播」，整页少一排灰胶囊，干净很多。
  // 状态只用一个小圆点表达，不再每条都挂「直播中」胶囊——四张卡片重复同一个标签很吵
  const stateChip = pending
    ? '<span class="live-state is-pending" title="信息待更新" aria-label="信息待更新"><i></i></span>'
    : room.live
      ? '<span class="live-state is-live" title="直播中" aria-label="直播中"><i></i></span>'
      : '';
  // 人气从标题行挪到封面左下角，标题行只留标题
  const audience = room.live && room.online ? `<span class="cover-audience" title="房间人气">${fmtNum(room.online)}<em>人气</em></span>` : '';
  const url = `#/room/${encodeURIComponent(room.key)}`;
  const cardState = pending ? ' is-pending' : room.live ? ' is-live' : '';

  return `<article class="room-card${cardState}">
    <a class="room-card-link" href="${escapeHTML(url)}" aria-label="在 LiveHub 内打开 ${escapeHTML(creator)} 的${escapeHTML(p.name)}直播间"></a>
    <div class="room-cover">
      ${cover}
      <span class="platform-chip" style="--platform-color:${p.color}"><i></i>${escapeHTML(p.short)}</span>
      ${stateChip}
      ${audience}
      <span class="cover-play" aria-hidden="true">▶</span>
      <span class="cover-offline" aria-hidden="true"><i>未开播</i></span>
    </div>
    <div class="room-card-body">
      <div class="room-card-head">
        <span class="room-avatar" style="--platform-color:${p.color}">${room.avatar ? `<img class="room-avatar-img" src="${escapeHTML(room.avatar)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}<span class="room-avatar-fallback" aria-hidden="true">${escapeHTML(creator.slice(0, 1))}</span></span>
        <span class="room-creator" title="${escapeHTML(creator)}">${escapeHTML(creator)}</span>
        <button class="remove-room" type="button" data-remove="${escapeHTML(room.key)}" aria-label="从主播库移除 ${escapeHTML(creator)}" title="移除房间">···</button>
      </div>
      <div class="room-card-title" title="${escapeHTML(title)}">${escapeHTML(title)}</div>
    </div>
  </article>`;
}

function renderRooms() {
  const rooms = getVisibleRooms();
  const creator = getCreators().find((item) => item.key === state.selectedCreator);
  $('#catalogTitle').textContent = creator?.name || (state.selectedCreator === 'all' ? '全部主播' : '主播房间');
  const liveCount = rooms.filter((room) => room.live).length;
  $('#catalogSubtitle').textContent = `${rooms.length} 个房间 · ${liveCount} 个正在直播`;
  $('#roomGrid').innerHTML = rooms.map(renderCard).join('');
  $('#catalogEmpty').hidden = rooms.length > 0;
  if (!rooms.length) {
    const libraryEmpty = state.rooms.length === 0;
    $('#emptyTitle').textContent = libraryEmpty ? '先导入你喜欢的主播' : '没有找到匹配的房间';
    $('#emptyCopy').textContent = libraryEmpty
      ? '粘贴直播间链接，主播就会出现在左侧列表和这里的房间卡片中。'
      : '试试清空搜索词，或切换主播和平台筛选。';
  }

  $('#roomGrid').querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      const room = state.rooms.find((item) => item.key === button.dataset.remove);
      if (!room) return;
      if (!(await confirmDialog({
        title: '移除主播',
        text: `将从主播库移除「${creatorName(room)}」的房间，随时可以重新导入。`,
        confirmText: '移除',
      }))) return;
      try {
        await api(`/api/rooms/${encodeURIComponent(room.key)}`, { method: 'DELETE' });
        state.rooms = state.rooms.filter((item) => item.key !== room.key);
        render();
        toast('已从主播库移除');
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

function render() {
  renderSidebar();
  renderPlatformFilters();
  renderRooms();
  updateRefreshUi();
}

function showPlayerMessage(message, kind = '') {
  const panel = $('#playerMessage');
  panel.classList.remove('is-hidden', 'is-error');
  if (kind === 'error') panel.classList.add('is-error');
  $('#playerMessageText').textContent = message;
  $('#playerStatus').textContent = kind === 'error' ? '播放异常' : message;
}

/* 未开播时自动重试：每 30 秒重新解析一次，不用用户手动点「重新连接」 */
const OFFLINE_RETRY_SECONDS = 30;
let offlineTimer = null;

function clearOfflineTimer() {
  if (offlineTimer) clearInterval(offlineTimer);
  offlineTimer = null;
}

function scheduleOfflineRetry(room) {
  clearOfflineTimer();
  let left = OFFLINE_RETRY_SECONDS;
  const paint = () => {
    if (state.currentRoom?.key !== room.key) return clearOfflineTimer();
    $('#playerMessageText').textContent = `主播当前未开播 · ${left} 秒后自动重试`;
  };
  paint();
  offlineTimer = setInterval(() => {
    if (state.currentRoom?.key !== room.key) return clearOfflineTimer();
    left -= 1;
    if (left > 0) return paint();
    clearOfflineTimer();
    loadWatchRoom(room);
  }, 1000);
}

function clearPlayerEngine() {
  const video = $('#watchVideo');
  // 拆流时 removeAttribute('src') + load() 必然触发一次 error 事件，
  // 这不是播放故障。不挡住它，error 回调会立刻触发重连，
  // 重连又拆流又触发 error —— 每 2.5 秒转一圈，直播根本没法看。
  player.clearing = true;
  setTimeout(() => { player.clearing = false; }, 400);
  stopPlayWatchdog();
  if (player.hls) {
    player.hls.destroy();
    player.hls = null;
  }
  if (player.flv) {
    try {
      player.flv.pause();
      player.flv.unload();
      player.flv.detachMediaElement();
      player.flv.destroy();
    } catch {}
    player.flv = null;
  }
  video.pause();
  video.removeAttribute('src');
  try { video.load(); } catch {}
}

function stopWatchRoom() {
  player.requestId += 1;
  clearOfflineTimer();
  stopDanmaku();
  stopBufferController();
  stopStallProbe();
  clearPlayerEngine();
  player.streams = [];
  player.qualities = [];
  player.quality = '';
  player.qualityMode = 'remote';
  state.currentRoom = null;
  $('#danmakuOverlay').replaceChildren();
  setWatchBackdrop(null);
  $('#catalog').hidden = false;
  $('#watchPage').hidden = true;
  render();
}

/** 标题行右侧的标签：平台 / 房间号 / 分区 / 人气 */
function setWatchTags(room) {
  const heading = $('#watchRoomHeading');
  if (heading) heading.style.setProperty('--platform-color', platform(room.platform).color);

  const platformTag = $('#watchPlatformTag');
  if (platformTag) platformTag.textContent = platform(room.platform).name;

  // 房间号不进视觉层（挪到 title 里，悬停可见）；分区并入副标题，标签只留平台 + 人气
  if (heading) heading.title = `房间号 ${room.roomId}`;

  const onlineTag = $('#watchOnlineTag');
  if (onlineTag) {
    const online = Number(room.online) || 0;
    onlineTag.textContent = online ? `${fmtNum(online)} 人气` : '';
    onlineTag.hidden = !online;
  }
}

/** 观看页头像：用真实头像，缺失或裂图时退回首字母占位 */
function setWatchAvatar(room) {
  const box = $('#watchAvatar');
  box.style.setProperty('--platform-color', platform(room.platform).color);
  $('#watchAvatarFallback').textContent = creatorName(room).slice(0, 1);
  setWatchTags(room);

  let img = box.querySelector('.watch-avatar-img');
  if (!room.avatar) {
    img?.remove();
    return;
  }
  if (!img) {
    img = document.createElement('img');
    img.className = 'watch-avatar-img';
    img.alt = '';
    img.decoding = 'async';
    // 加载失败就撤掉 img，露出底下的首字母
    img.addEventListener('error', () => img.remove());
    box.appendChild(img);
  }
  // img.src 读回来是绝对地址，没法直接跟 room.avatar 比，自己记一份避免重复加载
  if (img.dataset.src !== room.avatar) {
    img.dataset.src = room.avatar;
    img.src = room.avatar;
  }
}

/** 观看页底图：用直播间封面做模糊铺底，纯背景色太寡 */
function setWatchBackdrop(room) {
  const node = $('#watchBackdrop');
  if (!node) return;
  const cover = room?.cover ? String(room.cover).replace(/["'()]/g, '') : '';
  node.style.backgroundImage = cover ? `url("${cover}")` : '';
  node.classList.toggle('is-on', Boolean(cover));
}

async function enterWatchRoom(room) {
  if (!room) return;
  if (state.currentRoom?.key === room.key && !$('#watchPage').hidden) return;
  setWatchBackdrop(room);
  clearOfflineTimer();
  clearPlayerEngine();
  player.requestId += 1;
  state.currentRoom = room;
  // 侧栏高亮跟着当前房间走。不动 state.selectedCreator——那是目录的筛选条件，
  // 改了会让「返回目录」落在一个只剩该主播的列表里。
  renderSidebar();
  $('#catalog').hidden = true;
  $('#watchPage').hidden = false;
  $('#watchLiveState').textContent = room.live ? '正在直播' : '准备进入';
  $('#watchTitle').textContent = roomName(room);
  $('#watchAnchor').textContent = [creatorName(room), room.area].filter(Boolean).join(' · ');
  setWatchAvatar(room);
  $('#danmakuOverlay').replaceChildren();
  $('#danmakuOverlay').classList.remove('is-visible');
  $('#toggleOverlay').disabled = true;
  $('#watchLayout').hidden = false;
  danmaku.canSend = false;
  danmaku.lastStatus = null;
  $('#danmakuInput').value = '';
  $('#danmakuInput').disabled = true;
  $('#danmakuInput').placeholder = '正在检查弹幕发送能力…';
  $('#danmakuForm button').disabled = true;
  $('#danmakuForm button').textContent = '发送';
  // 换房间先把上一次算出的尺寸清掉，免得留在这儿
  resetPlayerSize();
  setWatchBackdrop(room); // 封面可能是这里刚从服务端刷新出来的
  $('#qualityBtn').textContent = '自动';
  $('#qualityBtn').disabled = true;
  $('#qualityOptions').innerHTML = '';
  $('#lineOptions').innerHTML = '';
  $('#lineTitle').hidden = true;
  closePlayerPopovers();
  showQualityHint('');
  player.qualities = [];
  player.quality = '';
  player.qualityMode = 'remote';
  player.streams = [];
  player.platform = room.platform;
  // 恢复这个直播间上次的声音、线路、弹幕设置（清晰度要等服务端返回档位后再套用）。
  // 偏好存在服务端，第一次要先把它们拉回来，不然后面 apply 到的是空数据。
  player.shortStreams = 0;
  player.starveMarks = [];
  player.degrading = false;
  player.diagLastAt = {};
  player.diagCount = 0;
  player.diagBufferLow = 99;
  player.lastDuration = -1;
  player.durationStableAt = 0;
  await loadRoomPrefs();
  applyRoomPrefs(room);
  $('#playerMessage').classList.remove('is-hidden', 'is-error');
  $('#playerMessageText').textContent = '正在连接直播间…';
  $('#playerStatus').textContent = '连接中';
  document.querySelector('.catalog').scrollTop = 0;
  $('#watchPage').scrollTop = 0;
  startDanmaku(room);
  startBufferController();
  startStallProbe();
  loadWatchRoom(room);
}

async function handleRoute() {
  const match = location.hash.match(/^#\/room\/(.+)$/);
  if (!match) {
    if (state.currentRoom) stopWatchRoom();
    return;
  }
  let key;
  try { key = decodeURIComponent(match[1]); } catch { key = match[1]; }
  const room = state.rooms.find((item) => item.key === key);
  if (room) await enterWatchRoom(room);
  else {
    location.hash = '#/';
    toast('房间不存在，请从主播目录重新选择');
  }
}

/* ---------------- 弹幕 ---------------- */

const DANMAKU_LIMIT = 150;
const danmaku = {
  source: null,
  roomKey: null,
  count: 0,
  shadowRoom: '',
  unread: 0,
  canSend: false,
  // 'server' = 服务端直发，'desktop' = 桌面端在页面里代发
  sendMode: false,
  // 本房间的发言门槛（粉丝牌/等级/禁言…）。命中后本房间不再尝试发送，直接把原因挂在输入框上
  restricted: null,
  sending: false,
  lastSentAt: 0,
  cooldownTimer: null,
  lastStatus: null,
  // 自己发出去的弹幕：平台回推时用来和乐观回显的那条去重
  selfSent: [],
};

/** 发送节流。平台限频之外多留一点余量，避免用户连点把账号送进冷却 */
const SEND_COOLDOWN_MS = 3000;

const STATE_TEXT = {
  connecting: { label: '连接中', summary: '正在连接弹幕通道' },
  connected: { label: '已连接', summary: '实时弹幕' },
  reconnecting: { label: '重连中', summary: '弹幕连接中断，正在重试' },
  error: { label: '不可用', summary: '弹幕通道异常' },
  idle: { label: '待连接', summary: '进入房间后自动连接' },
};

function startDanmaku(room) {
  stopDanmaku();
  danmaku.roomKey = room.key;

  // 抖音弹幕服务端连不上（要 a_bogus 签名），桌面端开一个隐藏窗口让页面自己算，
  // 主进程把 im/fetch 的响应体回灌给本地服务解码。
  if (room.platform === 'douyin' && window.livehub?.danmaku) {
    danmaku.shadowRoom = String(room.roomId);
    window.livehub.danmaku.open(danmaku.shadowRoom).catch(() => {});
  }

  const source = new EventSource(
    `/api/danmaku/stream?platform=${encodeURIComponent(room.platform)}&room=${encodeURIComponent(room.roomId)}`,
  );
  danmaku.source = source;

  source.addEventListener('status', (event) => {
    if (danmaku.roomKey !== room.key) return;
    applyDanmakuStatus(room, JSON.parse(event.data));
  });

  source.addEventListener('message', (event) => {
    if (danmaku.roomKey !== room.key) return;
    pushDanmaku(JSON.parse(event.data));
  });
}

function stopDanmaku() {
  if (danmaku.source) danmaku.source.close();
  danmaku.source = null;
  danmaku.roomKey = null;
  if (danmaku.shadowRoom && window.livehub?.danmaku) {
    window.livehub.danmaku.close(danmaku.shadowRoom).catch(() => {});
  }
  danmaku.shadowRoom = '';
  danmaku.canSend = false;
  danmaku.lastStatus = null;
  danmaku.selfSent = [];
  danmaku.restricted = null;
  clearTimeout(danmaku.cooldownTimer);
  $('#danmakuOverlay')?.replaceChildren();
  resetDanmakuFollow();
}

function applyDanmakuStatus(room, status) {
  // 记住最近一次状态，账号变化时可以只重算发送能力，不用等下一次回推
  danmaku.lastStatus = status;
  const text = STATE_TEXT[status.state] || STATE_TEXT.connecting;
  // 播放器里不再显示连接状态角标（会压住画面）；状态只用于内部判断
  const indicator = { textContent: '', classList: { toggle() {} } };
  $('#toggleOverlay').disabled = !status.read;
  if (!status.read) setDanmakuOverlay(false);
  else {
    // 列表已经去掉，弹幕全靠悬浮显示；没记过偏好就默认打开，
    // 否则用户进来一条弹幕都看不到
    const wanted = player.pendingOverlay === undefined ? true : player.pendingOverlay;
    player.pendingOverlay = undefined;
    setDanmakuOverlay(wanted);
  }
  applySendCapability(room, status);
}

/* ---------------- 弹幕发送 ---------------- */

/**
 * 输入框的可用性由「平台支不支持发送」×「有没有登录账号」共同决定，
 * 每次弹幕状态回推时重新判断，中途登录也能立刻解锁。
 *
 * 两家能力来源不同：
 *   server  —— 服务端自己发（B 站），要求服务端有登录态
 *   desktop —— 桌面端在真实页面里代发（斗鱼/虎牙/抖音），登录态在页面分区里，服务端看不到
 */
function applySendCapability(room, status) {
  const name = platform(room.platform).name;
  const input = $('#danmakuInput');
  // 提示语那句已经去掉了；用哑对象吸收赋值，免得到处判空
  const note = $('#danmakuAuthNote') || { textContent: '' };
  const isDesktop = Boolean(window.livehub?.isDesktop);
  const desktopMode = status.sendMode === 'desktop';

  danmaku.sendMode = status.sendMode || false;
  danmaku.canSend = desktopMode
    ? Boolean(status.send) && isDesktop
    : Boolean(status.send) && Boolean(status.loggedIn);

  if (status.maxLength) input.maxLength = status.maxLength;

  if (!status.send) {
    input.disabled = true;
    input.placeholder = `${name}暂不支持发送弹幕`;
    note.textContent = `由 LiveHub 直连${name}弹幕通道，只读取聊天弹幕；${name}的发送通道暂未接入。`;
    syncSendButton();
    return;
  }

  // 本房间有发言门槛（粉丝牌/等级/禁言/需关注…）：把原因写在输入框上，
  // 但不锁死——用户去加粉丝团/解禁后，直接再点发送就能重试成功
  if (danmaku.restricted && danmaku.restricted.key === `${room.platform}:${room.roomId}`) {
    input.disabled = false;
    input.placeholder = '本直播间可能无法发言';
    note.textContent = `${danmaku.restricted.message}（满足条件后可直接再点发送重试）`;
    syncSendButton();
    return;
  }

  if (desktopMode && !isDesktop) {
    input.disabled = true;
    input.placeholder = `${name}弹幕需要在桌面端发送`;
    note.textContent = `${name}的发送要在真实页面里完成（签名和登录态都在页面内），请使用 LiveHub 桌面版。`;
    syncSendButton();
    return;
  }

  if (desktopMode) {
    const account = state.accounts.find((item) => item.platform === room.platform);
    input.disabled = false;
    input.placeholder = '发个弹幕…（Enter 发送）';
    note.textContent = account?.nickname
      ? `弹幕将由桌面端以${name}账号「${account.nickname}」在页面里发出，请遵守直播间规则。`
      : `弹幕将由桌面端用你在${name}的登录态发出；没登录会提示先登录。`;
    syncSendButton();
    return;
  }

  if (!status.loggedIn) {
    input.disabled = true;
    input.placeholder = `登录${name}账号后可发送弹幕`;
    note.textContent = `已接入${name}的发送通道，但还没有登录账号。在「平台账号」里登录后即可用你自己的身份发弹幕。`;
    syncSendButton();
    return;
  }

  const account = state.accounts.find((item) => item.platform === room.platform);
  input.disabled = false;
  input.placeholder = '发个弹幕…（Enter 发送）';
  note.textContent = account?.nickname
    ? `弹幕将以${name}账号「${account.nickname}」的身份发出，请遵守直播间规则。`
    : `弹幕将以已登录的${name}账号身份发出，请遵守直播间规则。`;
  syncSendButton();
}

/** 按钮状态是「能发 + 有内容 + 不在冷却」的三者交集 */
function syncSendButton() {
  const button = $('#danmakuForm button');
  const input = $('#danmakuInput');
  clearTimeout(danmaku.cooldownTimer);
  danmaku.cooldownTimer = null;

  const left = Math.ceil((SEND_COOLDOWN_MS - (Date.now() - danmaku.lastSentAt)) / 1000);
  const cooling = left > 0 && !danmaku.sending;
  button.classList.toggle('is-sending', danmaku.sending);
  button.textContent = danmaku.sending ? '发送中' : cooling ? `${left}s` : '发送';
  button.disabled = input.disabled || danmaku.sending || !input.value.trim() || cooling;
  if (cooling) {
    danmaku.cooldownTimer = setTimeout(syncSendButton, 250);
  }
}

async function submitDanmaku() {
  const room = state.currentRoom;
  const input = $('#danmakuInput');
  const content = input.value.trim();
  if (!room || !content || !danmaku.canSend || danmaku.sending) return;

  danmaku.sending = true;
  // 立刻清空输入框：发送要等服务端/桌面端校验几秒才有结果，
  // 等结果回来再清，用户会盯着自己那句话待好几秒，像没反应。
  input.value = '';
  syncSendButton();

  // 先占位再发：斗鱼这类平台的回推 1 秒就到，而发送要等服务端校验几秒才返回。
  // 如果等发送成功才插自己的那条，回推会先被当成别人的弹幕显示，最后变成两条。
  const record = { content, at: Date.now() };
  danmaku.selfSent.push(record);
  const optimistic = pushDanmaku(
    { user: senderName(room.platform), content, color: '', timestamp: Date.now() },
    { self: true },
  );

  try {
    if (danmaku.sendMode === 'desktop') {
      // 桌面端在真实页面里代发：签名与登录态都在页面内，服务端不参与
      const result = await window.livehub.danmaku.send({
        platform: room.platform,
        roomId: String(room.roomId),
        content,
      });
      if (!result?.ok) {
        const error = new Error(result?.error || '发送失败');
        error.code = result?.code || 'failed';
        error.reason = result?.reason;
        throw error;
      }
    } else {
      await api('/api/danmaku/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: room.platform, room: String(room.roomId), content }),
      });
    }
    danmaku.lastSentAt = Date.now();
    // 之前判定过「本房间发不了」，现在发成功了（可能刚加了粉丝团），清掉提示
    if (danmaku.restricted) {
      danmaku.restricted = null;
      applySendCapability(room, danmaku.lastStatus || {});
    }
  } catch (error) {
    // 发送失败：把占位那条和去重记录一起撤掉，别留下幽灵弹幕；
    // 输入框里没有新内容时把刚才那句话还回去，方便直接重试
    optimistic?.remove();
    danmaku.selfSent = danmaku.selfSent.filter((item) => item !== record);
    // 发言门槛（粉丝牌/等级/禁言…）：记住它，之后的输入框直接显示原因，不再让你白试。
    // 服务端直发（B 站）不带 restricted 码，按文案兜一层
    const blocked =
      error.code === 'restricted' || /粉丝|等级|禁言|关注主播|发言权限|无权发言/.test(error.message || '');
    if (blocked) {
      danmaku.restricted = {
        key: `${room.platform}:${room.roomId}`,
        message: error.message,
        reason: error.reason || '',
      };
      applySendCapability(room, danmaku.lastStatus || {});
      toast(error.message);
      return;
    }
    if (!input.value.trim()) input.value = content;
    toast(error.message);
  } finally {
    danmaku.sending = false;
    syncSendButton();
  }
}

/** 列表里「我」这一栏显示成什么名字 */
function senderName(platformId) {
  const account = state.accounts.find((item) => item.platform === platformId);
  return account?.nickname || '我';
}

/**
 * 平台会把自己发的弹幕回推一遍，和刚才乐观回显的那条内容相同 —— 丢掉回推。
 * 找不到对应记录说明乐观回显那条已经被挤掉了，照常显示，不吞消息。
 */
function consumeSelfEcho(msg) {
  const now = Date.now();
  const index = danmaku.selfSent.findIndex(
    (item) => item.content === msg.content && now - item.at < 10_000,
  );
  if (index < 0) return false;
  danmaku.selfSent.splice(index, 1);
  return true;
}

/** 提示按钮的渲染节流。弹幕密集时 unread 每来一条就 +1，渲染合并到这个间隔再落地 */
const JUMP_RENDER_MS = 260;
let jumpRenderTimer = null;

/**
 * 把 unread 同步到按钮上。hidden 和文案都只在值真的变了才写 DOM ——
 * 之前每条弹幕都无条件写一次，实测 6 秒能写出 407 次无意义的属性变更。
 */
function renderJumpBadge() {
  // 悬浮弹幕模式下没有列表，无需处理
}

/** 合并高频更新：期间 unread 照常累加，只是渲染慢一拍，避免数字每秒跳十几次 */
function scheduleJumpRender() {
  if (jumpRenderTimer) return;
  jumpRenderTimer = setTimeout(() => {
    jumpRenderTimer = null;
    renderJumpBadge();
  }, JUMP_RENDER_MS);
}

/* 是否贴着底部。留 40px 容差，手指/触控板拉到差一点点也算在底部 */
function isDanmakuPinned() {
  // 悬浮弹幕模式下没有列表，无需处理
}

/** 把列表拉回底部，回到「跟随最新」状态 */
function followDanmaku() {
  // 悬浮弹幕模式下没有列表，无需处理
}

/** 清掉未读并收起提示。收起必须立刻生效，所以不走节流、还要取消挂起的渲染 */
function resetDanmakuFollow() {
  clearTimeout(jumpRenderTimer);
  jumpRenderTimer = null;
  danmaku.unread = 0;
  renderJumpBadge();
}

function pushDanmaku(msg, { self = false } = {}) {
  // 平台回推的「自己那条」要吃掉：B 站会带 self 标记，斗鱼/虎牙/抖音不带，
  // 只能靠「刚才发过同内容」来判断，否则自己发的会显示成两条。
  if (!self && consumeSelfEcho(msg)) return;

  danmaku.count += 1;
  // 弹幕直接飘在画面上（和主流直播网页一致）
  if (player.overlay) spawnOverlay(msg);
  return null;
}

/** 判断弹幕颜色是否偏暗（用于选描边方向）：支持 #rgb / #rrggbb / rgb() */
function isDarkColor(color) {
  const text = String(color).trim();
  let r = 255, g = 255, b = 255;
  if (text.startsWith('#')) {
    const hex = text.slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    r = parseInt(full.slice(0, 2), 16);
    g = parseInt(full.slice(2, 4), 16);
    b = parseInt(full.slice(4, 6), 16);
  } else {
    const nums = text.match(/\d+(\.\d+)?/g);
    if (nums && nums.length >= 3) [r, g, b] = nums.map(Number);
  }
  if ([r, g, b].some((v) => Number.isNaN(v))) return false;
  // 感知亮度（ITU-R BT.601）
  return (r * 0.299 + g * 0.587 + b * 0.114) / 255 < 0.62;
}

function spawnOverlay(msg) {
  const overlay = $('#danmakuOverlay');
  if (!overlay || overlay.childElementCount > 40) return;
  const node = document.createElement('span');
  node.className = 'danmaku-float';
  node.textContent = msg.content;
  if (msg.color) {
    node.style.color = msg.color;
    // 深色弹幕（平台发的黑字）配浅色描边，浅色弹幕配深色描边——
    // 弹幕永远压在视频上，不能靠主题来决定描边方向
    if (isDarkColor(msg.color)) {
      node.style.setProperty('--dm-stroke', 'rgba(255, 255, 255, .55)');
      node.style.setProperty('--dm-shadow', '0 0 3px rgba(255, 255, 255, .85), 0 1px 2px rgba(255, 255, 255, .45)');
    }
  }
  // 区域决定弹道可用高度：顶部约 1/3、半屏约 1/2、全部接近满屏
  const spread = { top: 32, half: 52, full: 86 }[danmakuStyle.area] || 52;
  node.style.top = `${(Math.random() * spread).toFixed(1)}%`;
  // 速度值越大飞得越快：20 约 5s，5 约 12.5s；加一点随机避免整排同步
  const duration = 15 - danmakuStyle.speed * 0.5;
  node.style.animationDuration = `${(duration + Math.random() * 2).toFixed(1)}s`;
  overlay.appendChild(node);
  node.addEventListener('animationend', () => node.remove(), { once: true });
}

/* ---------------- 观看偏好：按直播间记忆 ---------------- */

// 每个直播间记住自己的音量、清晰度、线路、悬浮弹幕和弹幕四项样式。
// 存在服务端的数据目录里而不是 localStorage —— 桌面端每次启动是随机端口，
// 而 localStorage 按 origin（含端口）隔离，端口一换偏好就全丢了。
// 服务端读写是异步的，所以这里用一个内存副本给同步代码（进房间要立刻套用），
// 后台再慢慢往服务端推，拖音量滑块这种高频操作也不会一直写文件。
let roomPrefsCache = null; // null = 还没拉过
let roomPrefsLoading = null;
const roomPrefsTimer = new Map();
const roomPrefsPending = new Map(); // key -> 累积待发送的 patch

async function loadRoomPrefs({ force = false } = {}) {
  if (roomPrefsCache && !force) return roomPrefsCache;
  if (roomPrefsLoading && !force) return roomPrefsLoading;
  roomPrefsLoading = (async () => {
    try {
      const data = await api('/api/prefs');
      roomPrefsCache = data && typeof data === 'object' ? data : {};
    } catch {
      // 拉不到就当成还没有偏好，本次会话内仍然记得住
      roomPrefsCache = roomPrefsCache || {};
    }
    roomPrefsLoading = null;
    return roomPrefsCache;
  })();
  return roomPrefsLoading;
}

function readRoomPrefs(key) {
  if (!key) return null;
  return roomPrefsCache?.[key] || null;
}

/**
 * 更新内存副本，再节流推给服务端（拖音量滑块是连续事件，没必要每帧写一次文件）。
 * 注意要把这段时间内的改动**累积**起来一起发：直接覆盖的话，
 * 「拖音量 → 拖字号」里只有最后一项会被发出去，前面的就丢了。
 */
function patchRoomPrefs(key, patch) {
  if (!key) return;
  if (!roomPrefsCache) roomPrefsCache = {};
  const prev = roomPrefsCache[key] || {};
  const next = { ...prev, ...patch };
  if (patch.danmaku) next.danmaku = { ...(prev.danmaku || {}), ...patch.danmaku };
  next.updatedAt = Date.now();
  roomPrefsCache[key] = next;

  const queued = roomPrefsPending.get(key) || {};
  const merged = { ...queued, ...patch };
  if (patch.danmaku) merged.danmaku = { ...(queued.danmaku || {}), ...patch.danmaku };
  roomPrefsPending.set(key, merged);

  clearTimeout(roomPrefsTimer.get(key));
  roomPrefsTimer.set(key, setTimeout(() => flushRoomPrefs(key), 400));
}

/** 把一个房间攒下的改动立刻发出去 */
function flushRoomPrefs(key) {
  const patch = roomPrefsPending.get(key);
  if (!patch) return;
  clearTimeout(roomPrefsTimer.get(key));
  roomPrefsPending.delete(key);
  api(`/api/prefs?room=${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(() => {
    /* 服务没起来也不影响本次会话 */
  });
}

/** 关页面/退出 App 前把还没落盘的改动补发，避免最后那几百毫秒的调整白调 */
function flushAllRoomPrefs() {
  for (const key of [...roomPrefsPending.keys()]) flushRoomPrefs(key);
}

const currentRoomKey = () => state.currentRoom?.key || '';

/** 音量落在 0~1，脏数据不信任 */
const clampVolume = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
};

/**
 * 进入直播间时把上次的配置恢复回去。
 * 没有记录的房间沿用全局默认值（以往的行为），不会因为改了这个功能就变样。
 */
function applyRoomPrefs(room) {
  const prefs = readRoomPrefs(room.key) || {};
  const video = $('#watchVideo');

  // 弹幕样式：本房间的优先，没调过的房间用出厂默认值，
  // 不带任何「上次调到哪」的历史包袱，房间之间互不串味
  danmakuStyle = { ...DANMAKU_STYLE_DEFAULT, ...(prefs.danmaku || {}) };
  applyDanmakuStyle();
  syncDanmakuSettingsUI();

  // 声音：调过的房间恢复当时的音量/静音；没调过就保持「先进去再说」的静音策略
  if (typeof prefs.volume === 'number' || prefs.soundUserSet) {
    player.applyingPrefs = true; // 自己写的不算用户改动，别回写覆盖
    const volume = clampVolume(prefs.volume);
    if (volume !== null) video.volume = volume;
    video.muted = Boolean(prefs.muted);
    player.soundUserSet = Boolean(prefs.soundUserSet);
    setTimeout(() => {
      player.applyingPrefs = false;
    }, 0);
  } else {
    // 第一次进的房间回到出厂状态（满音量、静音起步），
    // 不能让 video 元素把上一个房间调过的音量带过来
    player.soundUserSet = false;
    player.applyingPrefs = true;
    video.volume = 1;
    video.muted = true;
    setTimeout(() => {
      player.applyingPrefs = false;
    }, 0);
  }

  // 线路（清晰度要等服务端返回可选档位后再套用，见 loadWatchRoom）
  player.line = Number(prefs.line) || 0;
  // 没调过这个房间就留空（undefined），等通道就绪时按「默认开启」处理：
  // 弹幕列表已经去掉，不开悬浮就一条弹幕都看不见
  player.pendingOverlay = typeof prefs.overlay === 'boolean' ? prefs.overlay : undefined;
  syncSoundUI();
}

/** 记住当前房间的声音设置 */
function saveSoundPrefs() {
  if (player.applyingPrefs) return; // 正在恢复记忆，别把记忆写回去
  const video = $('#watchVideo');
  patchRoomPrefs(currentRoomKey(), {
    volume: clampVolume(video.volume) ?? 1,
    muted: video.muted,
    soundUserSet: player.soundUserSet,
  });
}

/* ---------------- 悬浮弹幕设置 ---------------- */

// 注：早期版本把弹幕样式存在 livehub:danmaku-style 这一全局键里，
// 现在改为按直播间分别记忆（livehub:room-prefs:v1），旧键值不再读写，留在 localStorage 里无害。
const DANMAKU_STYLE_DEFAULT = { opacity: 100, fontSize: 14, speed: 10, area: 'half' };
let danmakuStyle = { ...DANMAKU_STYLE_DEFAULT };

function loadDanmakuStyle() {
  danmakuStyle = { ...DANMAKU_STYLE_DEFAULT };
}

function saveDanmakuStyle(patch) {
  danmakuStyle = { ...danmakuStyle, ...patch };
  // 只记到当前直播间名下：不同房间的偏好互不干扰，
  // 不去更新那个全局默认值，否则换个房间就把上一个房间的设置带过去了
  patchRoomPrefs(currentRoomKey(), { danmaku: patch });
  applyDanmakuStyle();
  syncDanmakuSettingsUI();
}

/** 字号与透明度走 CSS 变量，区域和速度由 spawnOverlay 读 */
function applyDanmakuStyle() {
  const overlay = $('#danmakuOverlay');
  if (!overlay) return;
  overlay.style.setProperty('--dm-opacity', String(danmakuStyle.opacity / 100));
  overlay.style.setProperty('--dm-size', `${danmakuStyle.fontSize}px`);
}

/**
 * 滑杆填充：把当前值换算成百分比写进 --p，CSS 用它把轨道切成
 * 「已选段（亮）」和「未选段（淡）」——不然看不出值占了多少。
 */
function paintRange(node) {
  if (!node) return;
  const min = Number(node.min) || 0;
  const max = Number(node.max) || 100;
  const value = Number(node.value);
  const p = max > min ? ((value - min) / (max - min)) * 100 : 0;
  node.style.setProperty('--p', `${Math.max(0, Math.min(100, p)).toFixed(2)}%`);
}

/**
 * 滑杆交互：输入时同步填充；拖动/聚焦时给整行加状态类，
 * 让右侧数值从灰变亮（操作有即时反馈）。
 */
function wireRange(node) {
  if (!node) return;
  paintRange(node);
  const row = node.closest('.pop-row');
  const on = () => { paintRange(node); row?.classList.add('is-dragging'); };
  const off = () => row?.classList.remove('is-dragging');
  node.addEventListener('input', on);
  node.addEventListener('pointerdown', on);
  node.addEventListener('pointerup', off);
  node.addEventListener('pointercancel', off);
  node.addEventListener('blur', off);
  node.addEventListener('keydown', on);
  node.addEventListener('keyup', off);
}

/** 把设置回写到面板控件上 */
function syncDanmakuSettingsUI() {
  const setValue = (id, value) => {
    const node = $(id);
    if (node) node.value = String(value);
  };
  setValue('#dmOpacity', danmakuStyle.opacity);
  setValue('#dmFontSize', danmakuStyle.fontSize);
  setValue('#dmSpeed', danmakuStyle.speed);
  for (const id of ['#dmOpacity', '#dmFontSize', '#dmSpeed']) paintRange($(id));
  const texts = { '#dmOpacityVal': `${danmakuStyle.opacity}%`, '#dmFontSizeVal': `${danmakuStyle.fontSize}px`, '#dmSpeedVal': `${danmakuStyle.speed}` };
  for (const [id, text] of Object.entries(texts)) {
    const node = $(id);
    if (node) node.textContent = text;
  }
  const seg = $('#dmArea');
  if (seg) {
    seg.querySelectorAll('button').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.area === danmakuStyle.area);
    });
  }
}

/* ---------------- 播放器：清晰度与线路 ---------------- */

// 各平台的清晰度参数名不同，切换时带着它重新取流
const QUALITY_PARAM = { bilibili: 'qn', douyu: 'rate', huya: 'ratio' };

const qualityStorageKey = (platform) => `livehub:quality:${platform}`;

function readQualityPreference(platform) {
  try {
    return localStorage.getItem(qualityStorageKey(platform)) || '';
  } catch {
    return '';
  }
}

function saveQualityPreference(platform, quality) {
  try {
    if (quality) localStorage.setItem(qualityStorageKey(platform), quality);
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
}

function resolveUrl(room, quality) {
  const base =
    `/api/resolve?platform=${encodeURIComponent(room.platform)}` +
    `&room=${encodeURIComponent(room.roomId)}`;
  const param = QUALITY_PARAM[room.platform];
  if (!quality || !param) return base;
  return `${base}&${param}=${encodeURIComponent(quality)}`;
}

/** 抖音一次下发全部档位，本地过滤即可；其余平台服务端已按档位返回 */
function currentQualityStreams() {
  if (player.qualityMode !== 'local' || !player.quality) return player.streams;
  const matched = player.streams.filter((stream) => stream.quality === player.quality);
  return matched.length ? matched : player.streams;
}

function lineLabel(stream, index) {
  const qualityName = player.qualities.find((q) => q.id === player.quality)?.name || '';
  let label = stream.name || `线路 ${index + 1}`;
  // 「超清 · HLS」这种前缀在选择清晰度后就是废话，只留传输方式/CDN
  if (qualityName && label.startsWith(qualityName)) {
    label = label.slice(qualityName.length).replace(/^[\s·]+/, '');
  }
  return label || `线路 ${index + 1}`;
}

/**
 * 清晰度和线路合并进同一个弹出菜单：按钮上只显示当前档位，
 * 选项用按钮列表渲染（原来的两个 <select> 常驻要占 177px，图标化后不必再挤）。
 */
function renderQualityControls() {
  const btn = $('#qualityBtn');
  const qualityList = $('#qualityOptions');
  const lineList = $('#lineOptions');

  if (player.qualities.length) {
    const current = player.quality || player.qualities[0].id;
    qualityList.innerHTML = player.qualities
      .map(
        (q) =>
          `<button type="button" data-quality="${escapeHTML(q.id)}" class="${q.id === current ? 'is-active' : ''}">${escapeHTML(q.name)}</button>`,
      )
      .join('');
    btn.textContent = player.qualities.find((q) => q.id === current)?.name || '自动';
    btn.disabled = player.qualities.length < 2;
  } else {
    qualityList.innerHTML = '<button type="button" class="is-active" disabled>自动</button>';
    btn.textContent = '自动';
    btn.disabled = true;
  }

  const lines = currentQualityStreams();
  if (player.line >= lines.length) player.line = 0;
  $('#lineTitle').hidden = lines.length < 2;
  lineList.innerHTML = lines
    .map(
      (stream, index) =>
        `<button type="button" data-line="${index}" class="${index === player.line ? 'is-active' : ''}">${escapeHTML(lineLabel(stream, index))}</button>`,
    )
    .join('');
}

function showQualityHint(text) {
  const node = $('#qualityHint');
  node.textContent = text || '';
  node.hidden = !text;
}

async function loadWatchRoom(room, options = {}) {
  const requestId = ++player.requestId;
  // 优先用这个直播间上次选的清晰度，其次才是同平台的通用偏好
  await loadRoomPrefs();
  const preferred =
    options.quality ?? readRoomPrefs(room.key)?.quality ?? readQualityPreference(room.platform);
  clearPlayerEngine();
  showPlayerMessage('正在获取直播流…');

  try {
    const data = await api(resolveUrl(room, preferred));
    if (requestId !== player.requestId) return;
    Object.assign(room, {
      title: data.title || room.title,
      anchor: data.anchor || room.anchor,
      cover: data.cover || room.cover,
      area: data.area || room.area,
      live: !!data.live,
      online: Number(data.online) || room.online || 0,
      lastChecked: Date.now(),
    });
    $('#watchTitle').textContent = roomName(room);
    $('#watchAnchor').textContent = [creatorName(room), room.area].filter(Boolean).join(' · ');
      setWatchAvatar(room);
    $('#watchLiveState').textContent = data.live ? '正在直播' : '暂未开播';
    const cachedRoom = state.rooms.find((item) => item.key === room.key);
    if (cachedRoom) Object.assign(cachedRoom, room);
    if (!data.live) {
      $('#playerMessage').classList.add('is-error');
      showPlayerMessage('主播当前未开播', 'error');
      $('#playerStatus').textContent = '暂未开播';
      scheduleOfflineRetry(room);
      render();
      return;
    }

    player.platform = room.platform;
    player.qualities = Array.isArray(data.qualities) ? data.qualities : [];
    player.quality = data.quality || player.qualities[0]?.id || '';
    player.qualityMode = data.qualityMode || 'remote';
    player.streams = Array.isArray(data.streams) ? data.streams : [];
    // 抖音这类在前端过滤档位的平台，清晰度参数不会发给服务端，
    // 上次选过什么只能这里补回去
    const rememberedQuality = readRoomPrefs(room.key)?.quality;
    if (
      player.qualityMode === 'local' &&
      rememberedQuality &&
      player.qualities.some((q) => q.id === rememberedQuality)
    ) {
      player.quality = rememberedQuality;
    }

    renderQualityControls();
    showQualityHint(data.qualityNote || '');
    render();

    if (!player.streams.length) throw new Error('平台没有返回可用播放线路');
    playStream(currentQualityStreams()[0]);
  } catch (error) {
    if (requestId !== player.requestId) return;
    const message = (error.message || '直播流连接失败').slice(0, 80);
    showPlayerMessage(message, 'error');
    $('#watchLiveState').textContent = '连接失败';
    // 虎牙自研取流偶尔会失败：提示原因并自动再试一次（不跳转到平台网页）
    if (room.platform === 'huya') {
      showQualityHint('虎牙直播流暂不可用，正在自动重试…');
      setTimeout(() => {
        if (state.currentRoom?.key === room.key && !$('#watchPage').hidden) {
          player.shortStreams = 0;
          reconnectLiveStream('正在重连虎牙直播流…');
        }
      }, 1500);
    }
  }
}

/** 切换清晰度：抖音本地切，其余平台带参数重新取流 */
async function changeQuality(quality) {
  const room = state.currentRoom;
  if (!room) return;
  saveQualityPreference(room.platform, quality);
  patchRoomPrefs(room.key, { quality });
  if (player.qualityMode === 'local') {
    player.quality = quality;
    renderQualityControls();
    playStream(currentQualityStreams()[0]);
    return;
  }
  await loadWatchRoom(room, { quality });
}

/**
 * 直播看门狗：
 * 1. FLV 追帧时 mpegts 可能把播放器卡在 paused（有数据但不前进），直接拉起来；
 * 2. 虎牙已把 FLV 端点改成「一次性切片」——duration 是个有限值，播完就停，
 *    这种情况反复 play() 没有意义，改成说明原因并切到内嵌平台官方页。
 */
// 直播位置落后直播点的容忍值。
// 注意 HLS 直播的 buffer 本来就领先播放点十几秒（hls.js liveSyncDurationCount=3），
// 阈值设在个位数会导致每轮采样都 seek 一次，画面几秒一卡。
// 这里只兜「真的跑偏了」的情况，正常延迟交给播放器自己维持。
const LIVE_LAG_LIMIT = 60;

/** 直播点：取 seekable/buffered 最后一个区间的末尾 */
function liveEdgeOf(video) {
  const ranges = video.seekable && video.seekable.length ? video.seekable : video.buffered;
  if (!ranges || !ranges.length) return 0;
  return ranges.end(ranges.length - 1);
}

function startPlayWatchdog() {
  stopPlayWatchdog();
  player.lastTime = null;
  player.watchdog = setInterval(() => {
    const video = $('#watchVideo');
    if (!video || !state.currentRoom) return;

    const duration = Number(video.duration);
    // 虎牙的 FLV 连接会被服务端在固定时长后关掉（实测 127.7s），
    // duration 从 Infinity 变成有限值就是信号。播到末尾如果不做处理，
    // 播放器会 seek 回 0 重播 —— 这就是「看几分钟倒退回几分钟前、延迟 100s」。
    //
    // 但不能只看「duration 有限」：B站的 HLS 直播 duration 也是有限值，
    // 只不过它会一直增长（17→77→137→197…）。所以再加一条「duration 停住不动」，
    // 才算是分片流真的结束了。
    if (duration !== player.lastDuration) {
      player.lastDuration = duration;
      player.durationStableAt = Date.now();
    }
    const finite =
      Number.isFinite(duration) &&
      duration > 0 &&
      duration < 600 &&
      Date.now() - (player.durationStableAt || 0) > 12000 &&
      video.currentTime >= duration - 1.5;
    if (finite) {
      stopPlayWatchdog();
      handleFiniteStream(duration);
      return;
    }

    if (video.paused && video.readyState >= 3) video.play().catch(() => {});

    const edge = liveEdgeOf(video);
    if (!edge) { player.lastTime = video.currentTime; return; }

    // 连续 1 分钟健康播放就重置「短片段」计数（借鉴 simple_live 的做法）：
    // 周期性断流恢复后不该被历史失败连坐——否则几次断流之后就被误判
    // 「线路不行」退去官方页，但其实每次都恢复得好好的。
    if (!video.paused && video.readyState >= 3) {
      if (!player.healthySince) player.healthySince = Date.now();
      else if (Date.now() - player.healthySince >= 60000 && player.shortStreams) {
        player.shortStreams = 0;
        console.info('[player] 播放已稳定 60s，重置重连失败计数');
      }
    } else {
      player.healthySince = 0;
    }

    // 播放位置倒退（流被重新加载 / buffer 被清掉后回到旧位置）：直接拉回直播点。
    // 这是「看了几分钟突然退回几分钟前」的那个症状，不管上游怎么变，位置不能往回走。
    if (player.lastTime !== null && video.currentTime < player.lastTime - 10 && video.currentTime < edge - 10) {
      console.warn('[player] 播放位置倒退', player.lastTime.toFixed(1), '→', video.currentTime.toFixed(1));
      if (Number.isFinite(duration) && duration > 0) {
        // 分片流从头重播：seek 回切片末尾没有意义（那里没新数据了），只能重新取流
        stopPlayWatchdog();
        reconnectLiveStream('播放位置回退，正在重新连接…');
        return;
      }
      video.currentTime = Math.max(0, edge - 0.5);
      player.lastTime = video.currentTime;
      return;
    }

    // 缓冲越积越多（延迟持续增大）：连续几轮都超阈值才追，避免网络抖动时误跳。
    // 落点留 3 秒余量，直接跳 buffer 最末端会落在未缓冲区，反而卡一下。
    if (edge - video.currentTime > LIVE_LAG_LIMIT) {
      player.lagHits = (player.lagHits || 0) + 1;
      if (player.lagHits >= 3) {
        player.lagHits = 0;
        video.currentTime = Math.max(0, edge - 3);
        player.lastTime = video.currentTime;
        return;
      }
    } else {
      player.lagHits = 0;
    }
    player.lastTime = video.currentTime;
  }, 2500);
}

// 重连节流：分片流会周期性结束，别让重连本身变成风暴
let lastReconnectAt = 0;

// ---- 缓冲监控（不调倍速）----
// 不做 playbackRate 微调：起播就是 1.0 倍速，视频按原速播放。
// 只保留一件事——缓冲持续见底时降一档清晰度，避免真的卡死。
// 缓冲厚度交给起播预缓冲（stash）和自然积累决定。
// 起播预缓冲（KB）：码率越高、下发越不稳的平台给得越厚
const STASH_BY_PLATFORM = { douyin: 6144, bilibili: 4096, huya: 3072, douyu: 3072 };
const BUF_STALL = 1.2;     // 低于此值视为见底
const BUF_STALL_MS = 8000; // 持续这么久就降档

let bufferTimer;
function startBufferController() {
  stopBufferController();
  bufferTimer = setInterval(tunePlaybackRate, 1000);
}
function stopBufferController() {
  clearInterval(bufferTimer);
  bufferTimer = null;
}

function tunePlaybackRate() {
  const video = $('#watchVideo');
  if (!video || !state.currentRoom) return;
  const ranges = video.buffered;
  if (!ranges || !ranges.length) return;
  const depth = ranges.end(ranges.length - 1) - video.currentTime;
  if (!Number.isFinite(depth) || depth <= 0) return;

  if (depth < BUF_STALL) {
    player.lowBufferSince = player.lowBufferSince || Date.now();
    if (Date.now() - player.lowBufferSince > BUF_STALL_MS) {
      player.lowBufferSince = 0;
      degradeQuality();
    }
  } else {
    player.lowBufferSince = 0;
  }
}

// ---- 卡顿取证 ----
// 开发机上复现不出来的卡顿，靠现场数据定位。
// 每 0.5 秒采一次播放状态；画面停住 ≥0.8 秒、或播放器等数据（waiting）、
// 或缓冲快见底，就把前后 30 秒的状态发到本地服务落盘。
// 只写本地文件、不上传：userData/data/diagnostics.jsonl
const DIAG_SAMPLE_MS = 500;
const DIAG_FREEZE_MS = 800;
const DIAG_MAX = 60;          // 单次观看最多记这么多条，防刷

let diagTimer;
let diagPeriodic;
let diagFrameId;
function startStallProbe() {
  stopStallProbe();
  player.diagRing = [];
  player.diagFrozenSince = 0;
  player.diagLastAt = {};
  player.diagCount = 0;
  player.diagBufferLow = 99;
  diagTimer = setInterval(samplePlayback, DIAG_SAMPLE_MS);
  startFrameProbe();
  // 每 60 秒记一条「一切正常」的快照：万一用户说卡但我们没抓到事件，
  // 也能从这些快照看出缓冲是一直很薄还是偶发见底
  diagPeriodic = setInterval(() => reportEvent('periodic'), 60_000);
}

/**
 * 按帧计时：0.5 秒采样只能发现 0.5 秒以上的冻结，
 * 而「卡一下」经常只有 100~300ms（掉几帧）。requestVideoFrameCallback
 * 能拿到每一帧真正上屏的时刻，用它统计帧间隔，才能量化这种轻微顿挫。
 */
function startFrameProbe() {
  const video = $('#watchVideo');
  player.frameStats = { since: Date.now(), frames: 0, over100: 0, over200: 0, maxGap: 0, last: 0 };
  if (!video?.requestVideoFrameCallback) return;
  const onFrame = (now) => {
    const st = player.frameStats;
    if (!st) return;
    if (st.last) {
      const gap = now - st.last;
      st.frames += 1;
      if (gap > 100) st.over100 += 1;
      if (gap > 200) st.over200 += 1;
      if (gap > st.maxGap) st.maxGap = Math.round(gap);
    }
    st.last = now;
    diagFrameId = video.requestVideoFrameCallback(onFrame);
  };
  diagFrameId = video.requestVideoFrameCallback(onFrame);
}

function stopStallProbe() {
  clearInterval(diagTimer);
  clearInterval(diagPeriodic);
  diagTimer = null;
  diagPeriodic = null;
  const video = $('#watchVideo');
  if (diagFrameId && video?.cancelVideoFrameCallback) {
    try { video.cancelVideoFrameCallback(diagFrameId); } catch {}
  }
  diagFrameId = null;
  player.frameStats = null;
  player.diagRing = [];
  player.diagFrozenSince = 0;
}

function samplePlayback() {
  const video = $('#watchVideo');
  if (!video || !state.currentRoom) return;
  const ranges = video.buffered;
  const edge = ranges && ranges.length ? ranges.end(ranges.length - 1) : 0;
  const depth = edge - video.currentTime;
  const quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
  const row = {
    t: +video.currentTime.toFixed(2),
    depth: +depth.toFixed(2),
    rate: video.playbackRate,
    rs: video.readyState,
    drop: quality.droppedVideoFrames || 0,
  };

  const prev = player.diagRing[player.diagRing.length - 1];
  player.diagRing.push(row);
  if (player.diagRing.length > 60) player.diagRing.shift();   // 30 秒窗口
  if (depth >= 0 && depth < player.diagBufferLow) player.diagBufferLow = +depth.toFixed(2);
  if (depth > 3) player.diagBufferLow = 99;                   // 恢复了就重置

  const now = Date.now();
  // 播放头不动 = 画面停住（暂停不算）
  if (!video.paused && prev && Math.abs(row.t - prev.t) < 0.2) {
    if (!player.diagFrozenSince) player.diagFrozenSince = now;
    const frozen = now - player.diagFrozenSince;
    if (frozen >= DIAG_FREEZE_MS) {
      reportEvent('freeze', { frozeMs: frozen });
      player.diagFrozenSince = 0;   // 记一次就重置，避免停 5 秒记 10 条
    }
  } else {
    player.diagFrozenSince = 0;
  }
}

/** 把现场状态报给本地服务，便于离线分析 */
function reportEvent(kind, extra = {}) {
  const room = state.currentRoom;
  const video = $('#watchVideo');
  if (!room || !video) return;
  // 起播瞬间必然有一次 waiting（缓冲还在建），那是正常的，不算卡顿
  if (kind === 'waiting' && video.currentTime < 3) return;
  const now = Date.now();
  // 同类型事件 4 秒内只记一条，防止抖动期刷屏
  const gap = kind === 'periodic' ? 30_000 : 4000;
  if (now - (player.diagLastAt?.[kind] || 0) < gap) return;
  if ((player.diagCount || 0) >= DIAG_MAX) return;
  player.diagLastAt = player.diagLastAt || {};
  player.diagLastAt[kind] = now;
  player.diagCount = (player.diagCount || 0) + 1;

  const ranges = video.buffered;
  const depth = ranges && ranges.length ? ranges.end(ranges.length - 1) - video.currentTime : 0;
  const quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
  // 帧统计：报告后重置，得到「这一分钟里掉帧几次」的增量
  const st = player.frameStats;
  let frameStats = null;
  if (st) {
    const secs = (now - st.since) / 1000;
    frameStats = {
      secs: +secs.toFixed(0),
      frames: st.frames,
      fps: secs > 0 ? +(st.frames / secs).toFixed(1) : 0,
      hitch100: st.over100,
      hitch200: st.over200,
      maxGap: st.maxGap,
    };
    st.since = now; st.frames = 0; st.over100 = 0; st.over200 = 0; st.maxGap = 0;
  }

  const payload = {
    kind,
    platform: room.platform,
    roomId: room.roomId,
    quality: player.qualities?.find((q) => String(q.id) === String(player.quality))?.name || player.quality,
    line: player.streams?.[player.line]?.name || '',
    engine: player.flv ? 'flv' : player.hls ? 'hls' : 'none',
    depth: +depth.toFixed(2),
    bufferLow: player.diagBufferLow === 99 ? null : player.diagBufferLow,
    rate: video.playbackRate,
    paused: video.paused,
    dropped: quality.droppedVideoFrames || 0,
    video: { w: video.videoWidth, h: video.videoHeight, dpr: devicePixelRatio, win: `${innerWidth}x${innerHeight}` },
    speed: player.flv?.statisticsInfo?.speed ?? null,
    frames: frameStats,
    focused: document.hasFocus(),
    visible: document.visibilityState,
    ...extra,
    sample: player.diagRing.slice(-30),
  };
  fetch('/api/diagnostics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

// ---- 自动降档：卡顿优先于画质 ----
// 45 秒内出现 3 次「等数据」就认为这档码率超出网络能力，自动降一档。
// 用户的原则是「第一优先不卡」，所以不加确认，直接降并提示一次。
const STARVE_WINDOW = 45_000;
const STARVE_LIMIT = 3;

function onPlaybackStarved() {
  const video = $('#watchVideo');
  if (!state.currentRoom || !video) return;
  reportEvent('waiting');
  // 刚起播/切档时的 waiting 属正常，播放头还没走起来就不算
  if (video.currentTime < 5) return;
  if (player.clearing || player.reconnecting || player.degrading) return;

  const now = Date.now();
  player.starveMarks = (player.starveMarks || []).filter((t) => now - t < STARVE_WINDOW);
  player.starveMarks.push(now);
  if (player.starveMarks.length < STARVE_LIMIT) return;
  player.starveMarks = [];
  degradeQuality();
}

/**
 * 卡顿恢复后追回直播边缘：一次 freeze 会让播放点落后「平时的缓冲厚度」很多，
 * 之后延迟就一直偏大。恢复播放 5 秒（让缓冲重新长出来）后检查一次，
 * 若明显厚于平时的厚度，就一次性 seek 回平时的深度——是一次跳转，不是倍速。
 * 只对 FLV 生效：HLS 引擎有 liveMaxLatency 自己管，且 buffer 天然领先十几秒。
 */
function onPlaybackRecovered() {
  const video = $('#watchVideo');
  if (!state.currentRoom || !video || video.seeking) return;
  if (player.clearing || player.reconnecting || player.hls) return;
  // 起播初期缓冲还在按 stash 目标积累，没有「平时厚度」可言
  if (!player.diagRing || player.diagRing.length < 24) return;
  const roomKey = state.currentRoom.key;
  clearTimeout(player.recoverTimer);
  player.recoverTimer = setTimeout(() => {
    const v = $('#watchVideo');
    if (!state.currentRoom || state.currentRoom.key !== roomKey || !v || v.seeking || v.paused) return;
    if (player.clearing || player.reconnecting || player.hls) return;
    const edge = liveEdgeOf(v);
    if (!edge) return;
    const depth = edge - v.currentTime;
    const rows = player.diagRing.map((r) => r.depth).filter((d) => d > 0.3).sort((a, b) => a - b);
    const base = rows.length ? rows[Math.floor(rows.length / 2)] : 0;
    // 明显厚于平时（多出 5s 以上）才算真的落后了
    if (depth < Math.max(10, base + 5)) return;
    const target = Math.max(0, edge - Math.max(2, base));
    console.info('[player] 卡顿恢复后追回直播边缘：落后', depth.toFixed(1), 's，平时', base.toFixed(1), 's');
    v.currentTime = target;
    player.lastTime = target;
  }, 5000);
}

/** 降到下一档清晰度；已经在最低档就什么都不做 */
function degradeQuality() {
  const room = state.currentRoom;
  if (!room || player.degrading) return;
  const list = player.qualities || [];
  const idx = list.findIndex((q) => String(q.id) === String(player.quality));
  if (idx < 0 || idx >= list.length - 1) {
    if (list.length) showQualityHint('网络持续跟不上，已经在最低清晰度了');
    return;
  }
  const next = list[idx + 1];
  player.degrading = true;
  showQualityHint(`网络跟不上，已自动切到「${next.name}」以保证不卡顿`);
  // 临时降档：不写偏好、不改用户设置，下次进来还是他自己选的清晰度
  player.quality = next.id;
  renderQualityControls();
  Promise.resolve(loadWatchRoom(room, { quality: next.id })).finally(() => {
    // 给新档位一段稳定期，避免网络抖动时一路降到最低
    setTimeout(() => { player.degrading = false; }, 20_000);
  });
}

/**
 * 分片流结束（或播放位置往回跳）时重新取流。
 * 以前是直接切到内嵌官方页——但那等于放弃原生播放器；
 * 实测虎牙每段约 127s，重连一次只要 1~2 秒，比倒退两分钟强得多。
 */
async function reconnectLiveStream(reason) {
  const room = state.currentRoom;
  if (!room) return;
  if (player.reconnecting) return;
  if (Date.now() - lastReconnectAt < 2500) return;
  lastReconnectAt = Date.now();
  player.reconnecting = true;
  // 留出重连 + 起播的时间窗，期间的错误事件不再触发新一轮重连
  setTimeout(() => { player.reconnecting = false; }, 8000);

  player.shortStreams = (player.shortStreams || 0) + 1;
  // 连续几次都只给很短的片段，说明这条线路质量不行，退回官方页
  if (player.shortStreams >= 4) {
    handleFiniteStream(0, '连续多次只拿到很短的片段');
    return;
  }

  showQualityHint(reason || '正在重新连接直播流…');
  player.line = 0;
  await loadWatchRoom(room);
}

function handleFiniteStream(duration, note) {
  const room = state.currentRoom;
  if (!room) return;

  // 片段太短（< 90s）说明重连也看不了几秒，直接给官方页兜底
  if (duration && duration < 90 && IS_DESKTOP) {
    player.shortStreams = 4;
  }
  if (player.shortStreams >= 4) {
    $('#playerStatus').textContent = '线路不稳定';
    showQualityHint(
      `${note || `这条线路一次只下发 ${Math.round(duration)} 秒`}，正在自动重连…`,
    );
    player.shortStreams = 0;   // 计数清零，避免一直卡在"不稳定"状态
    setTimeout(() => {
      if (state.currentRoom?.key === room.key && !$('#watchPage').hidden) {
        reconnectLiveStream('线路不稳定，正在重新连接…');
      }
    }, 900);
    return;
  }
  reconnectLiveStream(`线路分片结束（${Math.round(duration)}s），正在重新连接…`);
}

function stopPlayWatchdog() {
  clearInterval(player.watchdog);
  player.watchdog = null;
}

function playStream(stream) {
  if (!stream) return;
  clearOfflineTimer();
  clearPlayerEngine();
  const video = $('#watchVideo');
  // 首次进入静音（避免突然出声）；用户自己调过之后就尊重他的选择，重连不再强制静音
  if (!player.soundUserSet) video.muted = true;
  syncSoundUI();
  showPlayerMessage('正在连接直播流…');
  const ready = () => {
    video.play().catch(() => {});
    $('#playerStatus').textContent = '正在播放';
    $('#playerMessage').classList.add('is-hidden');
    syncPlayUI();
    bumpPlayerBar();
    startPlayWatchdog();
  };
  video.addEventListener('playing', ready, { once: true });

  if (stream.type === 'hls') {
    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({
        // Electron 渲染进程里 hls.js 的 blob worker 建不起来，会静默卡在 readyState 0，
        // 桌面端直接在主线程 demux（1080p 直播足够用）
        enableWorker: !IS_DESKTOP,
        lowLatencyMode: false,
        // 直播以「不卡」为第一优先，延迟稳定即可：留 5 个分片的缓冲（约 15-20s），
        // 网络抖一下也不会把 buffer 吃干净。原来的 3 个分片贴着边缘播，一波动就顿。
        liveSyncDurationCount: 5,
        // 允许延迟在 5~12 个分片之间浮动，别因为稍微落后就强行跳回直播点
        liveMaxLatencyDurationCount: 12,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
      });
      player.hls = hls;
      hls.loadSource(stream.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, ready);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal) return void console.warn('[hls]', data?.details, data?.reason || '');
        if (player.clearing || player.reconnecting) return;
        // 抖音这类流的地址有效期有限，播久了会 manifest/分片失败；
        // 直接重新解析取一份新地址，比让用户手动点「重连」强
        console.warn('[hls] 致命错误，尝试自动重连:', data?.details);
        showPlayerMessage('直播流中断，正在自动重连…', 'error');
        reconnectLiveStream('直播流中断，正在自动重连…');
      });
    } else {
      video.src = stream.url;
      video.addEventListener('loadedmetadata', ready, { once: true });
      video.addEventListener('error', () => showPlayerMessage('浏览器无法播放此 HLS 线路', 'error'), { once: true });
    }
  } else if (stream.type === 'flv' && window.mpegts && mpegts.isSupported()) {
    const flv = mpegts.createPlayer({ type: 'flv', isLive: true, url: stream.url }, {
      // 注：mpegts 的 worker 在 Electron 渲染进程里同样建不起来（实测开了直接起播失败），
      // demux 只能留在主线程，所以高码率流的性能上限要靠在清晰度上让一步
      //
      // 重新打开 stash buffer：之前为了让延迟不累积把它关了，结果是数据直通 MSE，
      // 主线程一忙就供不上，画面「停住等一会儿再跳」。
      // 开回来让 mpegts 自己攒一段再喂，平稳得多；多出来的延迟用户已明确可接受。
      enableStashBuffer: true,
      // 起播预缓冲按平台给：同一份 3MB 在不同码率下换算出的秒数差很多。
      // 实测（家庭网络）：虎牙 3MB≈7s、斗鱼≈4.5s、B站原画≈2s、抖音原画常常 0.5~1.4s
      // ——抖音码率最高且下发节奏最不均（同一房间缓冲能从 0.05s 跳到 18s），给厚一点。
      stashInitialSize: STASH_BY_PLATFORM[state.currentRoom?.platform] || 3072,
      lazyLoad: false,
      autoCleanupSourceBuffer: true,
      liveBufferLatencyChasing: true,
      // 直接关掉 mpegts 自带的追帧：实测它不管把 maxLatency/minRemain 配成多少，
      // 都会把延迟压到 0~3 秒，缓冲薄得没有抗抖动空间，网络一抖就顿。
      // 直播第一优先是「不卡」，延迟稳定即可 —— 交给缓冲自然增长，
      // 只有真的跑偏（落后直播点 60 秒）才由看门狗兜一次。
      liveBufferLatencyChasing: false,
    });
    player.flv = flv;
    flv.attachMediaElement(video);
    flv.load();
    flv.on(mpegts.Events.MEDIA_INFO, ready);
    flv.on(mpegts.Events.ERROR, () => showPlayerMessage('FLV 线路中断，请点击「重连」', 'error'));
  } else {
    showPlayerMessage('当前浏览器不支持平台返回的播放格式', 'error');
  }
}

function setDanmakuOverlay(enabled) {
  player.overlay = enabled;
  $('#danmakuOverlay').classList.toggle('is-visible', enabled);
  // 「弹」字按钮：开启时高亮，关闭时压一道斜杠（样式在 CSS 里）
  $('#toggleOverlay').classList.toggle('is-on', enabled);
  $('#toggleOverlay').title = enabled ? '关闭悬浮弹幕' : '开启悬浮弹幕';
  patchRoomPrefs(currentRoomKey(), { overlay: enabled });
}

/* ---------------- 控制条弹出层 ---------------- */

/** 同时只允许一个弹出层展开 */
function closePlayerPopovers(exceptId) {
  for (const menu of document.querySelectorAll('.player-menu.is-open')) {
    if (exceptId && menu.id === exceptId) continue;
    menu.classList.remove('is-open');
    const pop = menu.querySelector('.player-pop');
    if (pop) pop.hidden = true;
    const trigger = menu.querySelector('[aria-haspopup]');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }
}

function togglePlayerPopover(menuId) {
  const menu = document.getElementById(menuId);
  if (!menu) return;
  const opening = !menu.classList.contains('is-open');
  closePlayerPopovers(menuId);
  menu.classList.toggle('is-open', opening);
  const pop = menu.querySelector('.player-pop');
  if (pop) pop.hidden = !opening;
  const trigger = menu.querySelector('[aria-haspopup]');
  if (trigger) trigger.setAttribute('aria-expanded', String(opening));
}

/* ---------------- 小窗模式（画中画） ---------------- */

/**
 * 浏览器要求 requestPictureInPicture 必须由用户手势触发，
 * 所以只能在点击回调里调；脚本直接调会报 NotAllowedError。
 */
async function togglePictureInPicture() {
  const video = $('#watchVideo');
  try {
    if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch (error) {
    toast(error.message || '当前环境不支持小窗模式');
  }
}

function bindPictureInPicture() {
  const video = $('#watchVideo');
  const button = $('#togglePip');
  if (!document.pictureInPictureEnabled) {
    button.disabled = true;
    button.title = '当前环境不支持小窗模式';
    return;
  }
  const sync = () => {
    const active = document.pictureInPictureElement === video;
    button.classList.toggle('is-active', active);
    button.title = active ? '退出小窗' : '小窗模式';
  };
  video.addEventListener('enterpictureinpicture', sync);
  video.addEventListener('leavepictureinpicture', sync);
}

/* ---------------- 全屏 ----------------
 * 全屏的目标必须是 .watch-player 这个容器，不能是 <video> 元素本身：
 * 元素全屏时只有它自己进入浏览器的 top layer，兄弟节点（弹幕浮层）渲染不出来。
 * 所以自己的按钮直接全屏容器；同时兜住「用户点了原生控制条的全屏按钮」这种情况。
 */
function enterFullscreen() {
  const stage = $('#watchPlayer');
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  stage.requestFullscreen?.().catch(() => {
    // 容器全屏被拒时至少还能用视频自己的全屏，只是弹幕浮层会丢失
    $('#watchVideo').requestFullscreen?.().catch(() => {});
  });
}

function syncFullscreenButton() {
  const button = $('#toggleFullscreen');
  const stage = $('#watchPlayer');
  const active = document.fullscreenElement && document.fullscreenElement === stage;
  button.textContent = active ? '退出全屏' : '全屏';
}

/**
 * 原生控制条的全屏按钮会把 <video> 自己送进全屏。发现这种情况就退出来，
 * 换成容器全屏，弹幕浮层才能继续可见。会有一帧闪烁，但换来浮层不丢。
 */
function hijackVideoFullscreen() {
  document.addEventListener('fullscreenchange', () => {
    const video = $('#watchVideo');
    const stage = $('#watchPlayer');
    if (document.fullscreenElement === video && stage) {
      document
        .exitFullscreen()
        .then(() => stage.requestFullscreen())
        .catch(() => {
          /* 没有用户手势时可能被拒，那就保持视频全屏，只是没有浮层 */
        });
    }
    syncFullscreenButton();
  });
}

/* ---------------- 自定义播放控制条 ---------------- */

/** 静音按钮和音量滑块要保持同步，两边都能改 */
function syncSoundUI() {
  const video = $('#watchVideo');
  const silent = video.muted || video.volume === 0;
  // 图标是两套并存，靠控制条上的状态类切换；可读文案放 title/aria
  $('#playerBar').classList.toggle('is-muted', silent);
  $('#toggleSound').title = silent ? '开启声音' : '静音';
  $('#toggleSound').setAttribute('aria-label', silent ? '开启声音' : '静音');
  $('#volumeRange').value = String(video.muted ? 0 : video.volume);
  paintRange($('#volumeRange'));
}

/** 清掉算出来的尺寸再立刻按当前可用空间铺一次（换房间时用） */
function resetPlayerSize() {
  const stage = $('#watchPlayer');
  if (!stage) return;
  stage.style.width = '';
  stage.style.height = '';
  // 只清不铺的话，.watch-player 会退回 CSS 的 width:100% + 16:9，
  // 在宽窗口里就是一大块黑底，等元数据回来再缩，看起来就是「进房先黑一下」。
  syncPlayerAspect();
}

/**
 * 播放器在可用空间里取最大。
 * 宽度和高度都得顾：只按宽度推高度，遇到竖屏流会顶出可视区；
 * 只按高度推宽度又可能超出可用宽度。取两者较小的那个，
 * 容器严格等于视频比例 —— 既无黑边也不裁切，还尽量占满区域。
 * 极端比例收敛一下，免得竖屏直播把播放器撑成一根长条。
 */
function syncPlayerAspect() {
  const video = $('#watchVideo');
  const stage = $('#watchPlayer');
  if (!stage || !video) return;
  const { videoWidth: w, videoHeight: h } = video;
  // 元数据还没回来时先按 16:9 铺满可用空间：这样容器大小从一开始就是对的，
  // 不会出现「先给一块 100% 宽的黑底、拿到尺寸再缩」的跳变。
  // 下限放到 0.5：抖音这类手机竖屏直播常见 9:16(0.56)，卡在 0.8 会左右各留 15% 黑边。
  // 高度已经由 min(可用宽/比例, 可用高) 兜住，竖屏不会顶出可视区，放心放开。
  const ratio = w && h ? Math.min(Math.max(w / h, 0.5), 2.8) : 16 / 9;
  const column = stage.parentElement; // .player-column
  const availW = column?.clientWidth || stage.clientWidth;
  const availH = column?.clientHeight || 0;
  if (!availW) return;
  const byWidth = availW / ratio;
  const height = availH ? Math.min(byWidth, availH) : byWidth;
  const width = height * ratio;
  stage.style.width = `${Math.round(width)}px`;
  stage.style.height = `${Math.round(height)}px`;
}



/** 播放/暂停图标跟着实际状态走 */
function syncPlayUI() {
  const paused = $('#watchVideo').paused;
  $('#playerBar').classList.toggle('is-paused', paused);
  $('#togglePlay').title = paused ? '播放' : '暂停';
  $('#togglePlay').setAttribute('aria-label', paused ? '播放' : '暂停');
  // 状态圆点：播放中转成主题绿，停住时是琥珀色（之前这个类一直没人加，圆点不变色）
  $('#playerBar').querySelector('.player-live-state')?.classList.toggle('is-playing', !paused);
}

let idleTimer;
/** 鼠标停下 2.6 秒后控制条隐身，别长期压着画面 */
function bumpPlayerBar() {
  const stage = $('#watchPlayer');
  if (!stage) return;
  stage.classList.remove('is-idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const video = $('#watchVideo');
    // 暂停时不隐身（否则用户摸不到按钮）；触屏设备也不隐身（没有 hover，唤不回来）
    if (window.matchMedia?.('(hover: hover)').matches === false) return;
    if (video && !video.paused && !video.ended) stage.classList.add('is-idle');
  }, 2600);
}

function setupPlayerBarAutoHide() {
  const stage = $('#watchPlayer');
  if (!stage) return;
  stage.addEventListener('pointermove', bumpPlayerBar);
  stage.addEventListener('pointerleave', () => {
    if (!$('#watchVideo').paused) stage.classList.add('is-idle');
  });
  bumpPlayerBar();
}

/**
 * 直播没有「进度」可言：MSE 流的 video.duration 一直在增长，
 * 画成进度条就会不停重算百分比持续抖动。改成显示缓冲深度（≈直播延迟），
 * 1 秒更新一次、等宽数字，读数是稳的。
 */
let latencyTimer;
function startLatencyProbe() {
  clearInterval(latencyTimer);
  latencyTimer = setInterval(() => {
    const video = $('#watchVideo');
    const node = $('#playerLatency');
    if (!video || !node) return;
    const buffered = video.buffered;
    if (!buffered || !buffered.length || !Number.isFinite(video.currentTime)) {
      node.hidden = true;
      return;
    }
    const lag = buffered.end(buffered.length - 1) - video.currentTime;
    if (!Number.isFinite(lag) || lag < 0 || lag > 120) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.textContent = `延迟 ${lag.toFixed(1)}s`;
  }, 1000);
}

let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), 2600);
}

/**
 * 应用内确认弹窗，替代突兀的 window.confirm。
 * 返回 Promise<boolean>：点确认 true，取消 / Esc / 点遮罩 false。
 */
function confirmDialog({ title = '确认操作', text = '', confirmText = '确认' } = {}) {
  const overlay = $('#confirmModal');
  if (!overlay) return Promise.resolve(false);
  $('#modalTitle').textContent = title;
  $('#modalText').textContent = text;
  $('#modalConfirm').textContent = confirmText;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('is-open'));
  $('#modalConfirm').focus();

  return new Promise((resolve) => {
    const close = (result) => {
      overlay.classList.remove('is-open');
      setTimeout(() => { overlay.hidden = true; }, 160);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (event) => { if (event.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);
    $('#modalConfirm').onclick = () => close(true);
    $('#modalCancel').onclick = () => close(false);
    overlay.onclick = (event) => { if (event.target === overlay) close(false); };
  });
}

/* ---------------- 平台账号 ---------------- */

async function loadAccounts() {
  try {
    state.accounts = await api('/api/accounts');
    renderAccountEntry();
    if (!$('#accountMask').hidden) renderAccountList();
    // 账号变了，弹幕输入框的可用性也要跟着变（登录/登出都会影响能否发送）
    if (state.currentRoom && danmaku.lastStatus) applySendCapability(state.currentRoom, danmaku.lastStatus);
  } catch {
    /* 账号接口异常不影响主播库与播放 */
  }
}

function renderAccountEntry() {
  const logged = state.accounts.filter((account) => account.loggedIn);
  const dot = $('#accountDot');
  dot?.classList.toggle('is-on', logged.length > 0);
  dot?.classList.toggle('is-empty', logged.length === 0);
  const label = $('#accountLabel');
  const count = $('#accountCount');
  const pill = $('#openAccounts');
  if (label) label.textContent = '平台账号';
  if (count) count.textContent = logged.length ? `· ${logged.length}` : '· 未登录';
  if (pill) {
    pill.title = logged.length
      ? `${logged.map((account) => account.name).join(' · ')}（点击管理）`
      : '还没有登录平台账号，点击登录后可解锁原画与弹幕';
  }
}

function renderAccountList() {
  const list = $('#accountList');
  list.innerHTML = state.accounts
    .map((account) => {
      const status = account.loggedIn
        ? `${account.nickname ? escapeHTML(account.nickname) : '已登录'}${
            account.cookieCount ? ` · ${account.cookieCount} 项 Cookie` : ''
          }`
        : '未登录 · 原画与部分弹幕受限';
      // 已登录也给一个「重登」入口：登录态过期时不用先退出再来一次
      const action = account.loggedIn
        ? `<button type="button" data-login="${account.platform}" data-relogin="1" title="登录态过期时可重新扫码">重登</button>
           <button type="button" class="danger" data-logout="${account.platform}">退出</button>`
        : `<button type="button" class="primary" data-login="${account.platform}">登录</button>`;
      return `
        <div class="account-card ${account.loggedIn ? 'is-on' : ''}">
          <span class="account-badge" style="background:${account.color || '#8b90a0'}">${escapeHTML(
            account.name.slice(0, 1),
          )}</span>
          <div class="account-body">
            <b>${escapeHTML(account.name)}</b>
            <small>${status}</small>
          </div>
          <div class="account-actions">${action}</div>
        </div>`;
    })
    .join('');
}

function openAccounts() {
  $('#accountMask').hidden = false;
  renderAccountList();
  loadAccounts();
}

function closeAccounts() {
  $('#accountMask').hidden = true;
}

async function loginPlatform(platform, options = {}) {
  const account = state.accounts.find((item) => item.platform === platform);

  // 桌面端：开一个平台登录窗口，登录完成会自动把 cookie 同步过来
  if (window.livehub?.login) {
    try {
      const result = await window.livehub.login(platform, options);
      if (!result?.ok) return toast(result?.error || '无法打开登录窗口');
      if (options.reload) toast(`已重新打开${account?.name || platform}登录窗口`);
    } catch (error) {
      return toast(error.message || '登录窗口打开失败');
    }
    return;
  }

  // 浏览器模式没有 Electron 会话，只能手动粘 Cookie
  const cookie = window.prompt(
    `浏览器模式打不开平台登录窗口。\n请先在浏览器登录 ${account?.name || platform}，` +
      `再从开发者工具（Application → Cookies）复制整份 Cookie 粘贴到这里：`,
  );
  if (!cookie) return;
  try {
    await api(`/api/accounts/${encodeURIComponent(platform)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie }),
    });
    toast('账号已保存');
    await loadAccounts();
  } catch (error) {
    toast(error.message);
  }
}

async function logoutPlatform(platform) {
  try {
    if (window.livehub?.logout) await window.livehub.logout(platform);
    else await api(`/api/accounts/${encodeURIComponent(platform)}`, { method: 'DELETE' });
    toast('已退出该平台账号');
    await loadAccounts();
  } catch (error) {
    toast(error.message);
  }
}

async function addRoom(input) {
  if (state.adding) return;
  state.adding = true;
  $('#addError').textContent = '';
  $('#addForm button').disabled = true;
  try {
    const room = await api('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    const index = state.rooms.findIndex((item) => item.key === room.key);
    if (index === -1) state.rooms.push(room);
    else state.rooms[index] = room;
    state.selectedCreator = creatorKey(room);
    state.platform = 'all';
    $('#addInput').value = '';
    render();
    toast(room.pending ? '房间已保存，平台信息暂时不可用' : '已导入主播，房间卡片已更新');
  } catch (error) {
    $('#addError').textContent = error.message;
  } finally {
    state.adding = false;
    $('#addForm button').disabled = false;
  }
}

async function init() {
  window.addEventListener('hashchange', handleRoute);

  // ---- 外观与侧栏：先按存储恢复，再绑交互 ----
  state.theme = readStoredTheme();
  try { state.rail = localStorage.getItem(RAIL_KEY) === '1'; } catch { state.rail = false; }
  applyTheme();
  applyRail();
  themeQuery.addEventListener('change', () => {
    if (state.theme === 'follow') applyTheme();
  });
  $('#themeBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleThemeMenu();
  });
  $('#themeMenu').addEventListener('click', (event) => {
    const item = event.target.closest('[data-theme-mode]');
    if (!item) return;
    setTheme(item.dataset.themeMode);
    toggleThemeMenu(false);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#themeMenu') && !event.target.closest('#themeBtn')) toggleThemeMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toggleThemeMenu(false);
  });
  $('#railToggle').addEventListener('click', () => {
    state.rail = !state.rail;
    try { localStorage.setItem(RAIL_KEY, state.rail ? '1' : '0'); } catch { /* 忽略 */ }
    applyRail();
  });
  $('#streamerList').addEventListener('scroll', hideRailTip, { passive: true });

  // ---- 特别关注：收起状态 + 拖拽投放 ----
  try { state.favCollapsed = localStorage.getItem(FAV_KEY) === '1'; } catch { state.favCollapsed = false; }
  bindSidebarDnd();
  $('#favToggle').addEventListener('click', () => {
    state.favCollapsed = !state.favCollapsed;
    try { localStorage.setItem(FAV_KEY, state.favCollapsed ? '1' : '0'); } catch { /* 忽略 */ }
    renderSidebar();
  });
  // 播放器容器尺寸变了就重新算播放器大小（侧栏折叠、窗口拉伸都会触发）
  const playerColumn = $('.player-column');
  if (playerColumn && typeof ResizeObserver === 'function') {
    let raf = 0;
    const observer = new ResizeObserver(() => {
      if (state.resizing) return;              // 动画期间不逐帧校正，收尾统一算一次
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; syncPlayerAspect(); });
    });
    observer.observe(playerColumn);
  }
  $('#addForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('#addInput').value.trim();
    if (value) addRoom(value);
  });
  $('#searchInput').addEventListener('input', (event) => {
    state.query = event.target.value;
    renderRooms();
  });
  $('#sortSelect').addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderRooms();
  });
  $('#backToCatalog').addEventListener('click', () => {
    location.hash = '#/';
  });
  $('#reloadPlayer').addEventListener('click', () => {
    if (state.currentRoom) loadWatchRoom(state.currentRoom, { quality: player.quality });
  });
  // 清晰度 + 线路合并成一个菜单：点选项直接切换，点按钮本身开合菜单
  $('#qualityBtn').addEventListener('click', () => togglePlayerPopover('qualityMenu'));
  $('#qualityOptions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-quality]');
    if (!button) return;
    closePlayerPopovers();
    changeQuality(button.dataset.quality);
  });
  $('#lineOptions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-line]');
    if (!button) return;
    closePlayerPopovers();
    player.line = Number(button.dataset.line);
    patchRoomPrefs(currentRoomKey(), { line: player.line });
    renderQualityControls();
    playStream(currentQualityStreams()[player.line]);
  });
  $('#togglePip').addEventListener('click', togglePictureInPicture);
  // 弹幕设置面板
  $('#openDanmakuSettings').addEventListener('click', () => togglePlayerPopover('danmakuMenu'));
  $('#dmOpacity').addEventListener('input', (event) => saveDanmakuStyle({ opacity: Number(event.target.value) }));
  $('#dmFontSize').addEventListener('input', (event) => saveDanmakuStyle({ fontSize: Number(event.target.value) }));
  $('#dmSpeed').addEventListener('input', (event) => saveDanmakuStyle({ speed: Number(event.target.value) }));
  for (const id of ['#dmOpacity', '#dmFontSize', '#dmSpeed', '#volumeRange']) wireRange($(id));
  $('#dmArea').addEventListener('click', (event) => {
    const button = event.target.closest('[data-area]');
    if (!button) return;
    saveDanmakuStyle({ area: button.dataset.area });
  });
  // 点菜单外任意处收起
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.player-menu')) closePlayerPopovers();
  });
  $('#openAccounts').addEventListener('click', openAccounts);
  $('#closeAccounts').addEventListener('click', closeAccounts);
  $('#accountMask').addEventListener('click', (event) => {
    if (event.target === $('#accountMask')) closeAccounts();
  });
  $('#refreshAccounts').addEventListener('click', async () => {
    await loadAccounts();
    toast('已重新检测账号状态');
  });
  $('#accountList').addEventListener('click', (event) => {
    const login = event.target.closest('[data-login]');
    if (login) return loginPlatform(login.dataset.login, { reload: login.dataset.relogin === '1' });
    const logout = event.target.closest('[data-logout]');
    if (logout) return logoutPlatform(logout.dataset.logout);
    return undefined;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#accountMask').hidden) closeAccounts();
  });
  // 桌面端登录成功后主进程会广播，这里刷新状态并重连当前房间解锁更高清楚度
  window.livehub?.onAccountsChanged?.(async () => {
    await loadAccounts();
    if (state.currentRoom && !$('#watchPage').hidden) {
      loadWatchRoom(state.currentRoom, { quality: player.quality });
    }
  });
  $('#toggleSound').addEventListener('click', () => {
    const video = $('#watchVideo');
    player.soundUserSet = true;
    video.muted = !video.muted;
    // 取消静音时如果用户之前把音量拉到 0，给回一个默认值，不然还是听不见
    if (!video.muted && video.volume === 0) video.volume = 1;
    syncSoundUI();
    if (!video.muted) video.play().catch(() => {});
  });
  $('#volumeRange').addEventListener('input', (event) => {
    const video = $('#watchVideo');
    player.soundUserSet = true;
    const value = Number(event.target.value);
    video.volume = value;
    video.muted = value === 0;
    syncSoundUI();
  });
  $('#togglePlay').addEventListener('click', () => {
    const video = $('#watchVideo');
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });
  for (const event of ['play', 'pause']) {
    $('#watchVideo').addEventListener(event, () => {
      syncPlayUI();
      bumpPlayerBar();
    });
  }
  // 取到视频尺寸后立刻贴合比例；resize 覆盖 HLS 切清晰度导致的分辨率变化
  for (const event of ['loadedmetadata', 'resize']) {
    $('#watchVideo').addEventListener(event, syncPlayerAspect);
  }
  // FLV/HLS 之外的底层错误（地址过期、连接被掐）也走同一条自愈路径
  $('#watchVideo').addEventListener('error', () => {
    if (!state.currentRoom) return;
    // 拆流/重连过程中的 error 是自找的，不能反过来再触发重连
    if (player.clearing || player.reconnecting) return;
    reconnectLiveStream('播放出错，正在自动重连…');
  });
  // 网络供不上 → 播放器等数据（waiting）。偶尔一次不必管，
  // 短时间内反复出现说明这档码率超出当前网络能力，自动降一档保流畅
  $('#watchVideo').addEventListener('waiting', onPlaybackStarved);
  // 恢复播放（playing）后检查有没有落后直播边缘太多，落后就追回来
  $('#watchVideo').addEventListener('playing', onPlaybackRecovered);
  // 播放器尺寸是按「可用区域 + 视频比例」算出来的，窗口一变就得重算
  window.addEventListener('resize', syncPlayerAspect);
  window.addEventListener('resize', () => { if (!$('#catalog')?.hidden) syncFavOverflow(); });
  setupPlayerBarAutoHide();
  startLatencyProbe();
  loadDanmakuStyle();
  applyDanmakuStyle();
  syncDanmakuSettingsUI();
  bindPictureInPicture();
  $('#toggleOverlay').addEventListener('click', () => setDanmakuOverlay(!player.overlay));
  $('#toggleFullscreen').addEventListener('click', () => enterFullscreen());
  hijackVideoFullscreen();
  // 弹幕列表：点提示回到底部；自己滚回底部也要收起提示

  $('#refreshRooms').addEventListener('click', () => refreshRooms({ force: true, silent: false }));
  $('#danmakuForm').addEventListener('submit', (event) => {
    event.preventDefault();
    submitDanmaku();
  });
  $('#danmakuInput').addEventListener('input', syncSendButton);
  // 图标版按钮不能再写 textContent——那会把整个 SVG 冲掉，按钮直接变回文字。
  // 统一的图标/状态同步都在 syncSoundUI() 里。
  // 音量/静音的任何变化（滑块、按钮、系统快捷键）都记到当前直播间名下
  $('#watchVideo').addEventListener('volumechange', () => {
    syncSoundUI();
    saveSoundPrefs();
  });
  $('#clearAll').addEventListener('click', async () => {
    const total = state.rooms.length;
    if (!total) return;
    // 和移除单个房间走同一个弹窗（原来用的是系统 confirm，样式完全不搭）
    if (!(await confirmDialog({
      title: '清空房间库',
      text: `将从主播库移除全部 ${total} 个房间，之后需要重新导入才能找回。`,
      confirmText: '清空',
    }))) return;
    try {
      await Promise.all(state.rooms.map((room) => api(`/api/rooms/${encodeURIComponent(room.key)}`, { method: 'DELETE' })));
      state.rooms = [];
      state.selectedCreator = 'all';
      state.platform = 'all';
      render();
      toast('已清空房间库');
    } catch (error) {
      toast(error.message);
    }
  });

  loadAccounts();

  try {
    state.rooms = await api('/api/rooms');
  } catch (error) {
    $('#emptyTitle').textContent = '无法读取本地主播库';
    $('#emptyCopy').textContent = error.message;
  }
  render();
  handleRoute();

  // 进页面先把过期的开播状态拉一遍；之后每 3 分钟轮询（页面可见且不在观看页时）
  const needsRefresh = state.rooms.some(
    (room) => !room.lastChecked || Date.now() - room.lastChecked > 60_000,
  );
  if (needsRefresh) refreshRooms({ silent: true });

  setInterval(() => {
    if (document.hidden || !$('#watchPage').hidden) return;
    refreshRooms({ silent: true });
  }, REFRESH_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (Date.now() - state.lastRefreshAt > 60_000) refreshRooms({ silent: true });
  });

  // 关闭 App / 切到后台前，把还没发出去的观看偏好补发掉
  window.addEventListener('pagehide', flushAllRoomPrefs);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushAllRoomPrefs();
  });
}

init();
