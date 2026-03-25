import { Type } from "@sinclair/typebox";

// Track if we've already logged registration to prevent spam
let registrationLogged = false;

// Current session context (set during hooks)
let currentSessionId: string | null = null;

interface Mem0Config {
  baseUrl: string;
  userId: string;
  autoCapture: boolean;
  autoRecall: boolean;
  recallLimit: number;
  recallThreshold: number;
  customPrompt: string | null;
  memoryType: string | null;
  infer: boolean;
}

interface Memory {
  id: string;
  memory: string;
  score?: number;
  metadata?: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}

interface SearchResponse {
  results: Memory[];
  memories?: Memory[];
}

interface AddResponse {
  results: Array<{
    id: string;
    memory: string;
    event?: string;
  }>;
  relations?: any;
}

const configSchema = {
  parse(value: unknown): Mem0Config {
    const v = (value as any) || {};
    return {
      baseUrl: v.baseUrl || "http://127.0.0.1:8420",
      userId: v.userId || "openclaw",
      autoCapture: v.autoCapture !== false,
      autoRecall: v.autoRecall !== false,
      recallLimit: v.recallLimit || 5,
      recallThreshold: v.recallThreshold || 0.5,
      customPrompt: v.customPrompt || null,
      memoryType: v.memoryType || null,
      infer: v.infer !== false,
    };
  },
};

class Mem0Client {
  private config: Mem0Config;
  private healthChecked = false;

  constructor(config: Mem0Config) {
    this.config = config;
  }

  async ensureHealthy(): Promise<void> {
    if (this.healthChecked) return;

    try {
      const response = await fetch(`${this.config.baseUrl}/memories?user_id=${this.config.userId}&limit=1`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        console.warn(`[memory-mem0] Health check failed: ${response.status}`);
      } else {
        console.log(`[memory-mem0] Connected to Mem0 server at ${this.config.baseUrl}`);
      }
      this.healthChecked = true;
    } catch (error) {
      console.warn(`[memory-mem0] Could not connect to Mem0 server:`, error);
    }
  }

  private buildUserId(agentId?: string, sessionKey?: string): string {
    let userId = this.config.userId;

    // If agentId is provided, use agent namespace
    if (agentId && agentId !== "main") {
      userId = `${this.config.userId}:agent:${agentId}`;
    } else if (sessionKey) {
      // Parse agent from session key pattern: "agent:<name>:<uuid>"
      const match = sessionKey.match(/^agent:([^:]+):/);
      if (match && match[1] !== "main") {
        userId = `${this.config.userId}:agent:${match[1]}`;
      }
    }

    return userId;
  }

  async search(
    query: string,
    options?: {
      limit?: number;
      agentId?: string;
      scope?: "session" | "long-term" | "all";
      sessionKey?: string;
    }
  ): Promise<Memory[]> {
    await this.ensureHealthy();

    const userId = this.buildUserId(options?.agentId, options?.sessionKey);
    const limit = options?.limit || this.config.recallLimit;

    try {
      const body: any = {
        query,
        user_id: userId,
        limit,
        threshold: this.config.recallThreshold,
      };

      // Add run_id for session-scoped search
      if (options?.scope === "session" && options?.sessionKey) {
        body.run_id = options.sessionKey;
      }

      // Add agent_id if provided
      if (options?.agentId) {
        body.agent_id = options.agentId;
      }

      const response = await fetch(`${this.config.baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data: SearchResponse = await response.json();
      let results = data.results || [];

      // Filter by scope (for long-term, exclude session memories)
      if (options?.scope === "long-term") {
        results = results.filter((m) => !m.metadata?.run_id);
      }

      // Score-based filtering: keep only results within 50% of top score
      if (results.length > 1) {
        const topScore = results[0]?.score || 0;
        if (topScore > 0) {
          results = results.filter(m => (m.score || 0) >= topScore * 0.5);
        }
      }

      // Limit results
      return results.slice(0, limit);
    } catch (error) {
      console.error("[memory-mem0] Search error:", error);
      return [];
    }
  }

  async add(
    content: string,
    options?: {
      agentId?: string;
      longTerm?: boolean;
      sessionKey?: string;
    }
  ): Promise<AddResponse | null> {
    return this.addBatch([content], options);
  }

  async addBatch(
    contents: string[],
    options?: {
      agentId?: string;
      longTerm?: boolean;
      sessionKey?: string;
      addTemporalContext?: boolean;
      customPrompt?: string;
      memoryType?: string;
      infer?: boolean;
    }
  ): Promise<AddResponse | null> {
    await this.ensureHealthy();

    const userId = this.buildUserId(options?.agentId, options?.sessionKey);

    // Add temporal context for better extraction
    let messages = contents.map((content) => ({ role: "user", content }));
    if (options?.addTemporalContext !== false) {
      const timestamp = new Date().toISOString().split("T")[0];
      messages.unshift({
        role: "system",
        content: `Current date: ${timestamp}. The user is identified as "${userId}". Extract durable facts from this conversation. Include this date when storing time-sensitive information.`
      });
    }

    const body: any = {
      messages,
      user_id: userId,
    };

    // Add run_id for session-scoped memories
    if (!options?.longTerm && options?.sessionKey) {
      body.run_id = options.sessionKey;
    }

    // Add agent_id directly
    if (options?.agentId) {
      body.agent_id = options.agentId;
      body.metadata = { agent_id: options.agentId };
    }

    // Add custom prompt for extraction
    const prompt = options?.customPrompt || this.config.customPrompt;
    if (prompt) {
      body.prompt = prompt;
    }

    // Add memory type
    const memoryType = options?.memoryType || this.config.memoryType;
    if (memoryType) {
      body.memory_type = memoryType;
    }

    // Add infer flag
    if (options?.infer !== undefined) {
      body.infer = options.infer;
    } else if (!this.config.infer) {
      body.infer = false;
    }

    try {
      const response = await fetch(`${this.config.baseUrl}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Add failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error("[memory-mem0] Add error:", error);
      return null;
    }
  }

  async addWithDedup(
    content: string,
    options?: {
      agentId?: string;
      longTerm?: boolean;
      sessionKey?: string;
    }
  ): Promise<{ added: boolean; updated: boolean; result: AddResponse | null }> {
    // Check for similar memories
    const preview = content.slice(0, 200);
    const existing = await this.search(preview, {
      limit: 3,
      agentId: options?.agentId,
      sessionKey: options?.sessionKey,
    });

    // Filter for high similarity (>85%)
    const similar = existing.filter(m => (m.score || 0) >= 0.85);

    if (similar.length > 0) {
      // Mem0 will likely update instead of add
      const result = await this.add(content, options);
      const updated = result?.results?.some(r => r.event === "UPDATE") || false;
      return { added: !updated, updated, result };
    }

    // No similar memories found, add normally
    const result = await this.add(content, options);
    return { added: true, updated: false, result };
  }

  async get(id: string): Promise<Memory | null> {
    await this.ensureHealthy();

    try {
      const response = await fetch(`${this.config.baseUrl}/memories/${id}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Get failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error("[memory-mem0] Get error:", error);
      return null;
    }
  }

  async list(options?: {
    agentId?: string;
    scope?: "session" | "long-term" | "all";
    sessionKey?: string;
  }): Promise<Memory[]> {
    await this.ensureHealthy();

    const userId = this.buildUserId(options?.agentId, options?.sessionKey);

    const params = new URLSearchParams({ user_id: userId });

    try {
      const response = await fetch(`${this.config.baseUrl}/memories?${params}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        throw new Error(`List failed: ${response.statusText}`);
      }

      const data: SearchResponse = await response.json();
      let results = data.results || [];

      // Filter by scope if specified
      if (options?.scope === "session" && options?.sessionKey) {
        results = results.filter((m) => m.metadata?.run_id === options.sessionKey);
      } else if (options?.scope === "long-term") {
        results = results.filter((m) => !m.metadata?.run_id);
      }

      return results;
    } catch (error) {
      console.error("[memory-mem0] List error:", error);
      return [];
    }
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureHealthy();

    try {
      const response = await fetch(`${this.config.baseUrl}/memories/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Delete failed: ${response.statusText}`);
      }

      return true;
    } catch (error) {
      console.error("[memory-mem0] Delete error:", error);
      return false;
    }
  }

  async deleteByQuery(query: string, options?: { agentId?: string; sessionKey?: string }): Promise<number> {
    const memories = await this.search(query, { ...options, limit: 20 });
    let deleted = 0;

    for (const memory of memories) {
      if (await this.delete(memory.id)) {
        deleted++;
      }
    }

    return deleted;
  }

  async deleteAll(agentId?: string): Promise<boolean> {
    await this.ensureHealthy();

    const userId = this.buildUserId(agentId);

    try {
      const response = await fetch(`${this.config.baseUrl}/memories?user_id=${userId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      return response.ok;
    } catch (error) {
      console.error("[memory-mem0] Delete all error:", error);
      return false;
    }
  }

  async stats(agentId?: string): Promise<{ total: number; session: number; longTerm: number }> {
    const allMemories = await this.list({ agentId });
    return {
      total: allMemories.length,
      session: allMemories.filter((m) => m.metadata?.run_id).length,
      longTerm: allMemories.filter((m) => !m.metadata?.run_id).length,
    };
  }
}

// Noise filtering utilities
const NOISE_PATTERNS = [
  /^(HEARTBEAT_OK|NO_REPLY|PONG)$/i,
  /^[\d\-:T.]+Z?$/, // Timestamps
  /^(ok|sure|done|yes|no|thanks|thx|ty|np)$/i,
  /^.{0,10}$/, // Very short messages
];

const SYSTEM_MESSAGE_PATTERNS = [
  /\[.*?\]/,
  /scheduled.*?job/i,
  /cron.*?run/i,
  /heartbeat/i,
  /automation/i,
];

const GENERIC_ASSISTANT_PATTERNS = [
  /^(I see|I understand|Got it|Noted|Sure|Of course|Absolutely|Certainly)[^.]*(?:\.|$)/i,
  /^(How can I help|What can I do|Is there anything)[^?]*/i,
  /^(Thank you|Thanks)[^.]*\./i,
  /^I've (received|seen|noted)[^.]*\./i,
];

const CONTENT_NOISE_PATTERNS = [
  /\[media:.*?\]/g,
  /\[image:.*?\]/g,
  /\[video:.*?\]/g,
  /\[audio:.*?\]/g,
  /\[file:.*?\]/g,
  /\[document:.*?\]/g,
  /\[location:.*?\]/g,
  /\[contact:.*?\]/g,
  /\[sticker:.*?\]/g,
  /\[poll:.*?\]/g,
  /\[reaction:.*?\]/g,
  /Sent from my .*/i,
  /Get Outlook for .*/i,
  /Begin forwarded message:/i,
  /---------- Forwarded message ---------/i,
];

const MAX_MESSAGE_LENGTH = 2000;

function isNoise(text: string): boolean {
  if (!text || text.trim().length < 10) return true;

  const trimmed = text.trim();

  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  for (const pattern of SYSTEM_MESSAGE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

function isGenericAssistant(text: string): boolean {
  if (!text || text.length > 200) return false;

  const trimmed = text.trim();

  for (const pattern of GENERIC_ASSISTANT_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

function stripNoiseContent(text: string): string {
  let cleaned = text;

  for (const pattern of CONTENT_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Collapse multiple whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

function truncate(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

function shouldSkipTrigger(trigger: string, sessionKey: string): boolean {
  // Skip non-interactive triggers
  const skipPatterns = ["cron", "heartbeat", "automation", "schedule"];
  const lowerTrigger = trigger.toLowerCase();
  const lowerSessionKey = sessionKey.toLowerCase();

  for (const pattern of skipPatterns) {
    if (lowerTrigger.includes(pattern) || lowerSessionKey.includes(`:${pattern}:`)) {
      return true;
    }
  }

  return false;
}

export default {
  id: "memory-mem0",
  name: "Mem0 Memory",
  description:
    "Long-term semantic memory via a self-hosted Mem0 REST API",
  kind: "memory" as const,
  configSchema,

  register(api: any) {
    const config = configSchema.parse(api.pluginConfig);
    const client = new Mem0Client(config);

    // ============ AGENT TOOLS ============

    // Tool: memory_search
    api.registerTool(
      {
        name: "memory_search",
        label: "Search Memory",
        description: "Search memories by natural language",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(
            Type.Number({
              description: "Maximum number of results (default 5)",
              minimum: 1,
              maximum: 20,
            })
          ),
          agentId: Type.Optional(
            Type.String({ description: "Scope search to specific agent's namespace" })
          ),
          scope: Type.Optional(
            Type.Union(
              [Type.Literal("session"), Type.Literal("long-term"), Type.Literal("all")],
              { description: "Memory scope to search (default: all)" }
            )
          ),
        }),
        async execute(
          toolCallId: string,
          params: { query: string; limit?: number; agentId?: string; scope?: string }
        ) {
          const memories = await client.search(params.query, {
            limit: params.limit,
            agentId: params.agentId,
            scope: params.scope as any,
            sessionKey: currentSessionId || undefined,
          });

          if (memories.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No relevant memories found for: "${params.query}"`,
                },
              ],
            };
          }

          const formatted = memories
            .map((m, i) => {
              const score = m.score !== undefined ? ` (relevance: ${m.score.toFixed(2)})` : "";
              return `${i + 1}. ${m.memory}${score}`;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${memories.length} relevant memories:\n\n${formatted}`,
              },
            ],
          };
        },
      },
      { name: "memory_search" }
    );

    // Tool: memory_list
    api.registerTool(
      {
        name: "memory_list",
        label: "List Memories",
        description: "List all stored memories",
        parameters: Type.Object({
          agentId: Type.Optional(
            Type.String({ description: "Scope list to specific agent's namespace" })
          ),
          scope: Type.Optional(
            Type.Union(
              [Type.Literal("session"), Type.Literal("long-term"), Type.Literal("all")],
              { description: "Memory scope to list (default: all)" }
            )
          ),
        }),
        async execute(
          toolCallId: string,
          params: { agentId?: string; scope?: string }
        ) {
          const memories = await client.list({
            agentId: params.agentId,
            scope: params.scope as any,
            sessionKey: currentSessionId || undefined,
          });

          if (memories.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No memories stored yet.",
                },
              ],
            };
          }

          const formatted = memories
            .map((m, i) => `${i + 1}. ${m.memory} (ID: ${m.id})`)
            .join("\n");

          return {
            content: [
              {
                type: "text" as const,
                text: `Total memories: ${memories.length}\n\n${formatted}`,
              },
            ],
          };
        },
      },
      { name: "memory_list" }
    );

    // Tool: memory_store
    api.registerTool(
      {
        name: "memory_store",
        label: "Store Memory",
        description: "Store a new fact or context in memory",
        parameters: Type.Object({
          content: Type.String({
            description: "Fact or context to remember",
          }),
          agentId: Type.Optional(
            Type.String({ description: "Agent ID for metadata (optional)" })
          ),
          longTerm: Type.Optional(
            Type.Boolean({
              description: "Store as long-term memory (default: true)",
            })
          ),
        }),
        async execute(
          toolCallId: string,
          params: { content: string; agentId?: string; longTerm?: boolean }
        ) {
          const result = await client.addWithDedup(params.content, {
            agentId: params.agentId,
            longTerm: params.longTerm !== false,
            sessionKey: currentSessionId || undefined,
          });

          if (!result.result || !result.result.results || result.result.results.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Failed to store memory.",
                },
              ],
            };
          }

          const action = result.updated ? "Updated" : "Stored";
          const stored = result.result.results.map((r) => r.memory).join(", ");
          return {
            content: [
              {
                type: "text" as const,
                text: `${action} in memory: ${stored}`,
              },
            ],
          };
        },
      },
      { name: "memory_store" }
    );

    // Tool: memory_get
    api.registerTool(
      {
        name: "memory_get",
        label: "Get Memory",
        description: "Retrieve a specific memory by ID",
        parameters: Type.Object({
          id: Type.String({ description: "Memory ID to retrieve" }),
        }),
        async execute(toolCallId: string, params: { id: string }) {
          const memory = await client.get(params.id);

          if (!memory) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Memory not found: ${params.id}`,
                },
              ],
            };
          }

          const scope = memory.metadata?.run_id ? "session" : "long-term";
          return {
            content: [
              {
                type: "text" as const,
                text: `Memory: ${memory.memory}\nID: ${memory.id}\nScope: ${scope}\nCreated: ${memory.created_at || "unknown"}`,
              },
            ],
          };
        },
      },
      { name: "memory_get" }
    );

    // Tool: memory_forget
    api.registerTool(
      {
        name: "memory_forget",
        label: "Forget Memory",
        description: "Delete a memory by ID or search query",
        parameters: Type.Object({
          id: Type.Optional(Type.String({ description: "Memory ID to delete" })),
          query: Type.Optional(Type.String({ description: "Search query to delete matching memories" })),
          agentId: Type.Optional(
            Type.String({ description: "Scope deletion to specific agent's namespace" })
          ),
        }),
        async execute(toolCallId: string, params: { id?: string; query?: string; agentId?: string }) {
          if (params.id) {
            const success = await client.delete(params.id);
            return {
              content: [
                {
                  type: "text" as const,
                  text: success
                    ? `Deleted memory: ${params.id}`
                    : `Failed to delete memory: ${params.id}`,
                },
              ],
            };
          }

          if (params.query) {
            const results = await client.search(params.query, {
              limit: 5,
              agentId: params.agentId,
            });

            if (results.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `No memories found matching: "${params.query}"`,
                  },
                ],
              };
            }

            // Auto-delete if single match or high confidence
            if (results.length === 1 || (results[0].score || 0) > 0.9) {
              const toDelete = results[0];
              const success = await client.delete(toDelete.id);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: success
                      ? `Forgotten: "${toDelete.memory}"`
                      : `Failed to delete: ${toDelete.id}`,
                  },
                ],
              };
            }

            // Multiple candidates - show them
            const candidates = results.map(
              (r, i) => `${i + 1}. [${r.id.slice(0, 8)}...] ${r.memory.slice(0, 80)}${r.memory.length > 80 ? "..." : ""} (score: ${((r.score || 0) * 100).toFixed(0)}%)`
            ).join("\n");

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Found ${results.length} candidates. Specify an ID to delete:\n${candidates}`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: "Please provide either an id or query to delete memories.",
              },
            ],
          };
        },
      },
      { name: "memory_forget" }
    );

    // ============ CLI COMMANDS ============

    api.registerCli(
      ({ program }: any) => {
        const mem0 = program
          .command("mem0")
          .description("Mem0 memory plugin commands");

        mem0
          .command("search")
          .description("Search memories")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .option("--scope <scope>", "Scope: session, long-term, or all", "all")
          .option("--agent <id>", "Search specific agent's namespace")
          .action(async (query: string, opts: any) => {
            const memories = await client.search(query, {
              limit: parseInt(opts.limit),
              scope: opts.scope,
              agentId: opts.agent,
              sessionKey: currentSessionId || undefined,
            });

            if (memories.length === 0) {
              console.log(`No memories found for: "${query}"`);
              return;
            }

            console.log(`\nFound ${memories.length} memories (${opts.scope}):\n`);
            memories.forEach((m, i) => {
              const score = m.score !== undefined ? ` [${m.score.toFixed(2)}]` : "";
              const scope = m.metadata?.run_id ? "session" : "long-term";
              console.log(`${i + 1}. ${m.memory}${score}`);
              console.log(`   ID: ${m.id} | Scope: ${scope}\n`);
            });
          });

        mem0
          .command("list")
          .description("List all stored memories")
          .option("--scope <scope>", "Scope: session, long-term, or all", "all")
          .option("--agent <id>", "List specific agent's namespace")
          .action(async (opts: any) => {
            const memories = await client.list({
              scope: opts.scope,
              agentId: opts.agent,
              sessionKey: currentSessionId || undefined,
            });

            if (memories.length === 0) {
              console.log("No memories stored yet.");
              return;
            }

            console.log(`\nTotal memories: ${memories.length} (${opts.scope}):\n`);
            memories.forEach((m, i) => {
              const scope = m.metadata?.run_id ? "session" : "long-term";
              console.log(`${i + 1}. ${m.memory}`);
              console.log(`   ID: ${m.id} | Scope: ${scope}\n`);
            });
          });

        mem0
          .command("get")
          .description("Get a memory by ID")
          .argument("<id>", "Memory ID")
          .action(async (id: string) => {
            const memory = await client.get(id);
            if (!memory) {
              console.log(`Memory not found: ${id}`);
              return;
            }
            const scope = memory.metadata?.run_id ? "session" : "long-term";
            console.log(`\nMemory: ${memory.memory}`);
            console.log(`ID: ${memory.id}`);
            console.log(`Scope: ${scope}`);
            console.log(`Created: ${memory.created_at || "unknown"}\n`);
          });

        mem0
          .command("forget")
          .description("Delete a memory by ID or query")
          .argument("<idOrQuery>", "Memory ID or search query")
          .option("--query", "Treat argument as search query")
          .option("--agent <id>", "Scope deletion to specific agent")
          .action(async (idOrQuery: string, opts: any) => {
            if (opts.query) {
              const deleted = await client.deleteByQuery(idOrQuery, { agentId: opts.agent });
              console.log(`Deleted ${deleted} memory(s) matching: "${idOrQuery}"`);
            } else {
              const success = await client.delete(idOrQuery);
              console.log(success ? `Deleted: ${idOrQuery}` : `Failed to delete: ${idOrQuery}`);
            }
          });

        mem0
          .command("clear")
          .description("Delete all memories for user or agent")
          .option("--agent <id>", "Clear specific agent's namespace")
          .option("--confirm", "Skip confirmation prompt")
          .action(async (opts: any) => {
            if (!opts.confirm) {
              console.log("This will delete ALL memories. Use --confirm to proceed.");
              return;
            }
            const success = await client.deleteAll(opts.agent);
            if (success) {
              console.log(`Deleted all memories${opts.agent ? ` for agent: ${opts.agent}` : ''}`);
            } else {
              console.log("Failed to delete memories");
            }
          });

        mem0
          .command("stats")
          .description("Show memory statistics")
          .option("--agent <id>", "Stats for specific agent's namespace")
          .action(async (opts: any) => {
            const stats = await client.stats(opts.agent);
            const scope = opts.agent ? `agent: ${opts.agent}` : "all";
            console.log(`\nMemory Statistics (${scope}):`);
            console.log(`  Total: ${stats.total}`);
            console.log(`  Long-term: ${stats.longTerm}`);
            console.log(`  Session: ${stats.session}\n`);
          });
      },
      { commands: ["mem0"] }
    );

    // ============ LIFECYCLE HOOKS ============

    // Store session context for hooks
    api.on("before_prompt_build", async (event: any) => {
      // Update session context
      currentSessionId = event.sessionKey || event.ctx?.sessionKey || null;

      // Skip non-interactive triggers
      const trigger = event.trigger || event.ctx?.trigger || "";
      if (currentSessionId && shouldSkipTrigger(trigger, currentSessionId)) {
        return;
      }

      if (!config.autoRecall) return;

      const messages = event.messages || [];
      const lastUserMsg = messages
        .slice()
        .reverse()
        .find((m: any) => m.role === "user");

      if (!lastUserMsg) return;

      // Extract prompt text
      let prompt = "";
      const content = lastUserMsg.content;
      if (typeof content === "string") {
        prompt = content;
      } else if (Array.isArray(content)) {
        prompt = content
          .filter((c: any) => c.type === "text" || typeof c === "string")
          .map((c: any) => (typeof c === "string" ? c : c.text || ""))
          .join(" ");
      }

      if (!prompt || isNoise(prompt)) return;

      // Parse agent from session key for namespace
      let agentId: string | undefined;
      let isSubagent = false;
      if (currentSessionId) {
        // Check for subagent pattern: agent:main:subagent:<uuid>
        const subagentMatch = currentSessionId.match(/^agent:main:subagent:/);
        if (subagentMatch) {
          isSubagent = true;
          // Subagents use parent (main) namespace for recall
          agentId = undefined;
        } else {
          const match = currentSessionId.match(/^agent:([^:]+):/);
          if (match && match[1] !== "main") {
            agentId = match[1];
          }
        }
      }

      // Search long-term memories
      let longTermMemories = await client.search(prompt, {
        limit: config.recallLimit * 2,
        agentId,
        scope: "long-term",
      });

      // Apply threshold filtering
      longTermMemories = longTermMemories.filter(
        (m) => (m.score || 0) >= config.recallThreshold
      );

      // Score-based filtering: keep only results within 50% of top score
      if (longTermMemories.length > 1) {
        const topScore = longTermMemories[0]?.score || 0;
        if (topScore > 0) {
          longTermMemories = longTermMemories.filter(m => (m.score || 0) >= topScore * 0.5);
        }
      }

      // Broad recall for short prompts or new sessions
      if (prompt.length < 100 || !currentSessionId) {
        const broadQueries = [
          "recent decisions and preferences",
          "active projects and goals",
          "configuration and setup"
        ];

        for (const broadQuery of broadQueries) {
          const broadResults = await client.search(broadQuery, {
            limit: 3,
            agentId,
            scope: "long-term",
          });

          const existingIds = new Set(longTermMemories.map(m => m.id));
          for (const result of broadResults) {
            if (!existingIds.has(result.id) && (result.score || 0) >= 0.5) {
              longTermMemories.push(result);
            }
          }
        }
      }

      // Limit long-term results
      longTermMemories = longTermMemories.slice(0, config.recallLimit);

      // Search session memories
      const sessionMemories = await client.search(prompt, {
        limit: config.recallLimit,
        agentId,
        scope: "session",
        sessionKey: currentSessionId || undefined,
      });

      const relevantLongTerm = longTermMemories.filter(
        (m) => (m.score || 0) >= config.recallThreshold
      );

      const relevantSession = sessionMemories.filter(
        (m) => (m.score || 0) >= config.recallThreshold
      );

      if (relevantLongTerm.length === 0 && relevantSession.length === 0) return;

      // Format memories
      const parts: string[] = [];

      if (relevantLongTerm.length > 0) {
        const formatted = relevantLongTerm
          .map((m) => `- ${m.memory} [score: ${m.score?.toFixed(2)}]`)
          .join("\n");
        parts.push(`Long-term memories:\n${formatted}`);
      }

      if (relevantSession.length > 0) {
        const formatted = relevantSession
          .map((m) => `- ${m.memory} [score: ${m.score?.toFixed(2)}]`)
          .join("\n");
        parts.push(`Session memories:\n${formatted}`);
      }

      if (parts.length === 0) return;

      // Add subagent preamble if needed
      let preamble = "";
      if (isSubagent) {
        preamble = "You are a subagent — use these memories for context but do not assume you are this user.\n\n";
      }

      return {
        prependContext: `<relevant-memories>\n${preamble}${parts.join("\n\n")}\n</relevant-memories>`,
      };
    });

    // Auto-capture: store key facts after agent completes
    if (config.autoCapture) {
      api.on("agent_end", async (event: any) => {
        const sessionKey = event.sessionKey || event.ctx?.sessionKey || null;
        const trigger = event.trigger || event.ctx?.trigger || "";

        // Skip non-interactive triggers
        if (sessionKey && shouldSkipTrigger(trigger, sessionKey)) {
          return;
        }

        // Skip capture for subagents (main agent captures consolidated result)
        if (sessionKey && sessionKey.includes(":subagent:")) {
          return;
        }

        // Parse agent from session key for namespace
        let agentId: string | undefined;
        if (sessionKey) {
          const match = sessionKey.match(/^agent:([^:]+):/);
          if (match && match[1] !== "main") {
            agentId = match[1];
          }
        }

        const messages = event.messages || [];

        for (const msg of messages) {
          if (msg.role === "user" || msg.role === "assistant") {
            let text = "";
            const content = msg.content;
            if (typeof content === "string") {
              text = content;
            } else if (Array.isArray(content)) {
              text = content
                .filter((c: any) => c.type === "text" || typeof c === "string")
                .map((c: any) => (typeof c === "string" ? c : c.text || ""))
                .join(" ");
            }

            // Skip recalled memory context
            if (text.includes("<relevant-memories>")) continue;

            // Strip noise content
            text = stripNoiseContent(text);

            // Truncate long messages
            text = truncate(text);

            // Filter noise
            if (isNoise(text)) continue;

            // Skip generic assistant messages
            if (msg.role === "assistant" && isGenericAssistant(text)) continue;

            // Only capture substantial messages
            if (text.trim().length < 50) continue;

            await client.add(text, {
              agentId,
              longTerm: false,
              sessionKey: sessionKey || undefined,
            });
          }
        }
      });
    }

    if (!registrationLogged) {
      console.log(
        `[memory-mem0] Plugin registered (autoRecall=${config.autoRecall}, autoCapture=${config.autoCapture})`
      );
      registrationLogged = true;
    }
  },
};
