import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type ChangePlan, type SelectedContext } from '@ui-agent/contracts';
import { validatePlan } from './index';

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
});
