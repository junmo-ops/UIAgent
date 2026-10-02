export const layouts = {
  flow: 'display:block',
  flex: 'display:flex;gap:24px;flex-wrap:wrap',
  grid: 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px',
  positioned: 'position:relative;padding-top:60px',
  scroll: 'height:180px;overflow:auto',
};
export function fixtureHtml(layout) {
  return `<!doctype html><html><head><title>E2E ${layout}</title><style>
  body{margin:24px;font-family:sans-serif}main{${layouts[layout]}}section{border:1px solid #999;padding:20px;min-width:160px;margin-bottom:16px}
  ${layout === 'positioned' ? 'aside{position:absolute;top:4px;right:4px}' : ''}
  </style></head><body><main><section><h2>E2E target</h2><p>First section</p></section>
  <section><h2>Other heading</h2><p>Second section</p></section><aside>Layout context</aside></main></body></html>`;
}
