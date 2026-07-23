import { describe, expect, it } from 'vitest';
import { parseOptions } from './options';

describe('challenge CLI options', () => {
  it('defaults to a single development run', () => {
    expect(parseOptions([])).toMatchObject({
      split: 'development', repeats: 1, scenarioIds: [], confirmHoldout: false
    });
  });

  it('requires an explicit acknowledgement before exposing holdout runs', () => {
    expect(() => parseOptions(['--split', 'holdout'])).toThrow(/--confirm-holdout/);
    expect(parseOptions(['--split', 'holdout', '--confirm-holdout']).split).toBe('holdout');
  });

  it('bounds repeats and parses comma separated scenario IDs', () => {
    expect(parseOptions(['--repeat', '3', '--scenario', 'C01,C02']).scenarioIds).toEqual(['C01', 'C02']);
    expect(() => parseOptions(['--repeat', '6'])).toThrow(/1 到 5/);
  });
});
