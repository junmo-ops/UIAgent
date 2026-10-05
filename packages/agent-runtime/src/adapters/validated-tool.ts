import { createTool as createRuntimeTool, type AgentTool } from '../../vendor/ui-agent-runtime/index.js';

// Validate before executing any tool or accepting a completion. The runtime
// returns ToolInputValidationError to the model within its existing retry budget.
export function createValidatedTool<TInput, TOutput>(config: AgentTool<TInput, TOutput>): AgentTool<TInput, TOutput> {
  const validateRequiredFields = (
    schema: Record<string, unknown>,
    value: unknown,
    path: string,
    issues: string[]
  ): void => {
    if (Array.isArray(schema.anyOf)) {
      const branches = schema.anyOf as Record<string, unknown>[];
      const branchIssues = branches.map(branch => {
        const errors: string[] = [];
        validateRequiredFields(branch, value, path, errors);
        return errors;
      });
      if (!branchIssues.some(errors => errors.length === 0)) {
        issues.push(`${path}: ${branchIssues.map(errors => errors.join('、')).join('；或 ')}`);
        return;
      }
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      issues.push(`${path} 应为 ${schema.enum.join(' / ')}`);
    }
    if ('const' in schema && value !== schema.const) issues.push(`${path} 应为 ${String(schema.const)}`);
    if ((schema.type === 'number' || schema.type === 'integer') && (typeof value !== 'number'
      || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))
      || (typeof schema.minimum === 'number' && value < schema.minimum)
      || (typeof schema.maximum === 'number' && value > schema.maximum))) {
      issues.push(`${path} 应为范围内的${schema.type === 'integer' ? '整数' : '数字'}`);
    }
    if (schema.type === 'string' && (typeof value !== 'string'
      || (typeof schema.minLength === 'number' && value.length < schema.minLength))) {
      issues.push(`${path} 应为满足长度要求的字符串`);
    }
    if (schema.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        issues.push(`${path || 'input'} 应为对象`);
        return;
      }
      const record = value as Record<string, unknown>;
      for (const key of (schema.required as string[] | undefined) ?? []) {
        if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined || record[key] === null) {
          issues.push(path ? `${path}.${key}` : key);
        }
      }
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      for (const [key, propertySchema] of Object.entries(properties ?? {})) {
        if (record[key] !== undefined && record[key] !== null) {
          validateRequiredFields(propertySchema, record[key], path ? `${path}.${key}` : key, issues);
        }
      }
      return;
    }
    if (schema.type === 'array') {
      if (!Array.isArray(value)) {
        issues.push(`${path} 应为数组`);
        return;
      }
      const itemSchema = schema.items as Record<string, unknown> | undefined;
      if ((typeof schema.minItems === 'number' && value.length < schema.minItems)
        || (typeof schema.maxItems === 'number' && value.length > schema.maxItems)) {
        const limits = [typeof schema.minItems === 'number' ? `至少 ${schema.minItems}` : '',
          typeof schema.maxItems === 'number' ? `至多 ${schema.maxItems}` : ''].filter(Boolean).join('、');
        issues.push(`${path} 数组长度为 ${value.length}，要求${limits}项`);
      }
      if (itemSchema) value.forEach((item, index) => validateRequiredFields(itemSchema, item, `${path}[${index}]`, issues));
    }
  };
  return createRuntimeTool({
    ...config,
    execute: (input, context) => {
      const issues: string[] = [];
      // Earlier calls in the same model batch may have changed workflow state.
      const schema = config.resolveInputSchema?.(config.inputSchema) ?? config.inputSchema;
      validateRequiredFields(schema, input, '', issues);
      if (issues.length) {
        // Only schema-owned field names and value types; never log argument values.
        const typeOf = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
        const properties = schema.properties as Record<string, unknown> | undefined;
        const types = Object.keys(properties ?? {}).slice(0, 32)
          .map(key => `${key}=${Object.prototype.hasOwnProperty.call(record, key) ? typeOf(record[key]) : 'missing'}`);
        throw Object.assign(new Error(`[工具参数校验] ${config.name} 缺少或错误的必填参数：${issues.join('、')}；收到类型：input=${typeOf(input)}, ${types.join(', ')}；对象和数组必须直接传 JSON 对象或数组，不能传序列化字符串；本次未执行`), { name: 'ToolInputValidationError' });
      }
      return config.execute(input, context);
    }
  });
}
