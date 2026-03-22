/**
 * Minimal stubs for openclaw/plugin-sdk/* so the plugin compiles without
 * the full OpenClaw monorepo installed. At runtime the real SDK is provided
 * by the OpenClaw gateway process.
 */
declare module 'openclaw/plugin-sdk/plugin-entry' {
  export interface PluginApi {
    /** Access plugin-level config set in openclaw.json under plugins.entries.<id>.config */
    getConfig?(): Record<string, unknown>;
    /** Register an agent tool. Accepts a factory or a static definition. */
    registerTool(factory: (ctx: ToolContext) => ToolDefinition | ToolDefinition[] | null, options?: { names?: string[] }): void;
    registerTool(definition: ToolDefinition, options?: { optional?: boolean }): void;
    /** Subscribe to gateway lifecycle events. */
    on(event: string, handler: (ctx: any) => void | Promise<void>): void;
    /** Low-level runtime access (LLM, tools, etc.) */
    runtime?: {
      llm?: {
        complete(prompt: string, options?: { model?: string }): Promise<string>;
      };
      tools?: Record<string, unknown>;
    };
  }

  export interface ToolContext {
    sessionKey: string;
    config: Record<string, unknown>;
  }

  export interface ToolDefinition {
    name: string;
    description: string;
    parameters: unknown;
    execute(id: string, params: unknown, ctx?: unknown): Promise<ToolResult>;
  }

  export interface ToolResult {
    content: Array<{ type: string; text: string }>;
  }

  export interface PluginEntry {
    id: string;
    name: string;
    description?: string;
    register(api: PluginApi): void;
  }

  export function definePluginEntry(entry: PluginEntry): PluginEntry;
}
