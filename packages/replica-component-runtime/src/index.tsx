import { StyleProvider } from '@ant-design/cssinjs';
import { ConfigProvider, Select } from 'antd';
import type { SelectProps } from 'antd';
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type SelectValue = string | number;
type SelectOption = { value: SelectValue; label: string; disabled?: boolean };

const ELEMENT_NAME = 'ui-agent-select';
const MAX_OPTIONS = 100;
const MAX_TEXT_LENGTH = 200;

function booleanAttribute(element: HTMLElement, name: string): boolean {
  return element.hasAttribute(name) && element.getAttribute(name) !== 'false';
}

function parseOptions(element: HTMLElement): SelectOption[] {
  const raw = element.getAttribute('options');
  if (!raw) throw new Error('缺少 options 属性');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_OPTIONS) {
    throw new Error(`options 必须包含 1-${MAX_OPTIONS} 个选项`);
  }
  const seen = new Set<SelectValue>();
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`第 ${index + 1} 个选项无效`);
    const candidate = item as Record<string, unknown>;
    const value = candidate.value;
    const label = candidate.label;
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length > MAX_TEXT_LENGTH) {
      throw new Error(`第 ${index + 1} 个选项的 value 无效`);
    }
    if (typeof label !== 'string' || !label.trim() || label.length > MAX_TEXT_LENGTH) {
      throw new Error(`第 ${index + 1} 个选项的 label 无效`);
    }
    if (seen.has(value)) throw new Error(`选项 value 重复：${String(value)}`);
    seen.add(value);
    return { value, label, disabled: candidate.disabled === true };
  });
}

function initialValue(element: HTMLElement, options: readonly SelectOption[]): SelectValue | undefined {
  const configured = element.getAttribute('default-value');
  if (configured === null) return undefined;
  return options.find(option => String(option.value) === configured)?.value;
}

function SelectIsland({ element, popupContainer }: { element: HTMLElement; popupContainer: HTMLElement }) {
  const options = useMemo(() => parseOptions(element), [element, element.getAttribute('options')]);
  const configuredDefault = initialValue(element, options);
  const [value, setValue] = useState<SelectValue | undefined>(configuredDefault);

  useEffect(() => {
    setValue(current => options.some(option => option.value === current) ? current : configuredDefault);
  }, [configuredDefault, options]);

  const sizeValue = element.getAttribute('size');
  const size: SelectProps['size'] = sizeValue === 'small' || sizeValue === 'large' ? sizeValue : 'middle';
  const placeholder = element.getAttribute('placeholder')?.slice(0, MAX_TEXT_LENGTH) || undefined;
  const accessibleLabel = element.getAttribute('aria-label')?.slice(0, MAX_TEXT_LENGTH)
    || placeholder
    || '请选择';
  const computedStyle = getComputedStyle(element);
  const computedFontSize = Number.parseFloat(computedStyle.fontSize);

  return (
    <StyleProvider container={element.shadowRoot!} hashPriority="high">
      <ConfigProvider
        getPopupContainer={() => popupContainer}
        theme={{
          token: {
            fontFamily: computedStyle.fontFamily || undefined,
            ...(Number.isFinite(computedFontSize) ? { fontSize: computedFontSize } : {})
          }
        }}
      >
        <Select<SelectValue>
          aria-label={accessibleLabel}
          allowClear={booleanAttribute(element, 'allow-clear')}
          disabled={booleanAttribute(element, 'disabled')}
          optionFilterProp="label"
          options={options}
          placeholder={placeholder}
          showSearch={booleanAttribute(element, 'show-search')}
          size={size}
          value={value}
          onChange={nextValue => {
            setValue(nextValue);
            element.dispatchEvent(new CustomEvent('ui-agent-change', {
              bubbles: true,
              composed: true,
              detail: { value: nextValue }
            }));
          }}
        />
      </ConfigProvider>
    </StyleProvider>
  );
}

class UiAgentSelectElement extends HTMLElement {
  static observedAttributes = [
    'options', 'default-value', 'placeholder', 'size', 'disabled',
    'allow-clear', 'show-search', 'aria-label'
  ];

  private root?: Root;
  private mount?: HTMLDivElement;
  private popupContainer?: HTMLDivElement;

  connectedCallback() {
    if (!this.shadowRoot) {
      const shadow = this.attachShadow({ mode: 'open' });
      const baseStyle = document.createElement('style');
      baseStyle.textContent = `
        :host { display: inline-block; min-width: 120px; max-width: 100%; vertical-align: middle; font: inherit; }
        *, *::before, *::after { box-sizing: border-box; }
        [data-ui-agent-select-root], .ant-select { width: 100%; }
      `;
      this.mount = document.createElement('div');
      this.mount.setAttribute('data-ui-agent-select-root', '');
      this.popupContainer = document.createElement('div');
      this.popupContainer.setAttribute('data-ui-agent-select-popup-root', '');
      shadow.append(baseStyle, this.mount, this.popupContainer);
    }
    if (!this.root && this.mount) this.root = createRoot(this.mount);
    this.renderComponent();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = undefined;
  }

  attributeChangedCallback() {
    if (this.isConnected) this.renderComponent();
  }

  private renderComponent() {
    if (!this.root || !this.popupContainer) return;
    try {
      parseOptions(this);
      this.root.render(<SelectIsland element={this} popupContainer={this.popupContainer} />);
    } catch (error) {
      this.root.render(
        <span role="alert" style={{ color: '#ff4d4f', fontSize: 12 }}>
          Select 配置无效：{error instanceof Error ? error.message : '未知错误'}
        </span>
      );
    }
  }
}

if (!customElements.get(ELEMENT_NAME)) customElements.define(ELEMENT_NAME, UiAgentSelectElement);
