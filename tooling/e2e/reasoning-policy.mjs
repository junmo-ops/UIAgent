import { readFileSync } from 'node:fs';

// Test-only override, applied inside the isolated process. The developer's
// service.local.json and the deployment configuration are never modified.
export function readReasoningPolicy(path) {
  if (!path) return undefined;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const fields = ['discovery', 'planning', 'execution', 'verification', 'correction', 'layoutExecution'];
  const efforts = ['none', 'low', 'high', 'max'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))
    || fields.slice(0, 3).some(key => !efforts.includes(value[key]))
    || fields.slice(3).some(key => key in value && !efforts.includes(value[key]))) {
    throw new Error('Invalid isolated edit reasoning policy');
  }
  return value;
}
