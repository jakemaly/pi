# Implementation Plan: deep-research Skill

## Overview

Create a single SKILL.md file at `/home/jake/.pi/agent/skills/deep-research/SKILL.md` that orchestrates `/last30days` (social signal) and harness native web tools (deep web research) into a unified research workflow. No Python code, no new dependencies, no scripts — pure instruction file.

## Architecture Decisions

- **Single file, no scripts.** The skill is instructions the agent reads and follows. No Python engine to maintain, no shell scripts to debug.
- **Tavily detection, not requirement.** Skill checks for Tavily at runtime. If present, uses it. If not, uses harness native tools. Zero friction on first use.
- **Sequential research, unified synthesis.** Social research runs first (produces community signal), web research runs second (produces factual coverage), then both are synthesized into one report.
- **Placement in `.pi/agent/skills/`.** Lives alongside `diagnose`, `tdd`, `grill-me` — agent-native skills that orchestrate behavior through instructions.

## Task List

### Phase 1: Foundation

#### Task 1: Create SKILL.md skeleton with frontmatter and trigger definition

**Description:** Create the skill directory and write the SKILL.md frontmatter, skill name, description, trigger phrases, and allowed-tools declaration. This establishes the skill as a discoverable, invocable entity.

**Acceptance criteria:**
- [ ] Directory `/home/jake/.pi/agent/skills/deep-research/` exists
- [ ] SKILL.md has valid YAML frontmatter with name `deep-research`, description, and `user-invocable: true`
- [ ] Frontmatter declares allowed tools: Bash, Read, Write (needed for `/last30days` invocation)
- [ ] Trigger phrases defined: `deep-research`, `deep research`, `research {topic}`

**Verification:**
- [ ] File exists and is valid Markdown with YAML frontmatter
- [ ] Frontmatter matches pattern of existing skills (compare with `diagnose/SKILL.md`)

**Dependencies:** None

**Files touched:**
- `.pi/agent/skills/deep-research/SKILL.md` (new)

**Estimated scope:** XS (1 file)

---

### Checkpoint: Foundation
- [ ] SKILL.md skeleton exists with valid frontmatter
- [ ] Skill is discoverable and invocable

---

### Phase 2: Core Workflow

#### Task 2: Write the research workflow steps (social + web + synthesis)

**Description:** Define the three-phase workflow inside SKILL.md:
1. **Phase A — Social Research:** Invoke `/last30days` with the topic via Bash. Capture the output as the social signal layer.
2. **Phase B — Web Research:** Detect Tavily availability. If Tavily is installed and configured, use it. Otherwise, use harness native tools (`web_search`, `search`, `extract`, `crawl`, `fetch_content`, `research`) to do targeted web research on the topic.
3. **Phase C — Synthesis:** Combine social findings and web findings into a single unified report following the output contract.

**Acceptance criteria:**
- [ ] Step A instructs the agent to run `/last30days {topic}` and capture output
- [ ] Step B includes Tavily detection logic (check for binary/package/API key) with native tool fallback
- [ ] Step B specifies 3-5 targeted web searches covering different angles
- [ ] Step C defines the synthesis process — weaving social + web into one narrative
- [ ] Workflow is sequential: social first, web second, synthesis last

**Verification:**
- [ ] SKILL.md contains clear, ordered steps for all three phases
- [ ] Tavily detection has a clear fallback path
- [ ] Synthesis step references both data sources

**Dependencies:** Task 1

**Files touched:**
- `.pi/agent/skills/deep-research/SKILL.md` (edit)

**Estimated scope:** S (1 file)

---

#### Task 3: Define the output contract and report format

**Description:** Define exactly what the final report looks like. The output contract prevents the agent from producing two separate reports or leaking raw research data. Specifies section structure, voice, citation format, and what not to include.

**Acceptance criteria:**
- [ ] Report format defined with clear sections: Executive Summary, Social Signal, Deep Research, Synthesis, Key Takeaways
- [ ] Citation rules defined (inline links, no trailing source dumps)
- [ ] Voice contract defined (professional research tone, no tooling meta-commentary)
- [ ] Explicit "do not" rules prevent common failure modes (raw evidence dumps, separate reports, tool narration)

**Verification:**
- [ ] Output contract section exists in SKILL.md
- [ ] Format is specific enough that two different agents produce similar structure
- [ ] "Do not" rules cover at least 3 failure modes

**Dependencies:** Task 2

**Files touched:**
- `.pi/agent/skills/deep-research/SKILL.md` (edit)

**Estimated scope:** S (1 file)

---

### Checkpoint: Core Workflow
- [ ] All three workflow phases defined
- [ ] Output contract prevents common failure modes
- [ ] Report format is specific and actionable

---

### Phase 3: Edge Cases and Polish

#### Task 4: Add Tavily extensibility section and graceful degradation

**Description:** Document how Tavily integration works when available and how the skill degrades when it is not. Include setup instructions for users who want to add Tavily later. This is the extensibility hook — the skill works today without Tavily but is ready for it.

**Acceptance criteria:**
- [ ] Tavily detection logic is clear (what to check, what it means)
- [ ] Native tool fallback is the default, not a degraded path
- [ ] Tavily setup instructions provided for users who want to add it
- [ ] Skill works correctly with Tavily absent (no errors, no missing sections)

**Verification:**
- [ ] Tavily section exists in SKILL.md
- [ ] Detection checks are specific (binary name, package name, env var name)
- [ ] Fallback uses named harness tools

**Dependencies:** Task 2

**Files touched:**
- `.pi/agent/skills/deep-research/SKILL.md` (edit)

**Estimated scope:** XS (1 file)

---

#### Task 5: Add query type handling and pre-flight checks

**Description:** Handle different query types the way `/last30days` does — comparison queries, person topics, product topics, generic topics. Add pre-flight checks to detect keyword traps and reframe queries before research. This prevents junk research on poorly-formed queries.

**Acceptance criteria:**
- [ ] Query type detection defined (comparison, person, product, generic)
- [ ] Pre-flight check for keyword traps (demographic shopping, numeric traps, overly-literal phrases)
- [ ] Comparison queries trigger dual-topic research on both social and web legs
- [ ] Person topics get enriched research (company, GitHub, social handles)

**Verification:**
- [ ] Query type section exists in SKILL.md
- [ ] At least 3 query types handled with different behavior
- [ ] Pre-flight checks prevent known failure modes

**Dependencies:** Task 3

**Files touched:**
- `.pi/agent/skills/deep-research/SKILL.md` (edit)

**Estimated scope:** S (1 file)

---

### Checkpoint: Complete
- [ ] Full SKILL.md written and self-contained
- [ ] All workflow phases, output contract, and edge cases defined
- [ ] Skill works with or without Tavily
- [ ] No new dependencies required

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `/last30days` invocation fails (Python not available, engine errors) | Social leg missing, report is web-only | Skill degrades gracefully — web research still runs, report notes social data unavailable |
| Harness web tools unavailable in some contexts | Web leg missing | Skill notes web data unavailable, still produces report from social data |
| Agent skips one research leg | Incomplete report | Explicit "do not synthesize until both legs complete" rule in workflow |
| Output becomes too long | User experience degrades | Output contract defines section length guidance; Executive Summary is always first |

## Open Questions

None — all resolved in SPEC.md.
