import { defineConfig } from 'wxt';
import extensionPackage from './package.json';

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
    name: 'UI需求助手',
    description: '在页面上说出需求，直观看到修改效果。',
    version: extensionPackage.version,
    permissions: ['activeTab', 'scripting', 'sidePanel', 'storage', 'downloads'],
    host_permissions: [serviceHostPermission],
    icons: { 16: '/icons/16.png', 32: '/icons/32.png', 48: '/icons/48.png', 128: '/icons/128.png' },
    action: {
      default_title: '打开UI需求助手',
      default_icon: { 16: '/icons/16.png', 32: '/icons/32.png', 48: '/icons/48.png', 128: '/icons/128.png' }
    }
  }
});
