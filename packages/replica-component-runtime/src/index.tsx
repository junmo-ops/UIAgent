import { StyleProvider } from '@ant-design/cssinjs';
import * as AntDesign from 'antd';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

const MODULE_ELEMENT_NAME = 'ui-agent-module';
const MODULE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,79}$/;
type ModuleFactory = (context: Readonly<{ React: typeof React; antd: typeof AntDesign }>) => React.ComponentType | React.ReactElement;
type RuntimeApi = { define(name: string, factory: ModuleFactory): void };
declare global { interface Window { UIAgent?: RuntimeApi } }

const factories = new Map<string, ModuleFactory>();
let definitionsLoaded = false;

class ModuleErrorBoundary extends React.Component<React.PropsWithChildren, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    return this.state.error
      ? React.createElement('div', { role: 'alert' }, `局部模块运行失败：${this.state.error.message}`)
      : this.props.children;
  }
}

class UiAgentModuleElement extends HTMLElement {
  static observedAttributes = ['module'];
  private root?: Root;
  private renderedName?: string;

  connectedCallback() { this.renderModule(); }
  attributeChangedCallback() { if (this.isConnected) this.renderModule(); }
  disconnectedCallback() {
    // A DOM move disconnects/reconnects the host synchronously; preserve its state.
    queueMicrotask(() => {
      if (this.isConnected) return;
      this.root?.unmount();
      this.root = undefined;
      this.renderedName = undefined;
    });
  }

  renderModule() {
    const name = this.getAttribute('module')?.trim() ?? '';
    if (this.root && this.renderedName === name) return;
    if (!MODULE_NAME_PATTERN.test(name)) {
      this.showError('局部模块缺少有效的 module 属性');
      return;
    }
    const factory = factories.get(name);
    if (!factory) {
      if (definitionsLoaded) this.showError(`module.js 未注册模块：${name}`);
      return;
    }
    this.root ??= createRoot(this);
    try {
      const output = factory(Object.freeze({ React, antd: AntDesign }));
      const content = React.isValidElement(output) ? output
        : typeof output === 'function' ? React.createElement(output)
        : (() => { throw new Error('模块 factory 必须返回 React 组件或元素'); })();
      this.root.render(React.createElement(
        ModuleErrorBoundary, { key: name },
        React.createElement(StyleProvider, { container: document.head, hashPriority: 'high' },
          React.createElement(AntDesign.ConfigProvider, null, content))
      ));
      this.renderedName = name;
    } catch (error) {
      this.showError(`局部模块初始化失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  reportSourceError(message: string) {
    const name = this.getAttribute('module')?.trim() ?? '';
    if (!factories.has(name)) this.showError(message);
  }

  private showError(message: string) {
    this.root ??= createRoot(this);
    this.renderedName = undefined;
    this.root.render(React.createElement('div', {
      role: 'alert', style: { color: '#cf1322', whiteSpace: 'pre-wrap' }
    }, message));
  }
}

window.UIAgent = Object.freeze({
  define(name: string, factory: ModuleFactory) {
    if (!MODULE_NAME_PATTERN.test(name)) throw new Error('模块名称无效');
    if (factories.has(name)) throw new Error(`模块 ${name} 已重复定义`);
    if (typeof factory !== 'function') throw new Error('模块 factory 必须是函数');
    factories.set(name, factory);
    document.querySelectorAll<UiAgentModuleElement>(MODULE_ELEMENT_NAME).forEach(host => {
      if (host.getAttribute('module')?.trim() === name) host.renderModule();
    });
  }
});

const style = document.createElement('style');
style.setAttribute('data-ui-agent-module-host-style', '');
style.textContent = ':where(ui-agent-module){display:block;min-width:0;max-width:100%}ui-agent-module[hidden]{display:none!important}';
document.head.append(style);
if (!customElements.get(MODULE_ELEMENT_NAME)) customElements.define(MODULE_ELEMENT_NAME, UiAgentModuleElement);
window.addEventListener('error', event => {
  const failedScript = event.target instanceof HTMLScriptElement
    && event.target.hasAttribute('data-ui-agent-module-source');
  const failedExecution = typeof event.filename === 'string' && /\/module\.js(?:\?|$)/.test(event.filename);
  if (!failedScript && !failedExecution) return;
  definitionsLoaded = true;
  const detail = failedExecution && event.message ? `：${event.message}` : '';
  document.querySelectorAll<UiAgentModuleElement>(MODULE_ELEMENT_NAME).forEach(host => {
    host.reportSourceError(`module.js 加载或执行失败${detail}`);
  });
}, true);
document.addEventListener('DOMContentLoaded', () => {
  definitionsLoaded = true;
  document.querySelectorAll<UiAgentModuleElement>(MODULE_ELEMENT_NAME).forEach(host => host.renderModule());
}, { once: true });
