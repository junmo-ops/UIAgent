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
  | { type: 'BEGIN_VERIFY' }
  | { type: 'BEGIN_REPAIR' }
  | { type: 'APPLIED'; message: string; selection?: SelectedContext; canUndo: boolean; canRedo: boolean }
  | { type: 'CLARIFY'; message: string }
  | { type: 'HISTORY'; canUndo: boolean; canRedo: boolean; selection?: SelectedContext }
  | { type: 'NOTICE'; message: string }
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
    setNotice: assign(({ event }) => event.type === 'NOTICE' ? { message: event.message, error: undefined } : {}),
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
    NOTICE: { actions: 'setNotice' },
    HISTORY: { actions: 'setHistory' }
  },
  states: {
    idle: { on: { START_SELECTION: 'selecting' } },
    selecting: { on: { START_SELECTION: 'selecting' } },
    ready: { on: { START_SELECTION: 'selecting', SUBMIT: 'planning' } },
    planning: { on: { NEEDS_CONFIRMATION: { target: 'confirming', actions: 'setPlan' }, BEGIN_APPLY: 'applying', CLARIFY: { target: 'ready', actions: 'setClarification' } } },
    confirming: { on: { BEGIN_APPLY: 'applying', DISMISS: { target: 'ready', actions: 'clearError' } } },
    applying: { on: { BEGIN_VERIFY: 'verifying' } },
    verifying: { on: { APPLIED: { target: 'ready', actions: 'setApplied' }, BEGIN_REPAIR: 'repairing', CLARIFY: { target: 'ready', actions: 'setClarification' } } },
    repairing: { on: { BEGIN_APPLY: 'applying', NEEDS_CONFIRMATION: { target: 'confirming', actions: 'setPlan' }, CLARIFY: { target: 'ready', actions: 'setClarification' } } },
    error: { on: { DISMISS: { target: 'ready', actions: 'clearError' }, START_SELECTION: 'selecting' } }
  }
});
