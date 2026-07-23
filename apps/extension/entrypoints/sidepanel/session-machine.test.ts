import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type SelectedContext } from '@ui-agent/contracts';
import { sessionMachine } from './session-machine';

const selection: SelectedContext = {
  protocolVersion: PROTOCOL_VERSION, selectionVersion: 1, pageRevision: 0,
  page: { title: 'test', url: 'http://localhost', viewportWidth: 1200, viewportHeight: 800 },
  selected: { id: 'selected', tag: 'button', text: '查询', rect: { x: 0, y: 0, width: 80, height: 32 } },
  selectedTree: { id: 'selected', tag: 'button', text: '查询', attributes: {}, children: [] }, reusableTrees: [],
  parent: { tag: 'div', display: 'flex', flexDirection: 'row', gap: '8px' }, siblings: [], visibleStyle: {}, addedElements: [], addedTrees: []
};

describe('side panel two-phase session states', () => {
  it('moves through apply, verify, one repair, and completion', () => {
    const actor = createActor(sessionMachine).start();
    actor.send({ type: 'SELECTION_FOUND', selection });
    actor.send({ type: 'SUBMIT' });
    actor.send({ type: 'BEGIN_APPLY' });
    expect(actor.getSnapshot().value).toBe('applying');
    actor.send({ type: 'BEGIN_VERIFY' });
    expect(actor.getSnapshot().value).toBe('verifying');
    actor.send({ type: 'BEGIN_REPAIR' });
    expect(actor.getSnapshot().value).toBe('repairing');
    actor.send({ type: 'BEGIN_APPLY' });
    actor.send({ type: 'BEGIN_VERIFY' });
    actor.send({ type: 'APPLIED', message: 'verified', selection: { ...selection, pageRevision: 1 }, canUndo: true, canRedo: false });
    expect(actor.getSnapshot().value).toBe('ready');
    expect(actor.getSnapshot().context).toMatchObject({ message: 'verified', canUndo: true });
  });
});
