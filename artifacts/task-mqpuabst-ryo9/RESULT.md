<status>success</status>
<summary>Created SPEC.md, implementation_plan.md, and rubric.md for the deep-research skill that unifies /last30days social signal with harness native web research tools.</summary>
<findings>
## Decision: Single SKILL.md, no Python, no scripts

The skill is a pure instruction file — no Python engine, no shell scripts, no new dependencies. It orchestrates existing tools (`/last30days` for social signal, harness native tools for web research) through structured instructions the agent reads and follows. This matches the ponytail principle: the shortest path is reusing what exists, not building new plumbing.

## Decision: Native tools over Tavily

Tavily is not installed (no binary, no package, no API key). Rather than making Tavily a requirement, the skill uses harness native tools (`web_search`, `search`, `extract`, `crawl`, `fetch_content`, `research`) as the default web research layer. Tavily is an optional enhancement — detected at runtime, used if available, silently bypassed if not.

## Decision: Placement in `.pi/agent/skills/`

Lives alongside `diagnose`, `tdd`, `grill-me` — agent-native orchestration skills. Placing it in `last30days-skill/` would couple it to that project and complicate updates. `.pi/agent/skills/` is the right home for a meta-skill that coordinates other skills.

## 5 Sequential Tasks

1. **Skeleton** — frontmatter, triggers, allowed tools
2. **Workflow** — three-phase research (social → web → synthesis)
3. **Output contract** — report format, voice, citation rules, failure mode guards
4. **Tavily extensibility** — detection, fallback, setup instructions
5. **Query types** — comparison, person, product handling + pre-flight keyword trap checks

## Key Architectural Choices

- **Sequential, not parallel:** Social research runs first (informs what to research on the web), web research second, synthesis last
- **Graceful degradation:** Either leg can fail independently; the report still produces with whatever data is available
- **No new dependencies:** Zero pip installs, zero API keys required, zero new binaries
- **Extensible Tavily hook:** Detection logic is in the skill; adding Tavily later is a pip install + env var, no skill changes
</findings>
<evidence>
Files created:
- /home/jake/.pi/artifacts/task-mqpuabst-ryo9/SPEC.md (4.9KB) — Full specification with objective, tech stack, structure, boundaries, success criteria
- /home/jake/.pi/artifacts/task-mqpuabst-ryo9/implementation_plan.md (7.9KB) — 5 sequential tasks across 3 phases with checkpoints, acceptance criteria, risk mitigation
- /home/jake/.pi/artifacts/task-mqpuabst-ryo9/rubric.md (3.6KB) — 30+ verification checklist items mapped to each task plus overall quality gates
</evidence>
