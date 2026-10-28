// 桌面端桥：只暴露登录/退出/同步账号这几件事，不开任何 Node 能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('livehub', {
  isDesktop: true,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: process.platform,
  /** 打开该平台的官方登录页，登录成功后主进程会自动把 cookie 同步给本地服务 */
  login: (platform) => ipcRenderer.invoke('livehub:login', platform),
  /** 退出登录：清空该平台分区下的 cookie，并删掉服务端账号 */
  logout: (platform) => ipcRenderer.invoke('livehub:logout', platform),
  /** 手动再同步一次（登录窗口以外的场景，比如页面刷新后） */
  syncAccount: (platform) => ipcRenderer.invoke('livehub:sync-account', platform),
  /**
   * 抖音弹幕影子窗口：进房间时打开、离开时关闭。
   * 页面自己算签名拿弹幕，主进程把响应体回灌给本地服务解码。
   */
  danmaku: {
    open: (roomId) => ipcRenderer.invoke('livehub:danmaku-open', String(roomId)),
    close: (roomId) => ipcRenderer.invoke('livehub:danmaku-close', String(roomId)),
    /**
     * 发弹幕。斗鱼/虎牙/抖音的发送必须由真实页面完成（签名与登录态都在页面里），
     * 所以这几个平台由桌面端代发；哔哩哔哩走服务端接口，不需要经过这里。
     */
    send: (payload) => ipcRenderer.invoke('livehub:danmaku-send', payload),
  },
  onAccountsChanged: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('livehub:accounts-changed', listener);
    return () => ipcRenderer.removeListener('livehub:accounts-changed', listener);
  },
});
