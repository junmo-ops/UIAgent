module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true }
    },
    {
      name: 'domain-does-not-depend-on-apps',
      severity: 'error',
      from: { path: '^packages/ui-change-domain/' },
      to: { path: '^apps/' }
    },
    {
      name: 'contracts-do-not-depend-on-implementation',
      severity: 'error',
      from: { path: '^packages/ui-change-contracts/' },
      to: { path: '^(apps/|packages/ui-change-domain/)' }
    },
    {
      name: 'agent-runtime-does-not-depend-on-browser',
      severity: 'error',
      from: { path: '^packages/agent-runtime/' },
      to: { path: '^apps/extension/' }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'] }
  }
};
