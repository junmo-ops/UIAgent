import { parseHTML } from 'linkedom';

export interface StaticVisibilityIssue {
  sourceId: string;
  clippingSourceId: string;
  axis: 'horizontal' | 'vertical';
  message: string;
}

type StyleMap = Record<string, string>;

function declarations(value: string): StyleMap {
  const result: StyleMap = {};
  for (const declaration of value.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const propertyValue = declaration.slice(separator + 1).trim().toLowerCase();
    if (property && propertyValue) result[property] = propertyValue;
  }
  return result;
}

function classRules(css: string): Array<{ className: string; style: StyleMap }> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Array<{ className: string; style: StyleMap }> = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim();
    const className = /^\.([a-zA-Z0-9_-]+)$/.exec(selector)?.[1];
    if (className) rules.push({ className, style: declarations(match[2]!) });
  }
  return rules;
}

function pixelValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(-?(?:\d+\.?\d*|\.\d+))px$/.exec(value.trim());
  if (!match) return value.trim() === '0' ? 0 : undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function issueKey(issue: StaticVisibilityIssue): string {
  return `${issue.sourceId}|${issue.clippingSourceId}|${issue.axis}`;
}

export function staticVisibilityIssueKey(issue: StaticVisibilityIssue): string {
  return issueKey(issue);
}

export function analyzeStaticVisibility(html: string, css: string): StaticVisibilityIssue[] {
  const { document } = parseHTML(html);
  const rules = classRules(css);
  const styleCache = new Map<Element, StyleMap>();
  const styleFor = (element: Element): StyleMap => {
    const cached = styleCache.get(element);
    if (cached) return cached;
    const style: StyleMap = {};
    const classes = new Set((element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
    for (const rule of rules) {
      if (classes.has(rule.className)) Object.assign(style, rule.style);
    }
    Object.assign(style, declarations(element.getAttribute('style') ?? ''));
    styleCache.set(element, style);
    return style;
  };
  const displayed = (element: Element): boolean => {
    let current: Element | null = element;
    while (current) {
      if (current.hasAttribute('hidden')) return false;
      const style = styleFor(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      current = current.parentElement;
    }
    return true;
  };

  const issues: StaticVisibilityIssue[] = [];
  for (const element of [...document.querySelectorAll('[data-ui-source-id]')]) {
    const sourceId = element.getAttribute('data-ui-source-id');
    const parent = element.parentElement;
    if (!sourceId || !parent || !displayed(element)) continue;
    const style = styleFor(element);
    // Fixed positioning is viewport-relative unless an ancestor establishes a containing block;
    // without a rendering engine that relationship cannot be inferred safely.
    if (style.position !== 'absolute') continue;
    const parentStyle = styleFor(parent);
    const clippingSourceId = parent.getAttribute('data-ui-source-id') ?? `<${parent.localName}>`;

    const overflowX = parentStyle['overflow-x'] ?? parentStyle.overflow;
    const parentWidth = pixelValue(parentStyle.width);
    const left = pixelValue(style.left);
    const width = pixelValue(style.width);
    if ((overflowX === 'hidden' || overflowX === 'clip') && parentWidth !== undefined && left !== undefined) {
      if (left >= parentWidth || (width !== undefined && left + width <= 0)) {
        issues.push({
          sourceId,
          clippingSourceId,
          axis: 'horizontal',
          message: `元素 ${sourceId} 在父容器 ${clippingSourceId} 的水平裁剪区之外：left=${left}px，父容器宽度=${parentWidth}px，overflow=${overflowX}`
        });
      }
    }

    const overflowY = parentStyle['overflow-y'] ?? parentStyle.overflow;
    const parentHeight = pixelValue(parentStyle.height);
    const top = pixelValue(style.top);
    const height = pixelValue(style.height);
    if ((overflowY === 'hidden' || overflowY === 'clip') && parentHeight !== undefined && top !== undefined) {
      if (top >= parentHeight || (height !== undefined && top + height <= 0)) {
        issues.push({
          sourceId,
          clippingSourceId,
          axis: 'vertical',
          message: `元素 ${sourceId} 在父容器 ${clippingSourceId} 的垂直裁剪区之外：top=${top}px，父容器高度=${parentHeight}px，overflow=${overflowY}`
        });
      }
    }
  }
  return issues;
}
