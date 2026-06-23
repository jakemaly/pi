# Rubric: deep-research Skill

Verification checklist for the deep-research skill implementation. Each item maps to a specific task in the implementation plan.

## Task 1: SKILL.md Skeleton

- [ ] Directory `/home/jake/.pi/agent/skills/deep-research/` exists
- [ ] File `SKILL.md` exists in that directory
- [ ] YAML frontmatter is valid and parseable
- [ ] Frontmatter contains `name: deep-research`
- [ ] Frontmatter contains a description mentioning social + web research
- [ ] Frontmatter contains `user-invocable: true`
- [ ] Frontmatter declares allowed tools (Bash, Read, Write minimum)
- [ ] Trigger phrases are defined (`deep-research`, `deep research`)
- [ ] Frontmatter structure matches existing skills (compare with `diagnose/SKILL.md`)

## Task 2: Research Workflow Steps

- [ ] **Phase A (Social Research):** SKILL.md contains instructions to invoke `/last30days` with the topic
- [ ] **Phase A:** Instructions specify how to capture/save the social research output
- [ ] **Phase B (Web Research):** SKILL.md contains Tavily detection logic
- [ ] **Phase B:** Tavily detection checks for at least two signals (binary/package AND API key)
- [ ] **Phase B:** Native tool fallback is defined with specific tool names (`web_search`, `search`, `extract`, etc.)
- [ ] **Phase B:** Instructions specify 3-5 targeted web searches with different angles
- [ ] **Phase C (Synthesis):** Instructions define how to combine social + web findings
- [ ] **Phase C:** Synthesis produces a single unified report, not two separate sections pasted together
- [ ] **Workflow order:** Steps are sequential — social first, web second, synthesis last
- [ ] **No premature synthesis:** Rule exists preventing synthesis before both legs complete

## Task 3: Output Contract

- [ ] Report format defines clear sections (Executive Summary, Social Signal, Deep Research, Synthesis/Analysis, Key Takeaways)
- [ ] Citation rules defined (inline markdown links preferred, no trailing source dumps)
- [ ] Voice contract defined (professional research tone)
- [ ] "No tooling narration" rule exists (never describe the engine's behavior in the output)
- [ ] At least 3 explicit "do not" rules covering failure modes
- [ ] Output contract prevents raw evidence dumps
- [ ] Output contract prevents separate social and web reports

## Task 4: Tavily Extensibility

- [ ] Tavily detection section exists with specific checks (binary name, package name, env var)
- [ ] Native tool fallback is the default path (not degraded)
- [ ] Tavily setup instructions provided for users who want to add it
- [ ] Skill produces valid output when Tavily is absent
- [ ] No Tavily import/dependency in the skill file itself

## Task 5: Query Type Handling

- [ ] Query type detection is defined (at least: comparison, person, product, generic)
- [ ] Pre-flight check for keyword traps exists
- [ ] At least 3 keyword trap classes covered (demographic shopping, numeric traps, overly-literal phrases)
- [ ] Comparison queries trigger dual-topic research
- [ ] Person topics get enriched research guidance
- [ ] Pre-flight runs before any research execution

## Overall Quality

- [ ] SKILL.md is self-contained — no external scripts, no dependencies beyond existing tools
- [ ] SKILL.md is under 300 lines (ponytail: instructions not code, keep it tight)
- [ ] No placeholder text or TODOs remain
- [ ] Skill works with zero setup (no API keys required, no installs needed)
- [ ] Skill degrades gracefully on both legs (social-only or web-only reports are valid)
- [ ] No Python code, shell scripts, or new files beyond SKILL.md
