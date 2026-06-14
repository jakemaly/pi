# Tavily Pi Extension — Implementation Plan

## Overview

Build a standalone Pi extension that replaces `pi-web-access` with Tavily as the sole web provider. Five tools: `search`, `extract`, `crawl`, `map`, `research`. No "tavily" prefix on tool names — the LLM sees clean, generic names.

**Location:** `~/.pi/agent/extensions/tavily/` (directory with `index.ts` entry point)
**Replacement:** Remove `pi-web-access` from `~/.pi/agent/npm/package.json` and `npm uninstall` after this extension is verified working.

---

## Architecture

```
~/.pi/agent/extensions/tavily/
├── package.json        # Extension metadata, no runtime deps needed
├── PLAN.md             # This file
├── index.ts            # Extension entry: config loading, tool registration, commands, events
├── tavily.ts           # HTTP client — POST wrappers for all 5 endpoints
├── config.ts           # Config file I/O (~/.pi/tavily.json)
├── format.ts           # Response formatting (Tavily JSON → markdown for LLM context)
└── types.ts            # Shared TypeScript interfaces for requests/responses
```

**No npm dependencies needed.** Uses Node.js built-in `fetch` (available in the jiti runtime). Only dependency is `typebox` (provided by Pi) for tool schemas, plus `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` (provided by Pi).

---

## Configuration

**File:** `~/.pi/tavily.json`

```json
{
  "apiKey": "tvly-YOUR_KEY",
  "search": {
    "depth": "advanced",
    "maxResults": 5,
    "chunksPerSource": 4
  },
  "extract": {
    "depth": "basic",
    "format": "markdown"
  },
  "crawl": {
    "maxDepth": 2,
    "limit": 50,
    "extractDepth": "basic"
  },
  "map": {
    "maxDepth": 1,
    "limit": 50
  },
  "research": {
    "model": "mini",
    "outputLength": "standard",
    "citationFormat": "numbered"
  }
}
```

- `apiKey` is required (all 5 endpoints need it — keyless only covers search/extract)
- All other fields are optional with sensible defaults
- Loaded at extension init, reloaded on `/reload`

---

## Tool Definitions

### 1. `search`

**Tavily endpoint:** `POST /search`

**Schema:**
```typescript
Type.Object({
  query: Type.String({ description: "The search query" }),
  depth: Type.Optional(StringEnum(["basic", "advanced", "fast", "ultra-fast"] as const)),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  topic: Type.Optional(StringEnum(["general", "news", "finance"] as const)),
  timeRange: Type.Optional(StringEnum(["day", "week", "month", "year"] as const)),
  includeDomains: Type.Optional(Type.Array(Type.String())),
  excludeDomains: Type.Optional(Type.Array(Type.String())),
  includeAnswer: Type.Optional(Type.Boolean()),
})
```

**Description:** "Search the web for real-time information. Returns ranked results with titles, URLs, content snippets, and relevance scores. Use for finding current information, documentation, news, or any topic requiring live web data."

**promptSnippet:** "Search the web for real-time information with ranked results and content snippets."

**promptGuidelines:**
- "Use search when the user asks about current events, recent changes, documentation, or any topic requiring live web data."
- "Use search before extract — find relevant URLs first, then extract full content."
- "Prefer advanced depth for detailed answers; use fast or ultra-fast for quick lookups."

**Response format:** Markdown with answer (if `includeAnswer`), then numbered results with title, URL, content, and score.

---

### 2. `extract`

**Tavily endpoint:** `POST /extract`

**Schema:**
```typescript
Type.Object({
  urls: Type.Union([
    Type.String({ description: "Single URL to extract" }),
    Type.Array(Type.String({ description: "URLs to extract" })),
  ]),
  query: Type.Optional(Type.String({ description: "Query for reranking chunks" })),
  chunksPerSource: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  depth: Type.Optional(StringEnum(["basic", "advanced"] as const)),
  includeImages: Type.Optional(Type.Boolean()),
  format: Type.Optional(StringEnum(["markdown", "text"] as const)),
})
```

**Description:** "Extract clean, structured content from one or more URLs. Returns markdown or plain text with navigation and ads removed. Use after search to get full page content from specific URLs, or when you already know the URLs you need."

**promptSnippet:** "Extract clean markdown content from specific URLs."

**promptGuidelines:**
- "Use extract when you have specific URLs and need full page content."
- "Use search → extract pattern: search to find relevant URLs, then extract for full content."
- "Pass a query parameter to focus extraction on relevant sections of the page."

**Response format:** Per-URL markdown blocks with URL header and extracted content. Failed URLs listed separately.

---

### 3. `crawl`

**Tavily endpoint:** `POST /crawl` (synchronous, up to 150s timeout)

**Schema:**
```typescript
Type.Object({
  url: Type.String({ description: "Root URL to begin crawling" }),
  instructions: Type.Optional(Type.String({ description: "Natural language instructions for the crawler" })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  maxBreadth: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  selectPaths: Type.Optional(Type.Array(Type.String())),
  excludePaths: Type.Optional(Type.Array(Type.String())),
  extractDepth: Type.Optional(StringEnum(["basic", "advanced"] as const)),
  includeImages: Type.Optional(Type.Boolean()),
  format: Type.Optional(StringEnum(["markdown", "text"] as const)),
})
```

**Description:** "Crawl a website and extract content from multiple pages. Graph-based traversal that discovers and extracts content from linked pages. Use when you need to read many pages from a single site, such as documentation sites or blogs."

**promptSnippet:** "Crawl and extract content from multiple pages on a website."

**promptGuidelines:**
- "Use crawl when you need content from many pages on the same site."
- "Use map first to discover site structure, then crawl targeted sections."
- "Use instructions to focus the crawl on specific topics or page types."
- "Keep limit reasonable (default 50) to avoid excessive credit usage."

**Response format:** Per-page markdown with URL headers and extracted content. Truncated to 50KB/2000 lines with temp file fallback for large crawls.

---

### 4. `map`

**Tavily endpoint:** `POST /map`

**Schema:**
```typescript
Type.Object({
  url: Type.String({ description: "Root URL to begin mapping" }),
  instructions: Type.Optional(Type.String({ description: "Natural language instructions for filtering" })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  maxBreadth: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  selectPaths: Type.Optional(Type.Array(Type.String())),
  excludePaths: Type.Optional(Type.Array(Type.String())),
})
```

**Description:** "Generate a site map by discovering all URLs on a website. Returns a list of URLs without content. Use before crawl to understand a site's structure and plan targeted crawling."

**promptSnippet:** "Discover all URLs on a website without extracting content."

**promptGuidelines:**
- "Use map before crawl to understand site structure and plan targeted crawling."
- "Use instructions to filter for specific page types or topics."
- "Map is cheap (1 credit per 10 pages) — use it freely for site exploration."

**Response format:** Numbered URL list grouped by path depth, with base URL and total count.

---

### 5. `research`

**Tavily endpoint:** `POST /research` → polling `GET /research/{request_id}`

**Schema:**
```typescript
Type.Object({
  input: Type.String({ description: "The research question or topic to investigate" }),
  model: Type.Optional(StringEnum(["mini", "pro", "auto"] as const)),
  outputLength: Type.Optional(StringEnum(["short", "standard", "long"] as const)),
  citationFormat: Type.Optional(StringEnum(["numbered", "mla", "apa", "chicago"] as const)),
  includeDomains: Type.Optional(Type.Array(Type.String())),
  excludeDomains: Type.Optional(Type.Array(Type.String())),
})
```

**Description:** "Run comprehensive multi-source research that searches, analyzes sources, and generates a cited report. Use when you need a finished, synthesis-level answer with citations — not raw search results. Returns a complete research report with sources."

**promptSnippet:** "Run comprehensive multi-source research and get a cited report."

**promptGuidelines:**
- "Use research when the user asks for a report, comparison, analysis, or decision-ready answer."
- "Use search when you need raw source URLs and content to process yourself."
- "Research is expensive (4-250 credits) — use it for complex questions only."
- "Research is async — the tool handles polling automatically with progress updates."

**Response format:** The full research report as markdown (Tavily returns it rendered). Includes citations linked to sources.

**Async handling:** Research is async. The tool:
1. POSTs to `/research`, gets `request_id`
2. Polls `GET /research/{request_id}` every 3 seconds
3. Streams progress via `onUpdate` ("Searching...", "Analyzing sources...", "Writing report...")
4. Returns the final report when status is `completed`
5. Respects `signal?.aborted` for cancellation

---

## Commands

### `/tavily`

Show status: API key configured, default settings, and recent activity count.

```typescript
pi.registerCommand("tavily", {
  description: "Show Tavily extension status and settings",
  handler: async (args, ctx) => {
    const config = loadConfig();
    ctx.ui.notify(`Tavily: ${config.apiKey ? "configured" : "no API key"}`, "info");
  },
});
```

---

## Event Handlers

### `session_start`

- Load config
- Validate API key (warn if missing)
- Reset activity counter

### `session_shutdown`

- Clear any in-flight research polling timers

### `tool_call` (activity tracking)

- Log each tool call to a session entry for observability

---

## Module Responsibilities

### `tavily.ts` — HTTP Client

Core function: `tavilyRequest(endpoint, body, signal)`

- Reads API key from config
- Constructs `POST https://api.tavily.com/{endpoint}` with proper headers
- Handles 401 (bad key), 429 (rate limit), 432/433 (plan limits)
- Returns parsed JSON response
- Research polling: `tavilyResearchPoll(requestId, signal)` — polls GET endpoint every 3s

### `config.ts` — Configuration

- `loadConfig()` — reads `~/.pi/tavily.json`, returns merged defaults
- `getConfigPath()` — returns the config file path
- Validates API key format (`tvly-` prefix)

### `format.ts` — Response Formatting

- `formatSearchResults(data)` — Tavily search JSON → markdown
- `formatExtractResults(data)` — Tavily extract JSON → markdown
- `formatCrawlResults(data)` — Tavily crawl JSON → markdown
- `formatMapResults(data)` — Tavily map JSON → markdown
- `formatResearchResult(data)` — Tavily research JSON → markdown
- All functions apply truncation (50KB/2000 lines) via `truncateHead` from Pi

### `types.ts` — TypeScript Interfaces

Request/response types for all 5 endpoints, derived from the OpenAPI specs.

---

## Migration Steps

1. Create extension files in `~/.pi/agent/extensions/tavily/`
2. Write `package.json` with `pi.extensions` entry
3. Create `index.ts`, `tavily.ts`, `config.ts`, `format.ts`, `types.ts`
4. Test in Pi: `pi -e ~/.pi/agent/extensions/tavily/index.ts` (or just restart Pi — auto-discovered)
5. Verify all 5 tools work with the API key
6. Remove `pi-web-access`:
   ```bash
   cd ~/.pi/agent/npm && npm uninstall pi-web-access
   ```
7. Remove the 5 blank skill directories created earlier (if no longer needed)

---

## Design Decisions & Rationale

| Decision | Rationale |
|----------|-----------|
| Direct HTTP, not SDK | No npm dependency needed. Node `fetch` is built-in. Simpler to maintain. |
| No MCP | MCP adds indirection. Direct HTTP gives full control over schemas, errors, and formatting. |
| Tool names without prefix | Clean LLM interface. `search` is more natural than `tavily_search`. No ambiguity since this is the only web provider. |
| Research polling in tool | Hide async complexity from the LLM. The tool handles polling and streams progress. The LLM just sees a completed report. |
| Config in `~/.pi/tavily.json` | Separate from any other config. Clean ownership. |
| `advanced` search default | Recommended by Tavily for agents. Worth the 2-credit cost for quality. |
| No keyless mode | User has an API key and wants Crawl/Map/Research which require one. Keep it simple. |
| Truncation on all tools | Prevent context overflow. Use Pi's `truncateHead` with 50KB/2000 line limits. |

---

## Assumptions

1. Node.js built-in `fetch` is available in Pi's jiti runtime (it is — Pi uses modern Node)
2. `typebox` and `@earendil-works/pi-ai` (for `StringEnum`) are available as Pi-provided imports
3. API key is valid and has sufficient credits
4. User is okay with synchronous crawl (up to 150s) and research polling (variable duration)
5. No need for the curator UI / activity monitor from pi-web-access (Tavily tools are simpler — no multi-provider fallback chain)

## Open Questions

1. **Should research support streaming (SSE)?** Tavily supports SSE for research progress. Pi's tool model uses `onUpdate` for progress but doesn't natively support SSE streams. Polling every 3s is simpler and works well. **Decision: polling for now.**
2. **Should we keep pi-web-access as a fallback?** If Tavily is rate-limited or down, having Exa/Perplexity/Gemini as backup could be valuable. **Decision: no — user explicitly wants to replace it. If needed later, can be added as a separate extension.**
3. **Should the extension auto-detect when to use research vs search?** No — this is the LLM's job via tool descriptions and prompt guidelines. The extension just provides the tools.
4. **Research file attachments?** Tavily research supports attaching `.txt`, `.md`, `.json` files. **Decision: skip for now — adds complexity. Can be added later if needed.**
