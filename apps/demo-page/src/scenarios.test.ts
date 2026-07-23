import { describe, expect, it } from 'vitest';
import { demoScenarios } from './scenarios';

describe('V1.1 demo scenario dataset', () => {
  it('contains twenty uniquely identified scenarios across all three fixed pages', () => {
    expect(demoScenarios).toHaveLength(20);
    expect(new Set(demoScenarios.map(item => item.id)).size).toBe(20);
    expect(new Set(demoScenarios.map(item => item.page))).toEqual(new Set(['orders', 'detail', 'form']));
  });

  it('defines deterministic expectations and safety boundaries for every scenario', () => {
    for (const scenario of demoScenarios) {
      expect(scenario.selectionTestId).not.toBe('');
      expect(scenario.instructionTurns.length).toBeGreaterThan(0);
      expect(scenario.expectedOutcome).not.toBe('');
      expect(scenario.forbiddenEffects.length).toBeGreaterThan(0);
      expect(scenario.tags.length).toBeGreaterThan(0);
      if (scenario.requiresClarification) expect(scenario.allowedOperations).toHaveLength(0);
    }
  });

  it('includes multi-turn, confirmation, and security regression coverage', () => {
    expect(demoScenarios.filter(item => item.instructionTurns.length > 1).length).toBeGreaterThanOrEqual(3);
    expect(demoScenarios.some(item => item.requiresConfirmation)).toBe(true);
    expect(demoScenarios.filter(item => item.tags.includes('security')).length).toBeGreaterThanOrEqual(2);
  });
});
