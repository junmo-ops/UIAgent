import config from '../../apps/extension/wxt.config';
export default { ...config, outDir: process.env.E2E_EXTENSION_DIR };
