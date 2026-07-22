import { assign, setup } from 'xstate';
import type { ChangePlan, SelectedContext } from '@ui-agent/contracts';

interface SessionContext {
  selection?: SelectedContext;
  pendingPlan?: ChangePlan;
  message?: string;
  error?: string;
  canUndo: boolean;
  canRedo: boolean;
}

type SessionEvent =
  | { type: 'START_SELECTION' }
  | { type: 'SELECTION_FOUND'; selection: SelectedContext }
  | { type: 'SUBMIT' }
  | { type: 'NEEDS_CONFIRMATION'; plan: ChangePlan }
  | { type: 'BEGIN_APPLY'; plan?: ChangePlan }
  | { type: 'APPLIED'; message: string; selection?: SelectedContext; canUndo: boolean; canRedo: boolean }
  | { type: 'CLARIFY'; message: string }
  | { type: 'HISTORY'; canUndo: boolean; canRedo: boolean; selection?: SelectedContext }
  | { type: 'FAIL'; error: string }
  | { type: 'DISMISS' };

export const sessionMachine = setup({
  types: { context: {} as SessionContext, events: {} as SessionEvent },
  actions: {
    setSelection: assign(({ event }) => event.type === 'SELECTION_FOUND' ? { selection: event.selection, error: undefined, message: '已选中页面区域' } : {}),
    setPlan: assign(({ event }) => event.type === 'NEEDS_CONFIRMATION' ? { pendingPlan: event.plan } : {}),
    setApplied: assign(({ event }) => event.type === 'APPLIED' ? { pendingPlan: undefined, message: event.message, selection: event.selection, canUndo: event.canUndo, canRedo: event.canRedo, error: undefined } : {}),
    setClarification: assign(({ event }) => event.type === 'CLARIFY' ? { message: event.message, pendingPlan: undefined } : {}),
    setHistory: assign(({ context, event }) => event.type === 'HISTORY' ? { canUndo: event.canUndo, canRedo: event.canRedo, selection: event.selection ?? context.selection } : {}),
    setError: assign(({ event }) => event.type === 'FAIL' ? { error: event.error } : {}),
    clearError: assign({ error: undefined })
  }
}).createMachine({
  id: 'browser-edit-session',
  initial: 'idle',
  context: { canUndo: false, canRedo: false },
  on: {
    SELECTION_FOUND: { target: '.ready', actions: 'setSelection' },
    FAIL: { target: '.error', actions: 'setError' },
    HISTORY: { actions: 'setHistory' }
  },
  states: {
    idle: { on: { START_SELECTION: 'selecting' } },
    selecting: { on: { START_SELECTION: 'selecting' } },
    ready: { on: { START_SELECTION: 'selecting', SUBMIT: 'planning' } },
    planning: { on: { NEEDS_CONFIRMATION: { target: 'confirming', actions: 'setPlan' }, BEGIN_APPLY: 'applying', CLARIFY: { target: 'ready', actions: 'setClarification' } } },
    confirming: { on: { BEGIN_APPLY: 'applying', DISMISS: { target: 'ready', actions: 'clearError' } } },
    applying: { on: { APPLIED: { target: 'ready', actions: 'setApplied' } } },
    error: { on: { DISMISS: { target: 'ready', actions: 'clearError' }, START_SELECTION: 'selecting' } }
  }
});
