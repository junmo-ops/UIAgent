import { onMessage, sendMessage } from '../src/messaging';
import type { ContentCommand, ContentCommandResult } from '@ui-agent/contracts';
import { pageInjectionError } from '../src/url-policy';

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('当前没有可用的活动页面');
  return tab;
}

async function sendToContent(tab: Browser.tabs.Tab, command: ContentCommand): Promise<ContentCommandResult> {
  if (!tab.id) throw new Error('当前标签页不可用');
  try {
    return await sendMessage('contentCommand', command, tab.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Receiving end does not exist|Could not establish connection/i.test(message)) throw error;
    const injectionError = pageInjectionError(tab.url);
    if (injectionError) throw new Error(injectionError);
    try {
      await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/content-scripts/content.js'] });
    } catch (injectionFailure) {
      const injectionMessage = injectionFailure instanceof Error ? injectionFailure.message : String(injectionFailure);
      if (/Cannot access|permission|activeTab|extensions gallery|Chrome Web Store/i.test(injectionMessage)) {
        throw new Error('当前页面尚未获得临时访问权限。请在该页面点击一次 Chrome 工具栏中的插件图标，再点击“重新选择页面元素”。');
      }
      throw injectionFailure;
    }
    return await sendMessage('contentCommand', command, tab.id);
  }
}

async function exportScreenshot(): Promise<ContentCommandResult> {
  const tab = await activeTab();
  await sendToContent(tab, { type: 'prepareScreenshot' });
  try {
    await new Promise(resolve => setTimeout(resolve, 80));
    let dataUrl: string;
    try {
      dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/activeTab|<all_urls>/i.test(message)) {
        throw new Error('当前页面的截图授权已失效。请先点击一次 Chrome 工具栏中的插件图标，再重新导出；页面跳转后需要重新授权。');
      }
      throw error;
    }
    const title = (tab.title ?? 'ui-demo').replace(/[\\/:*?"<>|]/g, '-').slice(0, 60);
    await browser.downloads.download({ url: dataUrl, filename: `${title}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`, saveAs: true });
    return { ok: true };
  } finally {
    await sendToContent(tab, { type: 'finishScreenshot' }).catch(() => undefined);
  }
}

export default defineBackground(() => {
  const editorPortsByTab = new Map<number, Set<Browser.runtime.Port>>();

  // Chrome 没有提供可靠的 sidePanel.onClosed 事件。长连接会在 Side Panel
  // 文档被销毁时立即断开，因此由 Background 代替页面卸载回调完成清理。
  browser.runtime.onConnect.addListener(port => {
    if (port.name !== 'ui-agent-editor') return;
    let tabId: number | undefined;
    let disconnected = false;

    const deactivateIfLastPort = () => {
      if (tabId === undefined) return;
      const ports = editorPortsByTab.get(tabId);
      ports?.delete(port);
      if (ports?.size) return;
      editorPortsByTab.delete(tabId);
      void sendMessage('contentCommand', { type: 'deactivateEditor' }, tabId).catch(() => undefined);
    };

    port.onDisconnect.addListener(() => {
      disconnected = true;
      deactivateIfLastPort();
    });

    void activeTab().then(tab => {
      if (!tab.id) return;
      tabId = tab.id;
      if (disconnected) {
        deactivateIfLastPort();
        return;
      }
      const ports = editorPortsByTab.get(tabId) ?? new Set<Browser.runtime.Port>();
      ports.add(port);
      editorPortsByTab.set(tabId, ports);
    }).catch(() => undefined);
  });

  // 显式处理 action 点击，使 Chrome 在用户手势中授予当前页面 activeTab。
  // 自动的 openPanelOnActionClick 在部分 Chrome 版本中不会为后续截图保留该授权。
  browser.action.onClicked.addListener(tab => {
    if (tab.id) browser.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
  });
  onMessage('browserCommand', async message => {
    try {
      if (message.data.type === 'exportScreenshot') return await exportScreenshot();
      const tab = await activeTab();
      return await sendToContent(tab, message.data);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '浏览器命令执行失败' };
    }
  });
});
