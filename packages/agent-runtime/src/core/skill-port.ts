export interface SkillSummary {
  defaultEnabled?: boolean;
  id: string;
  displayName?: string;
  description: string;
  version: string;
  scripts: Array<{ path: string; runtime: 'node' | 'python'; available: boolean }>;
}

/** Published, trusted skill packages; never a shell or unrestricted file tool. */
export interface SkillSession {
  prompt: string;
  /** Live session state, including a skill preloaded when the session opens. */
  readonly loaded: boolean;
  load(id: string): string;
  read(path: string): string;
  run(script: string, args: Record<string, unknown>, inputs: Array<{ path: string; text: string }>, signal?: AbortSignal): Promise<string>;
}

export interface SkillProvider {
  list(): SkillSummary[];
  open(id?: string, version?: string, disabledSkillIds?: readonly string[]): SkillSession;
}
