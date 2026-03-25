# memory-mem0

OpenClaw memory plugin backed by a self-hosted [Mem0](https://github.com/mem0ai/mem0) REST API.

Provides long-term semantic memory for OpenClaw agents with session scopes, agent isolation, and advanced filtering — all via a simple HTTP API.

## Features

- **Five agent tools**: `memory_search`, `memory_list`, `memory_store`, `memory_get`, `memory_forget`
- **Memory scopes**: Session (short-term) and long-term memory
- **Agent isolation**: Per-agent memory namespaces
- **Auto-recall**: Injects relevant memories before each agent execution
- **Auto-capture**: Stores conversation highlights after each agent execution
- **Noise filtering**: Filters system messages, heartbeats, and boilerplate
- **Content stripping**: Removes media metadata and routing info
- **Truncation**: Caps messages at 2000 characters
- **Smart deduplication**: Checks for similar memories before storing
- **Broad recall**: Searches for recent decisions/preferences on short prompts
- **CLI commands**: `openclaw mem0 search|list|get|forget|clear|stats`
- **Graceful degradation**: Logs warnings if the Mem0 server is unreachable
- **Zero native dependencies**: Uses Node.js built-in `fetch()`

## Prerequisites

A running Mem0 REST API server. You can set one up with:

- [mem0ai](https://github.com/mem0ai/mem0) (self-hosted, Docker recommended)
- Any HTTP server implementing the Mem0 REST API

### Required REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/search` | Search memories |
| POST | `/memories` | Store memories |
| GET | `/memories?user_id=...` | List memories |
| GET | `/memories/:id` | Get memory by ID |
| DELETE | `/memories/:id` | Delete memory |
| DELETE | `/memories?user_id=...` | Delete all memories |

## Installation

```bash
git clone https://github.com/SultanKs4/openclaw-memory-mem0.git ~/.openclaw/extensions/memory-mem0
cd ~/.openclaw/extensions/memory-mem0
npm install
```

Or install via OpenClaw CLI:

```bash
openclaw plugins install git@github.com:SultanKs4/openclaw-memory-mem0.git
```

## Configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-mem0"
    },
    "entries": {
      "memory-mem0": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:8000",
          "userId": "sultan",
          "autoCapture": true,
          "autoRecall": true,
          "recallLimit": 5,
          "recallThreshold": 0.5
        }
      }
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | string | `http://127.0.0.1:8000` | Mem0 REST API base URL |
| `userId` | string | `openclaw` | User ID for memory partitioning |
| `autoCapture` | boolean | `true` | Store conversation context after agent execution |
| `autoRecall` | boolean | `true` | Inject relevant memories before agent execution |
| `recallLimit` | number | `5` | Max memories to inject per query |
| `recallThreshold` | number | `0.5` | Min relevance score for auto-recall (0.0-1.0) |
| `customPrompt` | string | `null` | Custom prompt for memory extraction |
| `memoryType` | string | `null` | Type of memory to store (e.g. "core") |
| `infer` | boolean | `true` | Whether to extract facts from messages |

> **Note:** Use `127.0.0.1` instead of `localhost` — Node.js 22+ prefers IPv6 (`::1`), which will fail if your Mem0 server only binds IPv4.

## Agent Tools

### memory_search

Search memories by natural language.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `limit` | number | no | Max results (default: 5, max: 20) |
| `scope` | string | no | Memory scope: "session", "long-term", or "all" |
| `agentId` | string | no | Scope search to specific agent's namespace |

### memory_list

List all stored memories.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `scope` | string | no | Memory scope: "session", "long-term", or "all" |
| `agentId` | string | no | Scope list to specific agent's namespace |

### memory_store

Store a new fact or context in memory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | yes | Fact or context to remember |
| `agentId` | string | no | Agent ID for namespace isolation |
| `longTerm` | boolean | no | Store as long-term memory (default: true) |

### memory_get

Retrieve a specific memory by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Memory ID to retrieve |

### memory_forget

Delete a memory by ID or search query.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | no* | Memory ID to delete |
| `query` | string | no* | Search query to find and delete memories |
| `agentId` | string | no | Scope deletion to specific agent's namespace |

*Provide either `id` or `query`.

## CLI Commands

```bash
# Search memories
openclaw mem0 search "project architecture"
openclaw mem0 search "email" --scope long-term --limit 3
openclaw mem0 search "prefs" --agent researcher

# List all stored memories
openclaw mem0 list
openclaw mem0 list --scope session
openclaw mem0 list --agent researcher

# Get a memory by ID
openclaw mem0 get <memory-id>

# Delete a memory by ID
openclaw mem0 forget <memory-id>

# Delete memories by query (shows candidates)
openclaw mem0 forget "old project" --query

# Delete all memories
openclaw mem0 clear --confirm
openclaw mem0 clear --agent researcher --confirm

# Show memory statistics
openclaw mem0 stats
openclaw mem0 stats --agent researcher
```

## Memory Scopes

Memories are organized into two scopes:

- **Long-term**: Persists across all sessions for the user
- **Session**: Scoped to the current conversation (via `run_id`)

During auto-recall, both scopes are searched and presented separately:

```xml
<relevant-memories>
Long-term memories:
- User prefers dark mode [score: 0.87]

Session memories:
- User is working on project X [score: 0.82]
</relevant-memories>
```

## Agent Isolation

In multi-agent setups, each agent automatically gets its own memory namespace:

- Agent `researcher` stores memories under `userId:agent:researcher`
- Agent `writer` stores memories under `userId:agent:writer`
- Different agents never see each other's memories unless explicitly queried

Session keys following the pattern `agent:<agentId>:<uuid>` are parsed to derive isolated namespaces.

### Cross-Agent Queries

Use the `agentId` parameter to query another agent's memories:

```
memory_search({ query: "tech stack", agentId: "researcher" })
```

## How Auto-Recall Works

When `autoRecall` is enabled, the plugin hooks into `before_prompt_build`:

1. The user's prompt is used as a search query against Mem0
2. Both long-term and session memories are searched
3. Results are filtered by `recallThreshold` and score (within 50% of top score)
4. For short prompts (<100 chars), additional broad recall is performed
5. Relevant memories are prepended to the agent context

## How Auto-Capture Works

When `autoCapture` is enabled, the plugin hooks into `agent_end`:

1. Non-interactive triggers are skipped (cron, heartbeat, automation)
2. Subagent captures are skipped (main agent captures consolidated result)
3. Messages are filtered for noise (system messages, heartbeats, acknowledgments)
4. Generic assistant responses are filtered out
5. Content is stripped of media metadata and routing info
6. Messages are truncated to 2000 characters
7. Remaining substantial messages (>50 chars) are sent to Mem0
8. Temporal context (current date) is added for better extraction

## Architecture

```
Agent
  ├── memory_search  ──→ POST /search     ──→ Mem0 ──→ Vector DB
  ├── memory_list    ──→ GET /memories    ──→ Mem0 ──→ Vector DB
  ├── memory_store   ──→ POST /memories   ──→ Mem0 ──→ LLM ──→ Vector DB
  ├── memory_get     ──→ GET /memories/:id ──→ Mem0
  └── memory_forget  ──→ DELETE /memories  ──→ Mem0
```

The plugin is a thin HTTP client — all heavy lifting (LLM-based fact extraction, embedding generation, vector storage) happens in the Mem0 server.

## Switching from LanceDB

To use Mem0 instead of the default LanceDB memory:

1. Change `plugins.slots.memory` from `"memory-lancedb"` to `"memory-mem0"`
2. Your LanceDB config is preserved — swap back anytime by reverting the slot

## License

MIT
