module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true }
    },
    {
      name: 'contracts-do-not-depend-on-implementation',
      severity: 'error',
      from: { path: '^packages/contracts/' },
      to: { path: '^apps/' }
    },
    {
      name: 'agent-runtime-does-not-depend-on-browser',
      severity: 'error',
      from: { path: '^packages/agent-runtime/' },
      to: { path: '^apps/extension/' }
    },
    {
      name: 'agent-runtime-core-is-independent',
      severity: 'error',
      from: { path: '^packages/agent-runtime/src/core/' },
      to: { path: '^(packages/agent-runtime/src/(adapters|source-editing)/|apps/)' }
    },
    {
      name: 'source-editing-does-not-depend-on-adapters',
      severity: 'error',
      from: { path: '^packages/agent-runtime/src/source-editing/' },
      to: { path: '^packages/agent-runtime/src/adapters/' }
    },
    {
      name: 'extension-does-not-depend-on-agent-runtime',
      severity: 'error',
      from: { path: '^apps/extension/' },
      to: { path: '^packages/agent-runtime/' }
    },
    {
      name: 'workspace-domain-does-not-depend-on-service-shell',
      severity: 'error',
      from: { path: '^apps/agent-service/src/workspace/' },
      to: { path: '^apps/agent-service/src/(observability|progress|app|index)' }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'] }
  }
};
