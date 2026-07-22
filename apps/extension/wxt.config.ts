import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'UI 需求示意助手',
    description: '选择页面区域，通过自然语言生成受控的静态 UI 需求示意。',
    version: '0.1.0',
    permissions: ['activeTab', 'scripting', 'sidePanel', 'storage', 'downloads'],
    action: { default_title: '打开 UI 需求示意助手' }
  }
});
