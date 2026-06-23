# Spec: deep-research Skill

## Objective

Build a research skill that unifies social/community signal (`/last30days`) with deep web research (harness native tools) into a single synthesized research report. The skill covers both what people are saying (social, community, sentiment) and what the actual facts/sources say (articles, documentation, news, blogs).

**Why this exists:** `/last30days` is excellent for social signal but blind to deep web content. The harness has native web tools (`web_search`, `search`, `extract`, `crawl`, `fetch_content`, `research`) that cover the deep web gap. This skill bridges both into one workflow.

**User stories:**
- User asks "deep-research X" and gets a report covering social buzz + factual web research in one output
- User can invoke just social signal or just web research if needed
- User gets Tavily-powered research if Tavily is installed; otherwise native tools fill the gap
- Output is a single synthesized narrative, not two separate reports

## Tech Stack

- **Language:** Markdown skill file (SKILL.md) — no new Python code, no new dependencies
- **Social research:** `/last30days` skill at `/home/jake/last30days-skill/skills/last30days/` (existing, production)
- **Web research:** Harness native tools (`web_search`, `search`, `extract`, `crawl`, `fetch_content`, `research`)
- **Optional web research:** Tavily (if binary/package/API key present at runtime — skill detects and uses it)
- **Target location:** `/home/jake/.pi/agent/skills/deep-research/`

## Commands

No build, test, or lint commands. This is a SKILL.md instruction file. The skill is activated by the user invoking `deep-research {topic}` or matching trigger phrases.

## Project Structure

```
.pi/agent/skills/deep-research/
  SKILL.md          # Single skill file — all instructions, workflow, output contract
```

No scripts, no agents, no lib directories. The skill orchestrates existing tools through instructions.

## Code Style

N/A — this is a Markdown instruction file, not code. Follows the same frontmatter + instruction pattern as existing skills in `.pi/agent/skills/` (see `diagnose/SKILL.md`, `tdd/SKILL.md`).

## Testing Strategy

Manual verification only. The skill is instruction-driven (agent reads SKILL.md and follows steps). Verification is:

1. Skill activates on trigger phrase
2. Social research step runs `/last30days` and produces output
3. Web research step uses available tools and produces results
4. Synthesis step combines both into one report
5. Output matches the defined format

## Boundaries

- **Always do:** Run both social and web research before synthesizing. Detect Tavily availability before deciding web research strategy. Produce a single unified report.
- **Ask first:** Adding Tavily as a dependency (requires API key, pip install). Adding new research sources beyond social + web.
- **Never do:** Write Python code or shell scripts. Fork or modify `/last30days`. Require Tavily to be installed (must work with native tools alone). Skip either research leg.

## Success Criteria

- [ ] Skill file exists at `/home/jake/.pi/agent/skills/deep-research/SKILL.md`
- [ ] Skill activates on `deep-research {topic}` trigger
- [ ] Social research invokes `/last30days` with the topic
- [ ] Web research uses harness native tools (and Tavily if available)
- [ ] Output is a single synthesized report with social signal + factual research sections
- [ ] Skill degrades gracefully when Tavily is not installed (uses native tools)
- [ ] No new dependencies required

## Open Questions

- **Tavily fallback:** Should the skill prompt the user to install Tavily if not found, or silently use native tools? Decision: silently use native tools. The user can install Tavily later if they want deeper web coverage. The skill detects and adapts — no friction on first use.
- **Output format:** Should the report follow `/last30days` voice contract (LAWs 1-10) or have its own format? Decision: own format. This is a different product — unified report, not last30days output. The social section can reference `/last30days` findings without adopting its formatting laws.
- **Research depth:** How many web searches? Decision: adaptive. The skill instructs the agent to do enough web research to complement the social findings — typically 3-5 targeted searches covering different angles (news, documentation, analysis, community discussion).
