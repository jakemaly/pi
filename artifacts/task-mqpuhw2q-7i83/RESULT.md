<status>success</status>
<summary>Wrote the three-phase research workflow (social + web + synthesis) into SKILL.md</summary>
<findings>
Expanded the workflow section in `.pi/agent/skills/deep-research/SKILL.md` with detailed ordered steps for all three phases:

- **Phase A (Social Research):** Instructs the agent to invoke `/last30days` with the topic, capture full stdout as `SOCIAL_RESULTS`, and degrade gracefully if the engine fails.
- **Phase B (Web Research):** Tavily detection (import check + env var check), Tavily path with 3-5 targeted queries, native tool fallback path using harness web tools (`web_search`, `search`, `extract`, `crawl`, `fetch_content`, `research`), and graceful degradation if web tools are unavailable.
- **Phase C (Synthesis):** Convergence/divergence analysis, weaving instruction (not stacking), gap reporting, and handoff to the output contract.

All acceptance criteria met:
- Step A: `/last30days {topic}` invocation with output capture ✓
- Step B: Tavily detection (package + API key) with native tool fallback ✓
- Step B: 3-5 targeted searches across different angles ✓
- Step C: synthesis process defined with weaving guidance ✓
- Sequential ordering enforced with "do not synthesize until both legs complete" ✓
</findings>
<evidence>
File: /home/jake/.pi/agent/skills/deep-research/SKILL.md
- Phase A section: `/last30days` invocation, SOCIAL_RESULTS capture, failure handling
- Phase B section: Tavily detection (3-step check), Tavily path, native tool path with 5 search angles
- Phase C section: 4-step synthesis process (convergence, weave, gaps, produce)
</evidence>
