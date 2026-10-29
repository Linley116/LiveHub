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
  viewMode: 'native',
  selectedCreator: 'all',
  platform: 'all',
  query: '',
  sort: 'live',
  adding: false,
  currentRoom: null,
  refreshing: false,
  lastRefreshAt: 0,
  accounts: [],
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
  document
    .querySelector('.header-note')
    ?.classList.toggle('is-stale', state.rooms.length > 0 && Date.now() - checkedAt > 15 * 60_000);
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
      groups.set(key, { key, name: creatorName(room), rooms: [], live: false, avatar: '', platform: room.platform, online: 0 });
    }
    const group = groups.get(key);
    group.rooms.push(room);
    // 头像：优先用「正在直播」房间的头像（一般同一个人，但避免离线占位图），否则用第一个
    if (room.avatar && (!group.avatar || room.live)) group.avatar = room.avatar;
    if (room.live) {
      group.live = true;
      group.online = Math.max(group.online, Number(room.online) || 0);
    }
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

  const liveCreators = creators.filter((creator) => creator.live);
  const offlineCreators = creators.filter((creator) => !creator.live);

  const itemHTML = (creator) => {
    const p = platform(creator.platform);
    const img = creator.avatar
      ? `<img class="creator-avatar-img" src="${escapeHTML(creator.avatar)}" alt="" loading="lazy" decoding="async" onerror="this.classList.add('is-broken')">`
      : '';
    // 第二行放直播标题：开播取正在播的房间，未开播取第一个房间；状态只靠右侧圆点表达
    const primaryRoom = creator.live ? (creator.rooms.find((room) => room.live) || creator.rooms[0]) : creator.rooms[0];
    const title = roomName(primaryRoom) || (creator.live ? '直播中' : '未开播');
    const dot = `<span class="nav-dot ${creator.live ? 'is-on' : 'is-off'}" title="${creator.live ? '直播中' : '未开播'}" aria-label="${creator.live ? '直播中' : '未开播'}"></span>`;
    return `<button class="creator-nav ${state.selectedCreator === creator.key ? 'is-selected' : ''} ${creator.live ? 'is-live' : ''}" data-creator="${escapeHTML(creator.key)}">
      <span class="creator-avatar" style="--platform-color:${p.color}">
        ${img}
        <span class="creator-avatar-fallback" aria-hidden="true">${escapeHTML(creator.name.slice(0, 1))}</span>
      </span>
      <span class="nav-body">
        <span class="nav-name" title="${escapeHTML(creator.name)}">${escapeHTML(creator.name)}</span>
        <span class="nav-title${creator.live ? '' : ' is-off'}" title="${escapeHTML(title)}">${escapeHTML(title)}</span>
      </span>
      ${dot}
    </button>`;
  };

  const parts = [
    `<button class="creator-nav ${state.selectedCreator === 'all' ? 'is-selected' : ''}" data-creator="all">
      <span class="creator-avatar creator-avatar--all" aria-hidden="true">▦</span>
      <span class="nav-body">
        <span class="nav-name">全部主播</span>
        <span class="nav-title is-off">${state.rooms.length} 个房间</span>
      </span>
      <span class="nav-count">${state.rooms.length}</span>
    </button>`,
  ];
  // 直播的和未开播的之间加一条细分隔，让「冒泡到前列」一眼可辨
  if (liveCreators.length && offlineCreators.length) {
    parts.push('<div class="creator-sep" aria-hidden="true"></div>');
  }
  for (const creator of liveCreators) parts.push(itemHTML(creator));
  for (const creator of offlineCreators) parts.push(itemHTML(creator));

  $('#streamerList').innerHTML = parts.join('');
  $('#streamerList').querySelectorAll('[data-creator]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedCreator = button.dataset.creator;
      render();
    });
  });
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
      <span class="cover-offline" aria-hidden="true">未开播</span>
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
  destroyPlatformPage();
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
  $('#catalog').hidden = true;
  $('#watchPage').hidden = false;
  $('#watchLiveState').textContent = room.live ? '正在直播' : '准备进入';
  $('#watchTitle').textContent = roomName(room);
  $('#watchAnchor').textContent = [creatorName(room), room.area].filter(Boolean).join(' · ');
  setWatchAvatar(room);
  $('#danmakuOverlay').replaceChildren();
  $('#danmakuOverlay').classList.remove('is-visible');
  $('#toggleOverlay').disabled = true;
  state.viewMode = 'native';
  $('#viewSwitch').hidden = !IS_DESKTOP;
  document
    .querySelectorAll('#viewSwitch button')
    .forEach((button) => button.classList.toggle('is-selected', button.dataset.view === 'native'));
  $('#watchLayout').hidden = false;
  $('#platformPage').hidden = true;
  destroyPlatformPage();
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
  player.triedLines = [];
  player.lineFailoverAt = 0;
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

/* ---------------- 桌面端：平台官方页（内嵌） ---------------- */

const PLATFORM_ROOM_URL = {
  bilibili: (id) => `https://live.bilibili.com/${id}`,
  huya: (id) => `https://www.huya.com/${id}`,
  douyu: (id) => `https://www.douyu.com/${id}`,
  douyin: (id) => `https://live.douyin.com/${id}`,
};

function destroyPlatformPage() {
  $('#platformPageBody')?.replaceChildren();
  $('#platformPageUrl').textContent = '';
}

function openPlatformPage(room) {
  const body = $('#platformPageBody');
  if (!body) return;
  const url = PLATFORM_ROOM_URL[room.platform]?.(room.roomId);
  if (!url) return;
  body.replaceChildren();
  $('#platformPageUrl').textContent = url;
  const view = document.createElement('webview');
  view.setAttribute('src', url);
  // partition 带 persist: 前缀，登录态会落盘，第二次进来还是已登录
  view.setAttribute('partition', `persist:${room.platform}`);
  // 抖音首次加载偶尔只提交一个空文档，标题为空；自动重载一次即可正常
  let retried = false;
  view.addEventListener('did-finish-load', () => {
    const title = view.getTitle?.() || '';
    if (!title) {
      if (!retried) {
        retried = true;
        setTimeout(() => view.reload(), 400);
      }
      return;
    }
    $('#platformPageUrl').textContent = `${url} · ${title}`;
  });
  view.addEventListener('did-fail-load', (event) => {
    // -3 是主动中止（切房间时正常发生），不用报错
    if (!event.errorCode || event.errorCode === -3) return;
    $('#platformPageUrl').textContent = `加载失败 ${event.errorCode}：${event.errorDescription || ''}`;
  });
  view.addEventListener('render-process-gone', () => {
    $('#platformPageUrl').textContent = '页面进程异常退出，点「刷新」重试';
  });
  body.appendChild(view);
}

function setViewMode(mode) {
  const room = state.currentRoom;
  if (!room || !IS_DESKTOP) return;
  state.viewMode = mode;
  document
    .querySelectorAll('#viewSwitch button')
    .forEach((button) => button.classList.toggle('is-selected', button.dataset.view === mode));

  const native = mode === 'native';
  $('#watchLayout').hidden = !native;
  $('#platformPage').hidden = native;

  if (native) {
    // 回到自研播放器：内嵌官方页要销毁，否则两路视频一起放
    destroyPlatformPage();
    startDanmaku(room);
    loadWatchRoom(room);
  } else {
    player.requestId += 1;
    clearOfflineTimer();
    stopDanmaku();
    clearPlayerEngine();
    openPlatformPage(room);
  }
}

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

function spawnOverlay(msg) {
  const overlay = $('#danmakuOverlay');
  if (!overlay || overlay.childElementCount > 40) return;
  const node = document.createElement('span');
  node.className = 'danmaku-float';
  node.textContent = msg.content;
  if (msg.color) node.style.color = msg.color;
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

/** 把设置回写到面板控件上 */
function syncDanmakuSettingsUI() {
  const setValue = (id, value) => {
    const node = $(id);
    if (node) node.value = String(value);
  };
  setValue('#dmOpacity', danmakuStyle.opacity);
  setValue('#dmFontSize', danmakuStyle.fontSize);
  setValue('#dmSpeed', danmakuStyle.speed);
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
    // 虎牙自研取流不可用时，在 LiveHub 当前窗口内嵌官方页作为兜底。
    if (IS_DESKTOP && room.platform === 'huya') {
      showQualityHint('虎牙自研取流暂不可用，已在 LiveHub 窗口内打开虎牙官方直播页。');
      setTimeout(() => {
        if (state.currentRoom?.key === room.key && !$('#watchPage').hidden) setViewMode('platform');
      }, 1200);
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

// ---- 目标缓冲控制 ----
// 现象：起播时有 5~6 秒缓冲，看几分钟后掉到 1~2 秒，然后开始卡。
// 原因是**下载速率比播放速率略慢**（差几个百分点），缓冲被一点点吃干；
// 而原来的控制是「低到 2 秒才踩一脚 0.94」，等它踩下去时已经晚了。
//
// 改成**按目标值连续微调**（YouTube / Twitch 的做法）：离目标越远放得越慢，
// 让播放速度自动收敛到「刚好等于实际下载速率」，缓冲就稳在目标线上不再漏。
// 用户已明确「延迟稳定即可、不能卡」，5 秒延迟换来稳定观看是划算的。
// 实测（真实 app、B站原画 1920x1080）：正常需要约 8 Mbps，
// 但上游会周期性塌到 1.2~4 Mbps，持续十几秒到几十秒，5 秒缓冲不够吃。
// 所以目标定在 10 秒——比「最低延迟」更值钱的是扛住这种塌陷。
const BUF_TARGET = 10.0;  // 目标缓冲（= 播放器右下角显示的延迟）
const BUF_CEIL = 14.0;    // 超过它就用 1.05x 慢慢追，避免延迟无限涨
const BUF_FLOOR = 2.0;    // 到这个水位已经全力放慢
const RATE_MIN = 0.90;    // 最多放慢 10%，塌陷期靠这 10% 慢慢把余量攒回来
const RATE_MAX = 1.05;

let bufferTimer;
function startBufferController() {
  stopBufferController();
  bufferTimer = setInterval(tunePlaybackRate, 1000);
}
function stopBufferController() {
  clearInterval(bufferTimer);
  bufferTimer = null;
  const video = $('#watchVideo');
  if (video && video.playbackRate !== 1) video.playbackRate = 1;
}

function tunePlaybackRate() {
  const video = $('#watchVideo');
  if (!video || !state.currentRoom) return;
  if (video.paused || video.ended || video.seeking) {
    if (video.playbackRate !== 1) video.playbackRate = 1;
    return;
  }
  const ranges = video.buffered;
  if (!ranges || !ranges.length) return;
  const depth = ranges.end(ranges.length - 1) - video.currentTime;
  if (!Number.isFinite(depth) || depth <= 0) return;

  let rate = 1;
  if (depth >= BUF_CEIL) {
    rate = Math.min(RATE_MAX, 1 + (depth - BUF_CEIL) * 0.01);
  } else if (depth < BUF_TARGET) {
    // 6s→1.0 4s→0.96 2s→0.92（线性，离目标越远越慢）
    const deficit = (BUF_TARGET - depth) / (BUF_TARGET - BUF_FLOOR);
    rate = Math.max(RATE_MIN, 1 - 0.10 * Math.min(1, deficit));
  }
  // 变化幅度太小就别写，省得频繁触发音频重采样
  if (Math.abs(video.playbackRate - rate) > 0.005) {
    video.playbackRate = Number(rate.toFixed(3));
  }

  // 已经全力放慢却还是见底：说明这档码率确实超出链路能力，主动降档
  if (depth < 1.2) {
    player.lowBufferSince = player.lowBufferSince || Date.now();
    if (Date.now() - player.lowBufferSince > 8000) {
      player.lowBufferSince = 0;
      // 先换同清晰度的兄弟节点，全试过才降清晰度
      if (!tryAlternateLine()) degradeQuality();
    }
  } else {
    player.lowBufferSince = 0;
  }
}

// ---- 线路故障切换 ----
// B 站每档会下发多个 CDN 节点，之前只用第一个：碰上被限速的节点
// （实测掉到 51 KB/s，正常要 1000）整条流就废了，只能降清晰度。
// 缓冲持续见底时先在同清晰度里换节点，全试过才降档。
function tryAlternateLine() {
  const list = currentQualityStreams();
  if (list.length < 2) return false;
  if (Date.now() - (player.lineFailoverAt || 0) < 25_000) return false;
  player.triedLines = player.triedLines || [];
  const current = list[player.line];
  for (let step = 1; step < list.length; step++) {
    const idx = (player.line + step) % list.length;
    const next = list[idx];
    if (!next || next.url === current?.url) continue;
    if (player.triedLines.includes(next.url)) continue;
    player.triedLines.push(next.url);
    player.lineFailoverAt = Date.now();
    player.line = idx;
    renderQualityControls();
    showQualityHint(`当前线路不稳定，已切到备用节点（${lineLabel(next, idx)}）`);
    playStream(next);
    return true;
  }
  return false;
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
      `${note || `这条线路一次只下发 ${Math.round(duration)} 秒`}，会自动切到内嵌的虎牙官方页。`,
    );
    if (IS_DESKTOP) {
      setTimeout(() => {
        if (state.currentRoom?.key === room.key && !$('#watchPage').hidden) setViewMode('platform');
      }, 900);
    }
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
      // 起始攒 3MB 再开播（约 4~6 秒）。实测抖音原画这条线，下载速度只比播放速度快一点，
      // 贴着直播点起播的话缓冲永远只有 0~3 秒，网络一抖就冻屏（实测停顿瞬间缓冲恰好 0.0s）。
      // 多等 3 秒换 3~4 秒的推进余量，符合「延迟稳定即可、不能卡」的取舍。
      stashInitialSize: 3072,
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
}

/** 清掉算出来的尺寸，回到 CSS 默认（换房间时用） */
function resetPlayerSize() {
  const stage = $('#watchPlayer');
  if (!stage) return;
  stage.style.width = '';
  stage.style.height = '';
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
  if (!w || !h) return; // 还没拿到尺寸就保持 CSS 里的默认表现
  // 下限放到 0.5：抖音这类手机竖屏直播常见 9:16(0.56)，卡在 0.8 会左右各留 15% 黑边。
  // 高度已经由 min(可用宽/比例, 可用高) 兜住，竖屏不会顶出可视区，放心放开。
  const ratio = Math.min(Math.max(w / h, 0.5), 2.8);
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
  $('#accountDot')?.classList.toggle('is-on', logged.length > 0);
  const label = $('#accountLabel');
  const summary = $('#accountSummary');
  if (label) label.textContent = logged.length ? `${logged.length} 个账号已登录` : '平台账号';
  if (summary) {
    summary.textContent = logged.length
      ? logged.map((account) => account.name).join(' · ')
      : '登录后可解锁原画与弹幕';
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
  // 播放器尺寸是按「可用区域 + 视频比例」算出来的，窗口一变就得重算
  window.addEventListener('resize', syncPlayerAspect);
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

  $('#platformReload').addEventListener('click', () => {
    const view = $('#platformPageBody')?.querySelector('webview');
    if (view) view.reload();
    else if (state.currentRoom) openPlatformPage(state.currentRoom);
  });
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
    if (!state.rooms.length || !confirm(`确定清空全部 ${state.rooms.length} 个房间？`)) return;
    try {
      await Promise.all(state.rooms.map((room) => api(`/api/rooms/${encodeURIComponent(room.key)}`, { method: 'DELETE' })));
      state.rooms = [];
      state.selectedCreator = 'all';
      state.platform = 'all';
      render();
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
