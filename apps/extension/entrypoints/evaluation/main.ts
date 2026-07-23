import type { ContentCommand, ContentCommandResult } from '@ui-agent/contracts';
import { sendMessage } from '../../src/messaging';

declare global {
  interface Window {
    uiAgentEvaluation: {
      command(value: ContentCommand): Promise<ContentCommandResult>;
    };
  }
}

async function demoTab(): Promise<Browser.tabs.Tab> {
  const tabs = await browser.tabs.query({
    url: ['http://127.0.0.1:5173/*', 'http://localhost:5173/*']
  });
  if (tabs.length !== 1 || !tabs[0]?.id) {
    throw new Error(`评测要求恰好打开一个固定测试页，当前找到 ${tabs.length} 个`);
  }
  return tabs[0];
}

async function command(value: ContentCommand): Promise<ContentCommandResult> {
  const tab = await demoTab();
  try {
    return await sendMessage('contentCommand', value, tab.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Receiving end does not exist|Could not establish connection/i.test(message)) throw error;
    await browser.scripting.executeScript({
      target: { tabId: tab.id! },
      files: ['/content-scripts/content.js']
    });
    return sendMessage('contentCommand', value, tab.id);
  }
}

window.uiAgentEvaluation = { command };
document.documentElement.setAttribute('data-ui-agent-evaluation-ready', 'true');
