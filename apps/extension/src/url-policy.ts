export function pageInjectionError(url?: string): string | undefined {
  if (!url) return '无法读取当前页面地址。';
  try {
    const protocol = new URL(url).protocol;
    if (protocol === 'http:' || protocol === 'https:') return undefined;
    return `Chrome 不允许插件编辑 ${protocol} 页面。请打开普通 HTTP/HTTPS 页面后重新点击插件图标。`;
  } catch {
    return '当前页面地址无效，无法注入 UI 编辑能力。';
  }
}
