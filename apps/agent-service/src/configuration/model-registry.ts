import { ClineAssistantChatAdapter, ClineAssistantRouterAdapter, clineCodingAgentFromConfig,
  type AssistantChatPort, type AssistantRouterPort, type CodingAgentPort, type SkillProvider } from '@ui-agent/agent-runtime';
import type { ServiceConfig } from './service-config';

export function createModelRegistry(config: ServiceConfig, env: NodeJS.ProcessEnv, skills: SkillProvider,
  overrides: { chat?: AssistantChatPort; router?: AssistantRouterPort; coding?: CodingAgentPort }) {
  const definitions = [
    { id: 'default', label: config.model.providerLabel === 'deepseek' ? 'DeepSeek' : config.model.name,
      ...config.model, apiKeyEnv: 'MODEL_API_KEY', enableThinking: undefined as boolean | undefined,
      apiProtocol: 'chat-completions' as const },
    ...(config.model.alternatives ?? [])
  ];
  if (new Set(definitions.map(item => item.id)).size !== definitions.length) throw new Error('模型 ID 重复');
  const cache = new Map<string, { chat: AssistantChatPort; router: AssistantRouterPort; coding: CodingAgentPort }>();
  const definition = (id = 'default') => {
    const item = definitions.find(item => item.id === id);
    if (!item) throw new Error('所选模型未配置，请重新选择模型');
    return item;
  };
  return {
    catalog: () => ({ defaultId: 'default', models: definitions.map(item => ({ id: item.id,
      label: item.label, name: item.name, available: Boolean(env[item.apiKeyEnv]?.trim()) })) }),
    metadata: (id?: string) => {
      const item = definition(id);
      return { mode: 'remote', provider: item.providerLabel, name: item.name };
    },
    get: (id = 'default') => {
      const item = definition(id);
      const existing = cache.get(id);
      if (existing) return existing;
      const custom = id === 'default' ? overrides : {};
      const apiKey = env[item.apiKeyEnv]?.trim();
      if (!apiKey && !(custom.chat && custom.router && custom.coding)) {
        throw new Error(`模型 ${item.label} 未就绪，请在服务端配置 ${item.apiKeyEnv}`);
      }
      const options = { baseUrl: item.baseUrl, modelName: item.name, apiKey: apiKey ?? '',
        enableThinking: item.enableThinking, reasoningEffort: item.reasoningEffort, apiProtocol: item.apiProtocol, skills };
      const agents = {
        chat: custom.chat ?? new ClineAssistantChatAdapter(options),
        router: custom.router ?? new ClineAssistantRouterAdapter({ ...options, ...config.model.router }),
        coding: custom.coding ?? clineCodingAgentFromConfig({ ...options, ...config.model.edit, editReasoning: item.editReasoning,
          reasoningProvider: item.providerLabel === 'qwen' ? 'qwen' : item.providerLabel === 'deepseek' ? 'deepseek' : undefined })
      };
      cache.set(id, agents);
      return agents;
    }
  };
}
