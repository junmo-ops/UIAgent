import type { ExtensionErrorCode } from '@ui-agent/contracts';

export interface PageInjectionIssue {
  code: Extract<ExtensionErrorCode, 'UNSUPPORTED_PAGE' | 'INVALID_PAGE_URL'>;
  message: string;
}

export function pageInjectionIssue(url?: string): PageInjectionIssue | undefined {
  if (!url) return { code: 'INVALID_PAGE_URL', message: '无法读取当前页面地址。' };
  try {
    const protocol = new URL(url).protocol;
    if (protocol === 'http:' || protocol === 'https:') return undefined;
    return {
      code: 'UNSUPPORTED_PAGE',
      message: `Chrome 不允许插件编辑 ${protocol} 页面。请打开普通 HTTP/HTTPS 页面后重新点击插件图标。`
    };
  } catch {
    return { code: 'INVALID_PAGE_URL', message: '当前页面地址无效，无法注入 UI 编辑能力。' };
  }
}

export function pageInjectionError(url?: string): string | undefined {
  return pageInjectionIssue(url)?.message;
}
