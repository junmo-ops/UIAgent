import { defineConfig } from 'wxt';

const serviceUrl = new URL(process.env.WXT_PUBLIC_AGENT_SERVICE_URL ?? 'http://127.0.0.1:8787');
// Chrome match patterns do not permit ports. The service origin below still
// retains its port for fetch requests; this value is only for host permission.
const serviceHostPermission = `${serviceUrl.protocol}//${serviceUrl.hostname}/*`;

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    define: {
      __UI_AGENT_SERVICE_ORIGIN__: JSON.stringify(serviceUrl.origin)
    }
  }),
  manifest: {
    name: 'UI 需求示意助手',
    description: '选择页面区域，通过自然语言生成受控的静态 UI 需求示意。',
    version: '0.1.0',
    permissions: ['activeTab', 'scripting', 'sidePanel', 'storage', 'downloads'],
    host_permissions: [serviceHostPermission],
    action: { default_title: '打开 UI 需求示意助手' }
  }
});
