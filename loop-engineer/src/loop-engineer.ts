import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline";
import { discoverAgents, buildPiArgs, parseResultXml } from "../node_modules/@heyhuynhgiabuu/pi-task/dist/helpers.js";

// Types
interface LoopConfig {
  models: {
    smart: string;
    cheap: string;
  };
  max_verification_cycles: number;
  git_isolation: string;
  sequential: boolean;
}

interface LoopState {
  stage: "INIT" | "SPEC_GRILLING" | "PLANNING" | "HUMAN_APPROVAL" | "BUILDING_LOOP" | "PR_DOC" | "COMPLETE";
  active_branch: string;
  current_feature_index: number;
  iteration: number;
  approved: boolean;
  failures: string[];
  features: string[];
  failure_context?: string; // Persist failure context between runs
}

// Helpers
function readConfig(): LoopConfig {
  const configPath = "/home/jake/.pi/loop-config.json";
  if (!existsSync(configPath)) {
    throw new Error(`Config not found at ${configPath}`);
  }
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function readState(): LoopState {
  const statePath = "/home/jake/.pi/loop-state.json";
  if (!existsSync(statePath)) {
    return {
      stage: "INIT",
      active_branch: "",
      current_feature_index: 0,
      iteration: 1,
      approved: false,
      failures: [],
      features: []
    };
  }
  return JSON.parse(readFileSync(statePath, "utf-8"));
}

function writeState(state: LoopState) {
  const statePath = "/home/jake/.pi/loop-state.json";
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

function registerTask(piDir: string, id: string, agentType: string, description: string, artifactDir: string, sessionName: string) {
  const registryPath = join(piDir, "task-registry.json");
  let entries: any[] = [];
  try {
    if (existsSync(registryPath)) {
      entries = JSON.parse(readFileSync(registryPath, "utf-8"));
    }
  } catch {
    entries = [];
  }
  const entry = {
    id,
    agentType,
    description,
    sessionName,
    startedAt: Date.now(),
    paneId: null,
    piDir,
    dir: artifactDir,
    conversationId: null
  };
  entries.push(entry);
  writeFileSync(registryPath, JSON.stringify(entries, null, 2), "utf-8");
}

async function askApproval(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const clean = answer.trim().toLowerCase();
      resolve(clean === "y" || clean === "yes");
    });
  });
}

function runSubagent(agentName: string, promptContent: string, model: string): { success: boolean; summary: string; findings: string; evidence: string } {
  const { agents, piDir } = discoverAgents(process.cwd());
  const agent = agents.find((a: any) => a.name === agentName);
  if (!agent) {
    throw new Error(`Subagent definition for "${agentName}" not found.`);
  }

  // Override model and system instructions if configured
  agent.model = model;

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
  const sessionName = `task-${id}`;
  const artifactDir = join(piDir, "artifacts", sessionName);
  mkdirSync(artifactDir, { recursive: true });
  const resultPath = join(artifactDir, "RESULT.md");

  // Create registry entry to sync with task tracker
  registerTask(piDir, id, agentName, `Loop Step: ${agentName}`, artifactDir, sessionName);

  // Setup CONTEXT.md for subagent execution
  const contextPath = join(artifactDir, "CONTEXT.md");
  const contextContent = [
    `# Task: Loop Step ${agentName}`,
    "",
    `## Instructions`,
    promptContent,
    "",
    `## Working Directory`,
    process.cwd(),
    "",
    `## Output`,
    `Write your final findings XML block to ${resultPath}`,
    "",
    "Format requirements:",
    "<status>success|failure|blocked</status>",
    "<summary>One sentence description of what was done</summary>",
    "<findings>Findings/details</findings>",
    "<evidence>Verification outputs</evidence>"
  ].join("\n");
  writeFileSync(contextPath, contextContent, "utf-8");

  const promptArgs = [
    `Read ${contextPath} for your task.`,
    `Write your findings/output XML to ${resultPath}`
  ].join("\n");

  const sessionDir = join(artifactDir, "sessions");
  mkdirSync(sessionDir, { recursive: true });

  const piArgs = buildPiArgs(agent, sessionName, sessionDir, promptArgs, false);

  console.log(`\n================================================================================`);
  console.log(`Spawning subagent: ${agentName} (${model})`);
  console.log(`================================================================================\n`);

  // Run the pi process in the foreground so it inherits stdout/stdin
  const res = spawnSync("pi", piArgs, { stdio: "inherit", cwd: process.cwd() });

  // Handle process failures & abort signal (SIGINT)
  if (res.error || res.status !== 0 || res.signal) {
    const errMsg = res.error ? String(res.error) : `Subprocess exited with code ${res.status}${res.signal ? ` (signal ${res.signal})` : ""}`;
    console.error("Subprocess execution error:", errMsg);
    if (res.signal === "SIGINT" || res.status === 130) {
      console.log("Subprocess aborted by user (SIGINT). Exiting coordinator loop.");
      process.exit(130);
    }
    return { success: false, summary: "Execution failed", findings: errMsg, evidence: "" };
  }

  // Fallback: Check if subagent wrote RESULT.md to workspace root instead of absolute path
  const localResultPath = join(process.cwd(), "RESULT.md");
  if (!existsSync(resultPath) && existsSync(localResultPath)) {
    console.log(`Subagent wrote RESULT.md to workspace root. Moving it to task artifacts folder.`);
    try {
      const content = readFileSync(localResultPath, "utf-8");
      writeFileSync(resultPath, content, "utf-8");
      unlinkSync(localResultPath);
    } catch (e) {
      console.error("Failed to move/clean local RESULT.md:", e);
    }
  }

  if (existsSync(resultPath)) {
    const rawResult = readFileSync(resultPath, "utf-8");
    const parsed = parseResultXml(rawResult);
    return {
      success: parsed.status === "success",
      summary: parsed.summary,
      findings: parsed.findings,
      evidence: parsed.evidence
    };
  } else {
    return {
      success: false,
      summary: "No RESULT.md output generated",
      findings: "Subagent completed without producing RESULT.md",
      evidence: ""
    };
  }
}

// Main Flow
async function main() {
  const config = readConfig();
  const state = readState();

  console.log(`Starting/Resuming Agent Loop. Current Stage: ${state.stage}`);

  // Git isolation: branch checkout/creation
  if (config.git_isolation === "branch" && state.active_branch) {
    console.log(`Ensuring active git branch matches state.active_branch: "${state.active_branch}"`);
    const gitBranchRes = spawnSync("git", ["branch", "--show-current"], { encoding: "utf-8" });
    const currentBranch = gitBranchRes.stdout?.trim();
    if (currentBranch !== state.active_branch) {
      console.log(`Current branch is "${currentBranch}". Checking out "${state.active_branch}"...`);
      const gitCheckRes = spawnSync("git", ["show-ref", "--verify", `refs/heads/${state.active_branch}`]);
      if (gitCheckRes.status !== 0) {
        const gitCreateRes = spawnSync("git", ["checkout", "-b", state.active_branch], { stdio: "inherit" });
        if (gitCreateRes.status !== 0) {
          console.error(`Failed to create branch "${state.active_branch}"`);
          process.exit(1);
        }
      } else {
        const gitCheckoutRes = spawnSync("git", ["checkout", state.active_branch], { stdio: "inherit" });
        if (gitCheckoutRes.status !== 0) {
          console.error(`Failed to checkout branch "${state.active_branch}"`);
          process.exit(1);
        }
      }
    }
  }

  if (state.stage === "INIT") {
    // Step 1: User Intent
    console.log("Ingesting User Intent and spawning Planner Agent...");
    const intent = readFileSync("/home/jake/.pi/loop-intent.txt", "utf-8").trim();
    
    // Spawning planner using smart model
    const planPrompt = `Draft the SPEC.md, implementation_plan.md, and rubric.md files based on this user intent:\n"${intent}"\nMake sure the plan is strictly sequential, building one feature at a time, verifying it, and then moving to the next.`;
    const plannerRes = runSubagent("loop-planner", planPrompt, config.models.smart);

    if (!plannerRes.success) {
      console.error("Planner Agent failed to generate initial spec/plan.");
      process.exit(1);
    }

    state.stage = "SPEC_GRILLING";
    writeState(state);
  }

  if (state.stage === "SPEC_GRILLING") {
    console.log("Fleshing out spec using grill-me...");
    const grillPrompt = "Review SPEC.md and implementation_plan.md. Relentlessly interview me on choices and resolve dependencies. Ask questions one at a time.";
    const grillRes = runSubagent("grill-me", grillPrompt, config.models.smart);

    if (!grillRes.success) {
      console.error("Grilling session failed or was interrupted. Halting loop.");
      process.exit(1);
    }

    state.stage = "PLANNING";
    writeState(state);
  }

  if (state.stage === "PLANNING") {
    console.log("Finalizing plans and extracting sequential features...");
    let features: string[] = [];
    if (existsSync("rubric.md")) {
      const rubricText = readFileSync("rubric.md", "utf-8");
      const lines = rubricText.split("\n");
      for (const line of lines) {
        const match = line.match(/^-\s*\[\s*[xX]?\s*\]\s*(.+)$/);
        if (match && match[1]) {
          features.push(match[1].trim());
        }
      }
    }

    if (features.length === 0) {
      if (existsSync("implementation_plan.md")) {
        const planText = readFileSync("implementation_plan.md", "utf-8");
        const lines = planText.split("\n");
        for (const line of lines) {
          const match = line.match(/^#+\s*\[(MODIFY|NEW|DELETE)\]\s*(.+)$/i);
          if (match && match[2]) {
            features.push(`Implement changes for ${match[2].trim()}`);
          }
        }
      }
    }

    if (features.length === 0) {
      features = ["Build main features of the specification"];
    }

    state.features = features;
    state.stage = "HUMAN_APPROVAL";
    writeState(state);
  }

  if (state.stage === "HUMAN_APPROVAL") {
    console.log("\nReview SPEC.md, implementation_plan.md, and rubric.md in the workspace.");
    const approved = await askApproval("Do you approve the spec, implementation plan, and rubric? (y/n): ");
    if (!approved) {
      console.log("Approval denied. Returning to Spec Grilling stage.");
      state.stage = "SPEC_GRILLING";
      writeState(state);
      process.exit(0);
    }

    console.log("Spec approved. Proceeding to BUILDING_LOOP.");
    state.stage = "BUILDING_LOOP";
    state.current_feature_index = 0;
    state.iteration = 1;
    state.failure_context = "";
    writeState(state);
  }

  if (state.stage === "BUILDING_LOOP") {
    const totalFeatures = state.features.length;
    console.log(`Starting sequential building loop. Total features: ${totalFeatures}`);

    while (state.current_feature_index < totalFeatures) {
      const idx = state.current_feature_index;
      const feature = state.features[idx];
      console.log(`\n--------------------------------------------------------------------------------`);
      console.log(`[Feature ${idx + 1}/${totalFeatures}] Building: ${feature}`);
      console.log(`--------------------------------------------------------------------------------\n`);

      // Restore loop state for current feature if resumed
      let verificationCycles = state.iteration - 1;
      let verified = false;
      let failureContext = state.failure_context || "";

      while (verificationCycles < config.max_verification_cycles && !verified) {
        verificationCycles++;
        state.iteration = verificationCycles;
        writeState(state);
        console.log(`Verification Cycle ${verificationCycles}/${config.max_verification_cycles}`);

        // 1. Build Step (Cheap Model)
        const builderPrompt = [
          `You are implementing: "${feature}"`,
          `Refer to SPEC.md and implementation_plan.md for context.`,
          failureContext ? `\nPrevious verification/build failed with context:\n${failureContext}\nPlease fix the issues and rebuild.` : ""
        ].join("\n");

        const buildRes = runSubagent("loop-builder", builderPrompt, config.models.cheap);

        // Short-circuit if builder failed
        if (!buildRes.success) {
          console.log(`Builder failed for feature: ${feature}`);
          failureContext = `Builder findings: ${buildRes.findings}\nBuilder evidence: ${buildRes.evidence}`;
          state.failure_context = failureContext;
          writeState(state);
          continue; // Go to next verification cycle directly
        }

        // 2. Verify Step (Smart Model)
        const verifierPrompt = [
          `Verify the implementation for feature: "${feature}"`,
          `Check rubric.md and run tests/linters.`,
          `Findings from builder: ${buildRes.summary}`,
          `Evidence from builder: ${buildRes.evidence}`
        ].join("\n");

        const verifyRes = runSubagent("loop-verifier", verifierPrompt, config.models.smart);

        if (verifyRes.success) {
          console.log(`Feature [${feature}] successfully verified!`);
          verified = true;
          state.failure_context = "";
          state.iteration = 1;
          writeState(state);
        } else {
          console.log(`Verification failed for feature: ${feature}`);
          failureContext = `Verifier findings: ${verifyRes.findings}\nVerifier evidence: ${verifyRes.evidence}`;
          state.failure_context = failureContext;
          writeState(state);
        }
      }

      if (!verified) {
        console.error(`\nMax verification cycles reached for feature: ${feature}. Halting loop.`);
        console.error(failureContext);
        process.exit(1);
      }

      // Commit feature changes sequentially if git isolation is active
      if (config.git_isolation === "branch") {
        console.log(`Committing verified feature changes to git...`);
        spawnSync("git", ["add", "."], { stdio: "inherit" });
        const commitMsg = `loop-engineer: verified feature ${idx + 1}/${totalFeatures} - ${feature}`;
        const gitCommitRes = spawnSync("git", ["commit", "-m", commitMsg], { stdio: "inherit" });
        if (gitCommitRes.status !== 0) {
          console.warn("Git commit returned non-zero status. Changes might be empty or already committed.");
        }
      }

      // Move to the next feature sequentially
      state.current_feature_index++;
      state.iteration = 1;
      state.failure_context = "";
      writeState(state);
    }

    state.stage = "PR_DOC";
    writeState(state);
  }

  if (state.stage === "PR_DOC") {
    console.log("Sequential implementation completed. Spawning Documentor Agent for documentation and PR description...");
    const docPrompt = "Create a pull request description summarizing all implementation details and run test walkthroughs. Write the walkthrough.md report.";
    const docRes = runSubagent("loop-documentor", docPrompt, config.models.smart);

    if (docRes.success) {
      console.log("PR and walkthrough documentation generated successfully.");
      state.stage = "COMPLETE";
      writeState(state);
    } else {
      console.error("Documentation generation failed.");
    }
  }

  if (state.stage === "COMPLETE") {
    console.log("\n================================================================================");
    console.log("AGENT LOOP COMPLETE! All features built, verified sequentially, and documented.");
    console.log("================================================================================\n");
  }
}

main().catch((err) => {
  console.error("Fatal loop execution error:", err);
  process.exit(1);
});
