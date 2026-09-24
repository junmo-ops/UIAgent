import { storage } from 'wxt/utils/storage';
import { DEFAULT_AGENT_SERVICE_URL } from './agent-service-url';

export const agentServiceUrlItem = storage.defineItem<string>('local:agentServiceUrl', {
  fallback: DEFAULT_AGENT_SERVICE_URL
});

export async function getAgentServiceUrl(): Promise<string> {
  const stored = await agentServiceUrlItem.getValue();
  // Host permissions are compiled for this service. A stored address from a
  // different build must not keep a local build connected to production.
  if (stored !== DEFAULT_AGENT_SERVICE_URL) {
    await agentServiceUrlItem.setValue(DEFAULT_AGENT_SERVICE_URL);
    return DEFAULT_AGENT_SERVICE_URL;
  }
  return stored;
}

export { DEFAULT_AGENT_SERVICE_URL } from './agent-service-url';
