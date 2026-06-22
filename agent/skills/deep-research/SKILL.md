---
name: deep-research
description: Unified research combining social/community signal (last30days) with deep web research (native tools or Tavily). Produces comprehensive reports covering what people are saying and what the facts/sources say.
---

# Deep Research

Unified research workflow that combines social listening with deep web research into a single synthesized report.

## Triggers

Activate when the user asks for:
- Comprehensive research on a topic
- "deep research" / "deep-research"
- Research that needs both social signal and factual sources
- Any request to combine community sentiment with documented facts

## Data Sources

- **Social/community signal**: `/last30days` skill (Reddit, X, YouTube, TikTok, HN, Polymarket, GitHub)
- **Deep web research**: Native harness tools (`web_search`, `search`, `extract`, `crawl`, `fetch_content`, `research`) or Tavily if installed
- **Extensibility**: Graceful degradation — use whatever is available, skip what isn't

## Pre-Flight: Query Type Detection

Before any research, classify the topic. This determines how both legs behave.

**Detect these types:**
- **Comparison** — "X vs Y", "compare X and Y" → run both legs for each entity, add head-to-head section
- **Person** — named individual (developer, CEO, creator) → enrich with company, GitHub, social handles
- **Product** — software, tool, service → add competitive landscape and positioning to web research
- **Generic** — everything else → standard workflow

**Keyword trap detection (stop before research if matched):**
- **Demographic shopping** — "gift for {age} year old {gender}" → ask for hobbies/relationship/budget before running
- **Numeric trap** — specific number that collides with unrelated content (e.g., "42" = Jackie Robinson + Hitchhiker's) → strip the number from search queries
- **Generic single noun** — "sneakers", "coffee", "headphones" → ask for specificity before running

If a trap is detected, ask ONE clarifying question. Do not run research on a doomed query.

## Workflow

Sequential, three-phase. Do not synthesize until both research legs complete.

### Phase A — Social Research

Invoke `/last30days` with the topic and capture its full output as the social signal layer.

1. Run the `/last30days` skill with the user's topic. For **comparison** queries, run once per entity. For **person** topics, resolve X handle and GitHub user first and pass `--x-handle` and `--github-user` flags.
   ```bash
   SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"  # resolve from wherever last30days SKILL.md lives
   python3 "$SKILL_DIR/scripts/last30days.py" "{TOPIC}" --emit=compact
   ```
   Or invoke the skill directly if the harness supports skill invocation. Either way, capture the complete stdout.

2. Store the output as `SOCIAL_RESULTS`. This is the community-signal layer: what people are saying, debating, recommending, and reacting to.

3. If `/last30days` fails (Python missing, engine errors, no sources configured), record `SOCIAL_RESULTS=unavailable` and proceed to Phase B. Do not block the entire workflow on one leg.

### Phase B — Web Research

Detect Tavily availability, then execute targeted web research.

**Tavily detection (check in this order):**
1. Is `tavily-python` installed? → `python3 -c "import tavily" 2>/dev/null`
2. Is `TAVILY_API_KEY` set? → `test -n "$TAVILY_API_KEY"`
3. Both true → Tavily path. Either false → native tool path.

**Tavily path (if available):**
```python
from tavily import TavilyClient
tcl = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])
result = tcl.search("{query}", max_results=5, search_depth="advanced")
```
Run 3-5 targeted queries covering different angles:
- News/recent developments
- Documentation/technical details
- Analysis/opinion pieces
- Community discussions (forums, Stack Overflow, etc.)
- Competitive landscape (if applicable)

**Native tool path (default fallback):**
Use the harness's native web tools — `web_search`, `search`, `extract`, `crawl`, `fetch_content`, `research` — to perform 3-5 targeted searches covering the same angles as above. Example:
```
web_search("{TOPIC} latest news 2026")
web_search("{TOPIC} documentation how it works")
web_search("{TOPIC} review analysis opinion")
```
Use `extract` or `fetch_content` on the most relevant results to get full-text context.

Store all web findings as `WEB_RESULTS`.

If web tools are unavailable in this context, record `WEB_RESULTS=unavailable` and proceed to Phase C.

### Phase C — Synthesis

Combine `SOCIAL_RESULTS` and `WEB_RESULTS` into a single unified report.

1. **Identify convergence and divergence.** Where do social sentiment and factual sources agree? Where do they conflict? Flag these explicitly.

2. **Weave, don't stack.** The report is one narrative, not two pasted together. Social findings and web findings should be interwoven within each section, not segregated into "social report" then "web report."

3. **Note coverage gaps.** If one leg was unavailable, state clearly what data is missing and what the report is limited to.

4. **Produce the report** following the output contract defined below. For **comparison** queries, add a `## Head-to-Head` section with a comparison table between entities. For **person** topics, lead with first-party signal (their own posts, commits, releases) before third-party coverage.

## Output Contract

Single synthesized report. One narrative, not two pasted together. Follow this structure exactly.

### Report Structure

```
# Research Report: {TOPIC}

## Executive Summary

3-5 sentences. Bottom line first. What the research found, the dominant signal, and any major conflict between social sentiment and factual sources.

## Social Signal

What people are saying in the last 30 days across Reddit, X, YouTube, TikTok, HN, Polymarket, and GitHub. Cover sentiment, trends, and notable debates. Reference specific platforms and engagement where relevant.

## Deep Research

Factual findings from web sources: documentation, news, analysis, technical details, competitive landscape. Cover the angles searched (news, docs, reviews, community forums).

## Synthesis

Where social sentiment and factual sources converge or diverge. This is the most important section — it answers "so what?" Flag contradictions explicitly (e.g., "Users on Reddit report X, but documentation confirms Y").

## Key Takeaways

3-5 bullet points. Actionable, specific, sourced. No filler.

## Source Coverage

Brief note on what was covered and what was not. If a research leg was unavailable, state it here.
```

### Voice

- Professional research tone. No tooling meta-commentary (never mention "I ran last30days" or "I searched with Tavily").
- Write for a decision-maker who needs facts fast.
- Use inline citations as links, not trailing source dumps. Example: `[source](url)` not "Sources: ...".
- No hedging language ("it seems," "possibly") unless the evidence genuinely conflicts.

### Do Not

- **Do not** produce two separate reports (social report + web report). One report, woven together.
- **Do not** dump raw evidence (full API responses, search result lists, unprocessed social posts). Synthesize.
- **Do not** narrate the tooling process. The user wants findings, not a lab notebook.
- **Do not** synthesize until both research legs complete. If one leg is unavailable, note the gap — don't pretend the missing data exists.
- **Do not** exceed reasonable length. Executive Summary is always first and always short. A reader should get the answer in the first section.

## Tavily Extensibility

Tavily is an optional enhancement. **Native harness web tools are the default path, not a fallback.** The skill works fully without Tavily — it simply gains deeper search capability when Tavily is present.

### Detection

Check Tavily availability at the start of Phase B. Run both checks; both must pass:

1. **Package installed:** `python3 -c "import tavily" 2>/dev/null` — exits 0 if `tavily-python` is installed
2. **API key configured:** `test -n "$TAVILY_API_KEY"` — exits 0 if the environment variable is set and non-empty

Both pass → Tavily path. Either fails → native tool path.

### Native Tool Path (default)

This is the standard research path. Use harness native tools (`web_search`, `search`, `extract`, `crawl`, `fetch_content`, `research`) for 3-5 targeted queries. No configuration needed. No setup friction. This path produces complete results.

### Tavily Path (enhanced)

When Tavily is available, use it for deeper web research:

```python
from tavily import TavilyClient
tcl = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])
result = tcl.search("{query}", max_results=5, search_depth="advanced")
```

Tavily provides richer context extraction and advanced search depth. Use the same 3-5 query angles as the native path.

### Graceful Degradation

The skill adapts to whatever is available:

| Tavily | Native tools | Social (`/last30days`) | Result |
|--------|-------------|----------------------|--------|
| Yes | Yes | Yes | Full report, Tavily-powered web research |
| No | Yes | Yes | Full report, native tool web research |
| — | No | Yes | Social-only report with web gap noted |
| — | — | Yes | Social-only report, no web data |
| — | Yes | No | Web-only report, social gap noted |
| — | — | No | Report notes all research unavailable |

Missing legs are noted in the Source Coverage section. The report is never empty — it always reflects what data was available.

### Adding Tavily

Users who want Tavily-powered research can add it:

```bash
pip install tavily-python
export TAVILY_API_KEY="tvly-..."
```

Get an API key at https://tavily.com. No code changes needed — the skill detects Tavily automatically on next run.
