---
name: loop-engineer
description: Build a feature or program sequentially using the loop engineering maker-checker agent loop.
allowed-tools: Bash, Read, Write
---

# Loop Engineer Skill

This skill automates feature building and verification using the sequential agent loop.

## Instructions

1. Retrieve the user's intent from the request.
2. Write the user intent text to `/home/jake/.pi/loop-intent.txt`.
3. Reset/initialize `/home/jake/.pi/loop-state.json` with state:
   ```json
   {
     "stage": "INIT",
     "active_branch": "feature/agent-loop",
     "current_feature_index": 0,
     "iteration": 1,
     "approved": false,
     "failures": [],
     "features": []
   }
   ```
4. Run the orchestrator script using `npx tsx /home/jake/.pi/loop-engineer/src/loop-engineer.ts` via Bash.
5. The orchestrator will spawn subagents interactively and prompt you for human approval in the terminal. Provide responses as needed.
6. Once the orchestrator completes, output the PR summary and check the walkthrough generated in the codebase.
