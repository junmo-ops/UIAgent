import { storage } from 'wxt/utils/storage';
import { DEFAULT_AGENT_SERVICE_URL } from './agent-service-url';

export const agentServiceUrlItem = storage.defineItem<string>('local:agentServiceUrl', {
  fallback: DEFAULT_AGENT_SERVICE_URL
});

export async function getAgentServiceUrl(): Promise<string> {
  const stored = await agentServiceUrlItem.getValue();
  const localDefault = 'http://127.0.0.1:8787';
  if (stored === localDefault && DEFAULT_AGENT_SERVICE_URL !== localDefault) {
    await agentServiceUrlItem.setValue(DEFAULT_AGENT_SERVICE_URL);
    return DEFAULT_AGENT_SERVICE_URL;
  }
  return stored;
}

export { DEFAULT_AGENT_SERVICE_URL } from './agent-service-url';
