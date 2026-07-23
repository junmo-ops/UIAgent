import { describe, expect, it } from 'vitest';
import { challengeScenarios } from './scenarios';

describe('challenge scenario dataset', () => {
  it('contains eight development and four holdout scenarios with unique IDs', () => {
    expect(challengeScenarios).toHaveLength(12);
    expect(challengeScenarios.filter(item => item.split === 'development')).toHaveLength(8);
    expect(challengeScenarios.filter(item => item.split === 'holdout')).toHaveLength(4);
    expect(new Set(challengeScenarios.map(item => item.id)).size).toBe(12);
  });

  it('covers composition, correction, scope, and security without business operation types', () => {
    const tags = new Set(challengeScenarios.flatMap(item => item.tags));
    expect(tags).toEqual(expect.objectContaining(new Set([
      'composition', 'correction', 'scope', 'security'
    ])));
    expect(challengeScenarios.some(item => item.instructionTurns.length >= 3)).toBe(true);
    expect(challengeScenarios.filter(item => item.expectedResponse === 'clarification')).toHaveLength(3);
  });

  it('defines bounded scoring expectations for every scenario', () => {
    for (const scenario of challengeScenarios) {
      expect(scenario.version).toBe('1.0');
      expect(scenario.maxTotalOperations).toBeLessThanOrEqual(12);
      expect(scenario.forbiddenEffects.length).toBeGreaterThan(0);
      if (scenario.expectedResponse === 'clarification') {
        expect(scenario.operationGroups).toHaveLength(0);
      } else {
        expect(scenario.operationGroups.length).toBeGreaterThan(0);
      }
    }
  });
});
