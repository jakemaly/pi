<status>success</status>
<summary>Expanded Tavily extensibility section with detection logic, graceful degradation matrix, and setup instructions.</summary>
<findings>
Replaced the 3-line Tavily bullet list with a full section covering:

- **Detection**: Two specific checks (`python3 -c "import tavily"` and `test -n "$TAVILY_API_KEY"`), both must pass
- **Native tool path**: Framed as the default standard path, not a degraded fallback
- **Tavily path**: Documented as an enhancement with code example
- **Graceful degradation matrix**: 6-row table covering all combinations of Tavily/native/social availability, showing the skill always produces a report
- **Adding Tavily**: Setup instructions (`pip install tavily-python`, `export TAVILY_API_KEY`, link to tavily.com)

All acceptance criteria met:
- Detection checks are specific (package name `tavily-python`, env var `TAVILY_API_KEY`)
- Native tool fallback is the default, not degraded
- Tavily setup instructions provided
- Skill works correctly with Tavily absent (degradation table proves it)
</findings>
<evidence>
File: .pi/agent/skills/deep-research/SKILL.md
Section: "## Tavily Extensibility" (replaced 3 lines with ~40 lines)
Changes: 1 edit — replaced bare Tavily bullet list with Detection, Native Tool Path, Tavily Path, Graceful Degradation, and Adding Tavily subsections
</evidence>
