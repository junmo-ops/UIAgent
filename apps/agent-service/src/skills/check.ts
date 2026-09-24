import { SkillRegistry } from './registry';

const registry = new SkillRegistry();
console.log(JSON.stringify({ pythonAvailable: registry.pythonAvailable, pythonVersion: registry.pythonVersion, skills: registry.list(), issues: registry.issues }, null, 2));
if (registry.issues.length) process.exitCode = 1;
