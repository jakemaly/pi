<status>success</status>
<summary>SKILL.md skeleton verified: frontmatter, triggers, and all 5 required sections present and correct.</summary>
<findings>
## Verification against rubric criteria

1. **File exists**: `/home/jake/.pi/agent/skills/deep-research/SKILL.md` — present (1769 bytes, matches builder's 1761 ± minor diff)
2. **Frontmatter**: Valid YAML frontmatter with `name: deep-research` and description covering last30days + native tools + Tavily extensibility ✓
3. **Required sections all present** (5 sections):
   - `## Triggers` — lists activation keywords and scenarios ✓
   - `## Data Sources` — documents social signal, web research, and extensibility ✓
   - `## Workflow` — 4-step ordered workflow (pre-flight → social → web → synthesis) ✓
   - `## Output` — describes synthesized report structure ✓
   - `## Tavily Extensibility` — graceful degradation strategy (Tavily → native → social-only) ✓

## Code review (five-axis)

- **Correctness**: Content matches the deep-research skill intent; references existing `/last30days` skill and native harness tools accurately.
- **Readability**: Clean structure, no boilerplate, concise sections. No dead code or redundant prose.
- **Architecture**: Follows SKILL.md convention (frontmatter + markdown sections). Consistent with other skills in the repo.
- **Security**: N/A — documentation-only artifact, no executable code.
- **Performance**: N/A — documentation-only artifact.

No issues found. No tests or linters applicable for a markdown skill definition file.
</findings>
<evidence>
File: /home/jake/.pi/agent/skills/deep-research/SKILL.md (1769 bytes)
Frontmatter: name=deep-research, description covers last30days + native tools + Tavily
Sections found: Triggers, Data Sources, Workflow, Output, Tavily Extensibility (5/5 required)
</evidence>
