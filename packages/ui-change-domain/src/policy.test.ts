import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type ChangePlan, type SelectedContext, type UiIntent } from '@ui-agent/contracts';
import { compilePlanFromIntent, validatePlan } from './index';

const context: SelectedContext = {
  protocolVersion: PROTOCOL_VERSION,
  selectionVersion: 1,
  pageRevision: 0,
  page: { title: 'test', url: 'http://localhost:5173', viewportWidth: 1200, viewportHeight: 800 },
  selected: { id: 'selected', tag: 'button', text: '查询', rect: { x: 0, y: 0, width: 80, height: 32 } },
  selectedTree: { id: 'selected', tag: 'button', text: '查询', attributes: {}, children: [] },
  reusableTrees: [],
  parent: { tag: 'div', display: 'flex', flexDirection: 'row', gap: '8px' },
  siblings: [],
  visibleStyle: {},
  addedElements: [],
  addedTrees: []
};

function plan(operation: ChangePlan['operations'][number]): ChangePlan {
  return {
    protocolVersion: PROTOCOL_VERSION,
    planId: 'plan-1', selectionVersion: 1, pageRevision: 0,
    summary: 'test', requiresConfirmation: false, operations: [operation]
  };
}

describe('validatePlan', () => {
  it('allows a safe style update on the selected element', () => {
    expect(() => validatePlan(plan({ operationId: '1', type: 'updateStyle', target: { kind: 'node', nodeId: 'selected' }, styles: { color: '#1677ff' } }), context)).not.toThrow();
  });

  it('rejects unsafe CSS values', () => {
    expect(() => validatePlan(plan({ operationId: '1', type: 'updateStyle', target: { kind: 'node', nodeId: 'selected' }, styles: { backgroundColor: 'url(https://evil.test)' } }), context)).toThrow(/不安全/);
  });

  it('requires confirmation before removing the existing selection', () => {
    expect(() => validatePlan(plan({ operationId: '1', type: 'removeElement', target: { kind: 'node', nodeId: 'selected' } }), context)).toThrow(/确认/);
  });

  it('allows a cloned subtree to be edited through a plan-local reference', () => {
    const clonePlan: ChangePlan = {
      ...plan({
        operationId: 'clone', type: 'cloneSubtree',
        source: { kind: 'node', nodeId: 'selected' },
        anchor: { kind: 'node', nodeId: 'selected' }, position: 'after', resultRef: 'copy'
      }),
      operations: [
        {
          operationId: 'clone', type: 'cloneSubtree',
          source: { kind: 'node', nodeId: 'selected' },
          anchor: { kind: 'node', nodeId: 'selected' }, position: 'after', resultRef: 'copy'
        },
        { operationId: 'edit', type: 'updateContent', target: { kind: 'result', resultRef: 'copy', path: [] }, text: '复制内容' }
      ]
    };
    expect(() => validatePlan(clonePlan, context)).not.toThrow();
  });

  it('rejects a plan-local reference before it is produced', () => {
    expect(() => validatePlan(plan({
      operationId: 'edit', type: 'updateContent',
      target: { kind: 'result', resultRef: 'missing', path: [] }, text: '内容'
    }), context)).toThrow(/尚未产生/);
  });

  it('keeps readable context descendants out of the direct-write scope', () => {
    const scopedContext: SelectedContext = {
      ...context,
      selectedTree: {
        id: 'row', tag: 'tr', text: '', attributes: {},
        children: [{ id: 'selected', tag: 'button', text: '查询', attributes: {}, children: [] }]
      }
    };
    expect(() => validatePlan(plan({
      operationId: 'edit-row', type: 'updateContent',
      target: { kind: 'node', nodeId: 'row' }, text: '不允许'
    }), scopedContext)).toThrow(/仅允许读取/);
  });

  it('allows content changes inside a selected interactive component but keeps structural operations on its root', () => {
    const componentContext: SelectedContext = {
      ...context,
      selectedTree: {
        id: 'selected', tag: 'button', text: '', attributes: {},
        children: [{ id: 'button-label', tag: 'span', text: '提交订单', attributes: {}, children: [] }]
      }
    };
    expect(() => validatePlan(plan({
      operationId: 'edit-label', type: 'updateContent',
      target: { kind: 'node', nodeId: 'button-label' }, text: '提交审核'
    }), componentContext)).not.toThrow();

    const removeChildPlan: ChangePlan = {
      ...plan({ operationId: 'remove-label', type: 'removeElement', target: { kind: 'node', nodeId: 'button-label' } }),
      requiresConfirmation: true
    };
    expect(() => validatePlan(removeChildPlan, componentContext)).toThrow(/仅允许读取/);
  });
});

describe('compilePlanFromIntent', () => {
  it('uses declarative component and layout constraints without reading natural-language keywords', () => {
    const gridContext: SelectedContext = {
      ...context,
      selected: { ...context.selected, id: 'summary' },
      selectedTree: {
        id: 'summary', tag: 'div', text: '', attributes: {}, children: [
          { id: 'status', tag: 'div', text: '状态', attributes: {}, children: [] },
          { id: 'amount', tag: 'div', text: '金额', attributes: {}, children: [] },
          { id: 'created', tag: 'div', text: '时间', attributes: {}, children: [] }
        ]
      },
      elementFacts: [
        {
          id: 'summary', index: 0, rect: { x: 0, y: 0, width: 600, height: 80 },
          layout: { display: 'grid', flexDirection: 'row', gridTemplateColumns: '200px 200px 200px', gap: '0px' }
        },
        ...['status', 'amount', 'created'].map((id, index) => ({
          id, parentId: 'summary', index, rect: { x: index * 200, y: 0, width: 200, height: 80 },
          layout: { display: 'block', flexDirection: 'row', gridTemplateColumns: 'none', gap: 'normal' }
        }))
      ]
    };
    const intent: UiIntent = {
      summary: '新增一个带语义和位置约束的组件',
      goals: [{
        goalId: 'risk', action: 'create', role: 'tag', resultRef: 'risk-result',
        content: { label: '等级', text: 'P1', variant: 'danger' },
        placement: {
          anchor: { kind: 'node', nodeId: 'created' },
          relation: 'after', strict: true, sameRow: true
        },
        preserveTexts: ['状态', '金额']
      }]
    };
    const rawPlan: ChangePlan & { intent: UiIntent } = {
      protocolVersion: PROTOCOL_VERSION, planId: 'intent-plan',
      selectionVersion: 1, pageRevision: 0, summary: intent.summary, intent,
      requiresConfirmation: false,
      operations: [{
        operationId: 'create-risk', type: 'addComponent',
        anchor: { kind: 'node', nodeId: 'created' }, component: 'text',
        position: 'after', resultRef: 'risk-result', props: { text: 'P1' }
      }]
    };

    const compiled = compilePlanFromIntent(rawPlan, gridContext);
    expect(compiled.operations[0]).toMatchObject({
      type: 'addComponent', component: 'tag',
      props: { label: '等级', text: 'P1', variant: 'danger' }
    });
    expect(compiled.operations[1]).toMatchObject({
      type: 'updateStyle',
      target: { kind: 'node', nodeId: 'summary' },
      styles: { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }
    });
    expect(() => validatePlan(compiled, gridContext)).not.toThrow();
  });

  it('does not rewrite a create producer when update goals reference its result', () => {
    const rowIntent: UiIntent = {
      summary: '复制结构并修改其子节点',
      goals: [
        {
          goalId: 'create-row', action: 'create', role: 'row', resultRef: 'row-result',
          content: {},
          placement: {
            anchor: { kind: 'node', nodeId: 'first-row' },
            relation: 'before', strict: true, sameRow: false
          },
          preserveTexts: []
        },
        {
          goalId: 'update-cell', action: 'update', role: 'text',
          target: { kind: 'result', resultRef: 'row-result', path: [0] },
          resultRef: 'row-result', content: { text: '新内容' }, preserveTexts: []
        }
      ]
    };
    const rowContext: SelectedContext = {
      ...context,
      selected: { ...context.selected, id: 'table' },
      selectedTree: {
        id: 'table', tag: 'div', text: '', attributes: {}, children: [
          { id: 'first-row', tag: 'tr', text: '第一行', attributes: {}, children: [] },
          { id: 'last-row', tag: 'tr', text: '最后一行', attributes: {}, children: [] }
        ]
      }
    };
    const rawPlan: ChangePlan & { intent: UiIntent } = {
      protocolVersion: PROTOCOL_VERSION, planId: 'row-plan', selectionVersion: 1, pageRevision: 0,
      summary: rowIntent.summary, intent: rowIntent, requiresConfirmation: false,
      operations: [
        {
          operationId: 'clone-row', type: 'cloneSubtree',
          source: { kind: 'node', nodeId: 'last-row' },
          anchor: { kind: 'node', nodeId: 'table' },
          position: 'insideStart', resultRef: 'row-result'
        },
        {
          operationId: 'update-cell', type: 'updateContent',
          target: { kind: 'result', resultRef: 'row-result', path: [0] }, text: '新内容'
        }
      ]
    };

    const compiled = compilePlanFromIntent(rawPlan, rowContext);
    expect(compiled.operations[0]).toMatchObject({
      type: 'cloneSubtree',
      anchor: { kind: 'node', nodeId: 'first-row' },
      position: 'before',
      resultRef: 'row-result'
    });
  });

  it('allows fact-only nodes as read or insertion anchors but not direct content targets', () => {
    const factContext: SelectedContext = {
      ...context,
      elementFacts: [{
        id: 'fact-row', tag: 'tr', parentId: 'tbody', index: 0, text: '第一行',
        rect: { x: 0, y: 0, width: 400, height: 32 },
        layout: { display: 'table-row', flexDirection: 'row', gridTemplateColumns: 'none', gap: 'normal' }
      }]
    };
    expect(() => validatePlan(plan({
      operationId: 'add', type: 'addComponent',
      anchor: { kind: 'node', nodeId: 'fact-row' }, component: 'text',
      position: 'before', props: { text: '新增' }
    }), factContext)).not.toThrow();
    expect(() => validatePlan(plan({
      operationId: 'edit', type: 'updateContent',
      target: { kind: 'node', nodeId: 'fact-row' }, text: '越界修改'
    }), factContext)).toThrow(/仅允许读取/);
  });
});
