/**
 * Orchestrator — multi-agent pipeline engine.
 *
 * Deterministic state machine. 10 stages, 2 loop-back points, 1 task loop.
 * Agent self-declares completion via [PIPELINE_DONE] marker.
 * Context isolation firewall between decision-makers and executors.
 *
 * State machine:
 *   IDLE → RESEARCHER → ARCHITECT → PLANNER → TESTER → PROMPTER → CODER
 *   → DEBUGGER → [fail?→PLANNER] | [pass→REVIEWER]
 *   → [issues?→PLANNER] | [approved→REFACTORER] → DOCUMENTOR → DONE
 *
 * Architect runs in dashboard session (user-in-the-loop).
 * All other stages run in isolated child sessions.
 *
 * Advancement model:
 *   agent_end (event handler): marks stage done, sends /pipeline-advance in current session
 *   /pipeline-advance (command handler, has session-control methods): determines next stage,
 *     creates child session OR switches to dashboard for interactive stages
 *
 * Critical API constraints:
 *   - ctx.switchSession() and ctx.newSession() are ONLY on ExtensionCommandContext (commands),
 *     NOT on ExtensionContext (event handlers). So agent_end cannot switch sessions.
 *   - In switchSession's withSession callback, use replacementCtx.sendUserMessage(),
 *     NOT pi.sendUserMessage() (pi is stale after replacement).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Constants ─────────────────────────────────────

const HOME = process.env.HOME || "~";
const PIPELINE_BASE = path.join(HOME, ".pi/pipeline");
const AGENTS_DIR = path.join(HOME, ".pi/agent/agents");
const MARKER = "[PIPELINE_DONE]";
const MAX_TURNS_PER_STAGE = 15;
const MAX_NUDGES = 3;

/** Agent definitions */
const AGENTS: Record<string, { model: string; label: string; type: "decision" | "execution" }> = {
  orchestrator: { model: "deepseek/deepseek-v4-pro",          label: "Orchestrator (DeepSeek)", type: "decision" },
  architect:    { model: "deepseek/deepseek-v4-pro",          label: "Architect (DeepSeek)",    type: "decision" },
  planner:      { model: "deepseek/deepseek-v4-pro",          label: "Planner (DeepSeek)",      type: "decision" },
  reviewer:     { model: "deepseek/deepseek-v4-pro",          label: "Reviewer (DeepSeek)",     type: "decision" },
  default:      { model: "deepseek/deepseek-v4-pro",          label: "Default (DeepSeek)",      type: "decision" },
  researcher:   { model: "llama/Qwen3.6-27B-Q4_K_M.gguf",    label: "Researcher (Qwen)",       type: "execution" },
  tester:       { model: "llama/Qwen3.6-27B-Q4_K_M.gguf",    label: "Tester (Qwen)",           type: "execution" },
  prompter:     { model: "llama/Qwen3.6-27B-Q4_K_M.gguf",    label: "Prompter (Qwen)",         type: "execution" },
  coder:        { model: "llama/Qwen3.6-27B-Q4_K_M.gguf",    label: "Coder (Qwen)",            type: "execution" },
  debugger:     { model: "llama/Qwen3.6-27B-Q4_K_M.gguf",    label: "Debugger (Qwen)",         type: "execution" },
  refactorer:   { model: "llama/Qwen3.6-27B-Q4_K_M.gguf",    label: "Refactorer (Qwen)",       type: "execution" },
  documentor:   { model: "llama/Qwen3.6-27B-Q4_K_M.gguf",    label: "Documentor (Qwen)",       type: "execution" },
};

const STAGE_TO_AGENT: Record<string, string> = {
  architecture:  "architect",
  planning:      "planner",
  research:      "researcher",
  testing:       "tester",
  prompting:     "prompter",
  coding:        "coder",
  debugging:     "debugger",
  review:        "reviewer",
  refactoring:   "refactorer",
  documentation: "documentor",
};

const HANDOFFS: Record<string, { to: string; produces: string }> = {
  orchestrator: { to: "researcher",  produces: "a research task" },
  researcher:   { to: "architect",   produces: "a research report" },
  architect:    { to: "planner",     produces: "an implementation plan" },
  planner:      { to: "tester",      produces: "an implementation plan" },
  tester:       { to: "prompter",    produces: "a master test specification" },
  prompter:     { to: "coder",       produces: "a coder prompt" },
  coder:        { to: "debugger",    produces: "implemented code" },
  debugger:     { to: "planner",     produces: "a validation report" },
  reviewer:     { to: "planner",     produces: "review findings" },
  refactorer:   { to: "documentor",  produces: "refactored code" },
};

const NEXT_STAGE: Record<string, string> = {
  research:      "architecture",
  architecture:  "planning",
  planning:      "testing",
  testing:       "prompting",
  prompting:     "coding",
  coding:        "debugging",
  debugging:     "review",
  review:        "refactoring",
  refactoring:   "documentation",
};

const STAGE_ARTIFACTS: Record<string, string> = {
  research:      "research.md",
  architecture:  "architecture.md",
  planning:      "plan.md",
  testing:       "tests.md",
  prompting:     "tasks/",
  coding:        "",
  debugging:     "validation.md",
  review:        "review.md",
  refactoring:   "refactor.md",
  documentation: "docs.md",
};

/** Stages that run in the dashboard (interactive, user-in-the-loop) */
const DASHBOARD_STAGES = new Set(["architecture"]);

// ── Pipeline State ────────────────────────────────

interface PipelineStage {
  status: "pending" | "in_progress" | "done" | "failed";
  artifact: string | null;
  turns: number;
  nudges: number;
  tasksDone?: number;
  tasksTotal?: number;
  sessionFile?: string;
}

interface Pipeline {
  id: string;
  title: string;
  status: "running" | "done" | "failed";
  currentStage: string;
  dashboardSessionFile: string;
  startedAt: string;
  stages: Record<string, PipelineStage>;
  loops: { remediation: number; review: number };
  maxLoops: { remediation: number; review: number };
  artifactsDir: string;
}

function defaultStages(): Record<string, PipelineStage> {
  return {
    research:       { status: "pending", artifact: null, turns: 0, nudges: 0 },
    architecture:   { status: "pending", artifact: null, turns: 0, nudges: 0 },
    planning:       { status: "pending", artifact: null, turns: 0, nudges: 0 },
    testing:        { status: "pending", artifact: null, turns: 0, nudges: 0 },
    prompting:      { status: "pending", artifact: null, turns: 0, nudges: 0 },
    coding:         { status: "pending", artifact: null, turns: 0, nudges: 0, tasksDone: 0, tasksTotal: 0 },
    debugging:      { status: "pending", artifact: null, turns: 0, nudges: 0 },
    review:         { status: "pending", artifact: null, turns: 0, nudges: 0 },
    refactoring:    { status: "pending", artifact: null, turns: 0, nudges: 0 },
    documentation:  { status: "pending", artifact: null, turns: 0, nudges: 0 },
  };
}

// ── Helpers ───────────────────────────────────────

function pipelinePath(pipelineId: string): string {
  return path.join(PIPELINE_BASE, pipelineId, "pipeline.json");
}

function readPipeline(pipelineId: string): Pipeline | null {
  try {
    return JSON.parse(fs.readFileSync(pipelinePath(pipelineId), "utf-8"));
  } catch {
    return null;
  }
}

function writePipeline(pipeline: Pipeline): void {
  const dir = path.dirname(pipelinePath(pipeline.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pipelinePath(pipeline.id), JSON.stringify(pipeline, null, 2));
}

function findPipelineId(entries: any[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "custom" && e.customType === "pipeline-state") {
      return e.data?.pipelineId ?? null;
    }
  }
  return null;
}

function readAgentPrompt(name: string): string | null {
  try {
    return fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), "utf-8");
  } catch {
    return null;
  }
}

function detectCurrentAgent(entries: any[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "custom" && e.customType === "agent-binder") {
      return e.data?.active ?? null;
    }
  }
  return null;
}

function getLastAssistantMessage(sessionPath: string): string | null {
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8").trim();
    if (!raw) return null;
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let entry: any;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (!msg || msg.role !== "assistant") continue;
      if (Array.isArray(msg.content)) {
        const texts = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text);
        return texts.join("\n");
      }
      if (typeof msg.content === "string") return msg.content;
    }
  } catch { /* ignore parse errors */ }
  return null;
}

function collectWorkSummary(entries: any[]): string {
  const parts: string[] = [];
  const seenFiles = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;
    if (msg.role === "assistant") {
      const text = (msg.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n")
        .trim();
      if (text) parts.push(text);
    }
    if (msg.role === "toolResult" && msg.toolName === "edit") {
      if (msg.details?.path) seenFiles.add(msg.details.path);
    }
  }
  let summary = parts.join("\n\n---\n\n");
  if (seenFiles.size > 0) {
    summary += `\n\n### Files Modified\n${[...seenFiles].map((f) => `- \`${f}\``).join("\n")}`;
  }
  return summary || "(no output produced)";
}

// ── Pipeline advance logic ────────────────────────

interface AdvanceDecision {
  nextStage: string | null;
  isLoop: boolean;
  loopType?: "remediation" | "review";
  reason?: string;
}

function decideNextStage(pipeline: Pipeline): AdvanceDecision {
  const stage = pipeline.currentStage;

  if (stage === "documentation") return { nextStage: null, isLoop: false };

  if (stage === "debugging") {
    const validationPath = path.join(pipeline.artifactsDir, "validation.json");
    if (fs.existsSync(validationPath)) {
      try {
        const v = JSON.parse(fs.readFileSync(validationPath, "utf-8"));
        if (v.failed > 0) {
          const count = pipeline.loops.remediation + 1;
          if (count <= pipeline.maxLoops.remediation) {
            return {
              nextStage: "planning",
              isLoop: true,
              loopType: "remediation",
              reason: `Debugger found ${v.failed} failures (remediation loop ${count}/${pipeline.maxLoops.remediation})`,
            };
          }
          return { nextStage: null, isLoop: false, reason: "Max remediation loops exceeded" };
        }
      } catch { /* malformed JSON */ }
    }
  }

  if (stage === "review") {
    const reviewPath = path.join(pipeline.artifactsDir, "review.json");
    if (fs.existsSync(reviewPath)) {
      try {
        const r = JSON.parse(fs.readFileSync(reviewPath, "utf-8"));
        if (r.verdict === "issues") {
          const count = pipeline.loops.review + 1;
          if (count <= pipeline.maxLoops.review) {
            return {
              nextStage: "planning",
              isLoop: true,
              loopType: "review",
              reason: `Reviewer found issues (quality loop ${count}/${pipeline.maxLoops.review})`,
            };
          }
          return { nextStage: null, isLoop: false, reason: "Max review loops exceeded" };
        }
        if (r.verdict === "blocked") {
          return { nextStage: null, isLoop: false, reason: "Reviewer blocked — critical issue" };
        }
      } catch { /* fall through */ }
    }
  }

  const next = NEXT_STAGE[stage];
  if (!next) return { nextStage: null, isLoop: false };
  return { nextStage, isLoop: false };
}

function countTaskFiles(artifactsDir: string): number {
  const tasksDir = path.join(artifactsDir, "tasks");
  if (!fs.existsSync(tasksDir)) return 0;
  return fs.readdirSync(tasksDir).filter((f) => /^task-\d+\.md$/.test(f)).length;
}

/** Count tasks in plan.md via `### Task N:` headings */
function parseTaskCount(planPath: string): number {
  try {
    const content = fs.readFileSync(planPath, "utf-8");
    const matches = content.match(/^### Task \d+:/gm);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

function writePipelineStatus(pipeline: Pipeline, mode: string, problem: string): void {
  const completed: string[] = [];
  const stageOrder = [
    "research", "architecture", "planning", "testing", "prompting",
    "coding", "debugging", "review", "refactoring", "documentation",
  ];
  for (const s of stageOrder) {
    if (pipeline.stages[s].status === "done") completed.push(s);
  }

  const status = {
    role: "planner",
    mode,
    loop: mode === "remediation" ? pipeline.loops.remediation : pipeline.loops.review,
    maxLoops: mode === "remediation" ? pipeline.maxLoops.remediation : pipeline.maxLoops.review,
    completedStages: completed,
    currentProblem: problem,
    instructions: mode === "remediation"
      ? "You are fixing test failures. Create targeted remediation tasks for ONLY the failing tests. Do NOT redesign architecture. Do NOT modify tests that pass. Do NOT expand scope."
      : "You are fixing quality issues identified by the reviewer. Address ONLY the specific findings. Do NOT redesign architecture. Do NOT expand scope.",
  };

  const statusPath = path.join(pipeline.artifactsDir, "pipeline_status.json");
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
}

// ── Stage session factory (CHILD stages only) ─────

async function createChildStageSession(
  pi: ExtensionAPI,
  ctx: any,
  pipeline: Pipeline,
  stageName: string,
  isLoop: boolean,
  loopType?: string,
) {
  const agentName = STAGE_TO_AGENT[stageName];
  if (!agentName) {
    ctx.ui.notify(`Unknown stage: ${stageName}`, "error");
    return;
  }

  const agentDef = AGENTS[agentName];
  const agentPrompt = readAgentPrompt(agentName);
  if (!agentDef || !agentPrompt) {
    ctx.ui.notify(`Agent "${agentName}" not configured`, "error");
    return;
  }

  pipeline.currentStage = stageName;
  pipeline.stages[stageName].status = "in_progress";
  writePipeline(pipeline);

  if (isLoop && (loopType === "remediation" || loopType === "review")) {
    writePipelineStatus(
      pipeline, loopType,
      pipeline.loops[loopType] > 0
        ? `${loopType} loop ${pipeline.loops[loopType]}/${pipeline.maxLoops[loopType]}`
        : "initial",
    );
  }

  const inputText = buildStageInput(pipeline, stageName, isLoop, loopType);
  const pipelineJson = JSON.stringify({
    pipelineId: pipeline.id,
    stageName,
    artifactsDir: pipeline.artifactsDir,
    isLoop,
    loopType: loopType ?? null,
  });

  const result = await ctx.newSession({
    setup: async (sm: any) => {
      sm.appendCustomEntry("pipeline-state", {
        pipelineId: pipeline.id,
        stageName,
        dashboardSessionFile: pipeline.dashboardSessionFile,
      });
      sm.appendCustomEntry("agent-binder", {
        active: agentName,
        prompt: agentPrompt,
      });

      const header = [
        `# Pipeline Stage: ${agentDef.label}`,
        `Pipeline: ${pipeline.title}`,
        `Stage: ${stageName}`,
        isLoop ? `Mode: ${loopType} loop (targeted fix)` : "",
        "",
        `## Output Directory: \`${pipeline.artifactsDir}\``,
        `All artifacts go here. This is an absolute filesystem path.`,
        "",
        "## Pipeline Config",
        "```json",
        pipelineJson,
        "```",
        "",
        "## Instructions",
        "You are in an isolated session. Your job is to complete this stage.",
        "When your work is perfected, include `[PIPELINE_DONE]` as the last",
        "line of your response. The pipeline will NOT advance without this marker.",
        "",
      ].join("\n");

      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: header + inputText }],
        timestamp: Date.now(),
      });
    },
    withSession: async (replacementCtx: any) => {
      replacementCtx.ui.notify(
        `${agentDef.label} working... (stage: ${stageName})`,
        "info",
      );
    },
  });

  if (result.cancelled) {
    ctx.ui.notify(`Stage ${stageName} cancelled`, "info");
    return;
  }

  pipeline.stages[stageName].sessionFile = "";
  writePipeline(pipeline);
}

/** Build the input context for a given stage */
function buildStageInput(
  pipeline: Pipeline,
  stageName: string,
  isLoop: boolean,
  loopType?: string,
): string {
  const artDir = pipeline.artifactsDir;
  const parts: string[] = [];

  const readArtifact = (name: string): string => {
    const p = path.join(artDir, name);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
    return `(file not found: ${name})`;
  };

  switch (stageName) {
    case "research":
      parts.push(`## Prompt\n\n${readArtifact("prompt.md")}`);
      break;

    case "architecture":
      parts.push(`## Output Directory: \`${artDir}\``);
      parts.push(`## Research\n\n${readArtifact("research.md")}`);
      parts.push(`## Prompt\n\n${readArtifact("prompt.md")}`);
      break;

    case "planning":
      if (isLoop && loopType === "remediation") {
        parts.push("## Remediation Mode");
        parts.push("You are fixing test failures. Do NOT redesign the architecture.");
        parts.push(`## Pipeline Status\n\n${readArtifact("pipeline_status.json")}`);
        parts.push(`## Failures\n\n${readArtifact("validation.json")}`);
        parts.push(`## Original Plan\n\n${readArtifact("plan.md")}`);
      } else if (isLoop && loopType === "review") {
        parts.push("## Quality Fix Mode");
        parts.push("Address the reviewer's findings. Do NOT redesign the architecture.");
        parts.push(`## Pipeline Status\n\n${readArtifact("pipeline_status.json")}`);
        parts.push(`## Review Findings\n\n${readArtifact("review.json")}`);
        parts.push(`## Original Plan\n\n${readArtifact("plan.md")}`);
      } else {
        parts.push(`## Architecture\n\n${readArtifact("architecture.md")}`);
        parts.push(`## Research\n\n${readArtifact("research.md")}`);
      }
      break;

    case "testing":
      parts.push(`## Plan\n\n${readArtifact("plan.md")}`);
      break;

    case "prompting":
      parts.push(`## Plan (${pipeline.stages.coding.tasksTotal ?? "?"} tasks)\n\n${readArtifact("plan.md")}`);
      parts.push(`\n## Tests\n\n${readArtifact("tests.md")}`);
      parts.push(`\n\nYou must produce exactly ${pipeline.stages.coding.tasksTotal ?? "N"} task files.`);
      parts.push(`Count the \`### Task N:\` headings in the plan to verify.`);
      break;

    case "coding": {
      const tasksTotal = pipeline.stages.coding.tasksTotal ?? 0;
      const tasksDone = pipeline.stages.coding.tasksDone ?? 0;
      const taskNum = tasksDone + 1;
      const taskPath = path.join(artDir, "tasks", `task-${String(taskNum).padStart(3, "0")}.md`);
      parts.push(`## Task ${taskNum} of ${tasksTotal}`);
      if (fs.existsSync(taskPath)) {
        parts.push(fs.readFileSync(taskPath, "utf-8"));
      } else {
        parts.push("(task file not found — implement from plan)");
        parts.push(`## Plan\n\n${readArtifact("plan.md")}`);
      }
      break;
    }

    case "debugging":
      parts.push(`## Test Scripts\n\nRun test scripts from: ${path.join(artDir, "tests")}`);
      parts.push(`\nTest specification:\n\n${readArtifact("tests.md")}`);
      break;

    case "review":
      parts.push(`## Architecture\n\n${readArtifact("architecture.md")}`);
      parts.push(`## Tests\n\n${readArtifact("tests.md")}`);
      break;

    case "refactoring":
      parts.push(`## Review\n\n${readArtifact("review.md")}`);
      break;

    case "documentation":
      // List file paths instead of dumping all content (would overflow context)
      const files = ["prompt.md", "research.md", "architecture.md", "plan.md", "tests.md", "review.md", "refactor.md"];
      parts.push("## Artifacts to Document");
      parts.push("The following files are available at the artifacts directory:");
      parts.push(files.map((f) => {
        const exists = fs.existsSync(path.join(artDir, f));
        return `- \`${f}\`${exists ? "" : " (not found)"}`;
      }).join("\n"));
      parts.push(`\nUse the \`read\` tool to load each file: \`${artDir}/\``);
      break;
  }

  return parts.join("\n\n");
}

// ── Extension ──────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let handoffState: any = null;

  // ── session_start ──
  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const pipelineId = findPipelineId(entries);

    if (pipelineId) {
      const pipeline = readPipeline(pipelineId);
      if (pipeline) {
        const sessionFile = ctx.sessionManager.getSessionFile();
        const stage = pipeline.stages[pipeline.currentStage];
        if (stage && sessionFile) {
          stage.sessionFile = sessionFile;
          writePipeline(pipeline);
        }

        const agentName = STAGE_TO_AGENT[pipeline.currentStage];
        if (agentName) {
          const agentDef = AGENTS[agentName];
          if (agentDef) {
            const [provider, ...idParts] = agentDef.model.split("/");
            const model = ctx.modelRegistry.find(provider, idParts.join("/"));
            if (model) await pi.setModel(model);
          }
        }
        return;
      }
    }

    // Legacy handoff
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === "orchestrator-handoff") {
        handoffState = e.data;
        break;
      }
    }
    if (handoffState) {
      const agent = AGENTS[handoffState.childAgent];
      if (agent) {
        const [provider, ...idParts] = agent.model.split("/");
        const model = ctx.modelRegistry.find(provider, idParts.join("/"));
        if (model) await pi.setModel(model);
      }
      ctx.ui.setStatus("handoff", `🔄 ${handoffState.childAgent}`);
    } else {
      handoffState = null;
      ctx.ui.setStatus("handoff", undefined);
    }
  });

  // ── agent_end — detect [PIPELINE_DONE] marker ──
  // This is an EVENT handler. It CANNOT call ctx.switchSession() or ctx.newSession()
  // (those are ExtensionCommandContext methods only).
  pi.on("agent_end", async (event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const pipelineId = findPipelineId(entries);
    if (!pipelineId) return;

    const pipeline = readPipeline(pipelineId);
    if (!pipeline || pipeline.status !== "running") return;

    const stage = pipeline.stages[pipeline.currentStage];
    if (!stage) return;

    stage.turns = (stage.turns ?? 0) + 1;

    // Token-limit stop — let agent continue
    if ((event as any).stopReason === "length") {
      writePipeline(pipeline);
      return;
    }

    // Check for [PIPELINE_DONE]
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;

    const lastMsg = getLastAssistantMessage(sessionFile);
    if (lastMsg && lastMsg.includes(MARKER)) {
      stage.status = "done";
      stage.artifact = stage.artifact ?? STAGE_ARTIFACTS[pipeline.currentStage] ?? null;

      if (pipeline.currentStage === "prompting") {
        pipeline.stages.coding.tasksTotal = countTaskFiles(pipeline.artifactsDir);

        // Validate: prompter must produce exactly as many task files as the plan has tasks
        const planTaskCount = parseTaskCount(path.join(pipeline.artifactsDir, "plan.md"));
        if (planTaskCount > 0 && pipeline.stages.coding.tasksTotal !== planTaskCount) {
          ctx.ui.notify(
            `⚠ Prompter produced ${pipeline.stages.coding.tasksTotal} task files but plan has ${planTaskCount} tasks. Using plan count.`,
            "warning",
          );
          pipeline.stages.coding.tasksTotal = planTaskCount;
        }
      }

      // After planner: set task count from plan so prompter knows the target
      if (pipeline.currentStage === "planning") {
        const planPath = path.join(pipeline.artifactsDir, "plan.md");
        pipeline.stages.coding.tasksTotal = parseTaskCount(planPath);
      }

      writePipeline(pipeline);
      ctx.ui.notify("Advancing pipeline...", "info");

      // Send /pipeline-advance in the current session.
      // /pipeline-advance is a COMMAND handler, so it has access to
      // switchSession/newSession for dashboard routing.
      pi.sendUserMessage(`/pipeline-advance ${pipeline.currentStage}`, {
        deliverAs: "followUp" as any,
      });
      return;
    }

    // ── Nudge / failure logic ──
    // Dashboard stages (architect) are interactive — no max turn limit
    if (DASHBOARD_STAGES.has(pipeline.currentStage)) {
      writePipeline(pipeline);
      return;
    }

    // Nudge if taking too long
    if (stage.turns >= MAX_TURNS_PER_STAGE && stage.nudges < MAX_NUDGES) {
      stage.nudges = (stage.nudges ?? 0) + 1;
      writePipeline(pipeline);
      pi.sendUserMessage(
        `You've taken ${stage.turns} turns. If your work is complete, include \`[PIPELINE_DONE]\` in your response. Otherwise continue working.`,
        { deliverAs: "followUp" as any },
      );
      return;
    }

    // Max nudges exceeded — stage failed
    if (stage.nudges >= MAX_NUDGES) {
      stage.status = "failed";
      pipeline.status = "failed";
      writePipeline(pipeline);
      ctx.ui.notify(
        `Stage ${pipeline.currentStage} failed — ${stage.turns} turns without completion.`,
        "error",
      );
      return;
    }

    writePipeline(pipeline);
  });

  // ── /design — start a new pipeline ───────────────
  pi.registerCommand("design", {
    description: "Start a new pipeline: /design <brain-dump>",
    handler: async (args, ctx) => {
      const prompt = args?.trim();
      if (!prompt) {
        ctx.ui.notify("Usage: /design <description of what to build>", "error");
        return;
      }

      const now = new Date();
      const id = now.toISOString().replace(/[:.]/g, "-");
      const artDir = path.join(PIPELINE_BASE, id, "artifacts");
      const dashboardSessionFile = ctx.sessionManager.getSessionFile();

      if (!dashboardSessionFile) {
        ctx.ui.notify("Session must be persisted. Start pi without --ephemeral.", "error");
        return;
      }

      fs.mkdirSync(artDir, { recursive: true });

      fs.writeFileSync(
        path.join(artDir, "prompt.md"),
        `# Design Prompt\n\n${prompt}\n\n---\nStarted: ${now.toISOString()}\n`,
      );

      const pipeline: Pipeline = {
        id,
        title: prompt.split("\n")[0].slice(0, 80),
        status: "running",
        currentStage: "research",
        dashboardSessionFile,
        startedAt: now.toISOString(),
        stages: defaultStages(),
        loops: { remediation: 0, review: 0 },
        maxLoops: { remediation: 3, review: 2 },
        artifactsDir: artDir,
      };

      pipeline.stages.research.status = "in_progress";
      writePipeline(pipeline);

      ctx.sessionManager.appendCustomEntry("pipeline-state", {
        pipelineId: id,
      });

      ctx.ui.notify(
        [
          `Pipeline started: ${pipeline.title}`,
          `ID: ${id}`,
          `Artifacts: ${artDir}`,
          `Starting researcher...`,
        ].join("\n"),
        "info",
      );

      await createChildStageSession(pi, ctx, pipeline, "research", false);
    },
  });

  // ── /pipeline-advance — advance to next stage ─────
  // This is a COMMAND handler. It HAS access to ctx.switchSession/ctx.newSession.
  pi.registerCommand("pipeline-advance", {
    description: "Advance pipeline to next stage (internal)",
    handler: async (args, ctx) => {
      const stageName = args?.trim();
      const entries = ctx.sessionManager.getEntries();
      const pipelineId = findPipelineId(entries);
      if (!pipelineId) {
        ctx.ui.notify("No active pipeline in this session", "error");
        return;
      }

      const pipeline = readPipeline(pipelineId);
      if (!pipeline) {
        ctx.ui.notify("Pipeline state not found", "error");
        return;
      }

      // Mark the completed stage as done
      if (stageName && pipeline.stages[stageName]) {
        pipeline.stages[stageName].status = "done";
      }

      // Coder task loop
      if (stageName === "coding") {
        const coding = pipeline.stages.coding;
        const tasksTotal = coding.tasksTotal ?? 0;
        const tasksDone = (coding.tasksDone ?? 0) + 1;
        coding.tasksDone = tasksDone;

        if (tasksTotal > 0 && tasksDone < tasksTotal) {
          writePipeline(pipeline);
          ctx.ui.notify(
            `Task ${tasksDone}/${tasksTotal} done. Starting task ${tasksDone + 1}...`,
            "info",
          );
          await createChildStageSession(pi, ctx, pipeline, "coding", false);
          return;
        }
      }

      const decision = decideNextStage(pipeline);

      if (!decision.nextStage) {
        if (decision.reason && decision.reason.includes("Max")) {
          pipeline.status = "failed";
          writePipeline(pipeline);
          ctx.ui.notify(`Pipeline failed: ${decision.reason}`, "error");
          return;
        }
        if (decision.reason && decision.reason.includes("blocked")) {
          pipeline.status = "failed";
          writePipeline(pipeline);
          ctx.ui.notify(`Pipeline blocked: ${decision.reason}`, "error");
          return;
        }
        pipeline.status = "done";
        writePipeline(pipeline);
        ctx.ui.notify("Pipeline complete!", "info");
        return;
      }

      // Apply loop counters
      if (decision.isLoop) {
        if (decision.loopType === "remediation") {
          pipeline.loops.remediation = (pipeline.loops.remediation ?? 0) + 1;
        } else if (decision.loopType === "review") {
          pipeline.loops.review = (pipeline.loops.review ?? 0) + 1;
        }
      }

      // ── Dashboard-bound stages (architect) ──
      // Switch to dashboard session and activate the agent there.
      // We use ctx (ExtensionCommandContext) which HAS switchSession.
      // Inside withSession, we MUST use replacementCtx.sendUserMessage(),
      // NOT pi.sendUserMessage() (pi would be stale after replacement).
      if (DASHBOARD_STAGES.has(decision.nextStage)) {
        pipeline.currentStage = decision.nextStage;
        pipeline.stages[decision.nextStage].status = "in_progress";
        writePipeline(pipeline);

        const agentName = STAGE_TO_AGENT[decision.nextStage];
        const agentDef = AGENTS[agentName];
        const inputText = buildStageInput(
          pipeline, decision.nextStage, decision.isLoop, decision.loopType,
        );

        const dashboardFile = pipeline.dashboardSessionFile;
        await ctx.switchSession(dashboardFile, {
          withSession: async (replacementCtx: any) => {
            // Persist pipeline state in dashboard so agent_end can find it
            replacementCtx.sessionManager.appendCustomEntry("pipeline-state", {
              pipelineId: pipeline.id,
            });

            // Activate agent via slash command (updates agent-binder state)
            await replacementCtx.sendUserMessage(`/${agentName}`, {
              deliverAs: "followUp",
            });

            // Inject context as follow-up
            if (inputText) {
              await replacementCtx.sendUserMessage(inputText, {
                deliverAs: "followUp",
              });
            }
          },
        });

        ctx.ui.notify(
          `${agentDef.label} — ask questions until zero remain. [PIPELINE_DONE] when ready.`,
          "info",
        );
        return;
      }

      // ── All other stages: create child session ──
      writePipeline(pipeline);
      ctx.ui.notify(
        decision.isLoop
          ? `⚠ ${decision.reason}`
          : `→ Starting ${decision.nextStage}...`,
        "info",
      );

      await createChildStageSession(
        pi, ctx, pipeline,
        decision.nextStage,
        decision.isLoop,
        decision.loopType,
      );
    },
  });

  // ── /pipeline-status ──
  pi.registerCommand("pipeline-status", {
    description: "Display current pipeline status",
    handler: async (_args, ctx) => {
      const pipelineId = findPipelineId(ctx.sessionManager.getEntries());
      if (!pipelineId) {
        ctx.ui.notify("No active pipeline. Use /design to start one.", "info");
        return;
      }

      const pipeline = readPipeline(pipelineId);
      if (!pipeline) {
        ctx.ui.notify("Pipeline state not found", "error");
        return;
      }

      const icons: Record<string, string> = {
        pending: " ", in_progress: "●", done: "✓", failed: "✗",
      };

      const lines: string[] = [
        `┌─ Pipeline: ${pipeline.title} ─${"─".repeat(Math.max(0, 60 - pipeline.title.length))}`,
        `│ Status: ${pipeline.status.toUpperCase()}`,
        `│ Started: ${pipeline.startedAt}`,
        `│ Artifacts: ${pipeline.artifactsDir}`,
        `│ Loops: remediation ${pipeline.loops.remediation}/${pipeline.maxLoops.remediation} | review ${pipeline.loops.review}/${pipeline.maxLoops.review}`,
        `│`,
      ];

      const stageOrder = [
        "research", "architecture", "planning", "testing", "prompting",
        "coding", "debugging", "review", "refactoring", "documentation",
      ];

      for (const s of stageOrder) {
        const stage = pipeline.stages[s];
        const icon = icons[stage.status] ?? "?";
        const extra = s === "coding" && stage.tasksTotal
          ? ` [${stage.tasksDone ?? 0}/${stage.tasksTotal} tasks]`
          : "";
        lines.push(`│ [${icon}] ${s}${extra}`);
      }

      lines.push("│");
      lines.push("│ /pipeline-status");
      lines.push("└──────────────────────────────────────────────────────────────");

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── Legacy /implement ──
  pi.registerCommand("implement", {
    description: "Hand off a spec file to the next agent in the workflow",
    handler: async (args, ctx) => {
      const specFile = args?.trim();
      if (!specFile) {
        ctx.ui.notify("Usage: /implement <spec-file.md>", "error");
        return;
      }

      const specPath = path.resolve(ctx.cwd, specFile);
      if (!fs.existsSync(specPath)) {
        ctx.ui.notify(`Spec file not found: ${specPath}`, "error");
        return;
      }
      const specContent = fs.readFileSync(specPath, "utf-8");
      const specName = path.basename(specPath);

      const entries = ctx.sessionManager.getEntries();
      const currentAgent = detectCurrentAgent(entries) ?? "planner";

      const handoff = HANDOFFS[currentAgent];
      if (!handoff) {
        ctx.ui.notify(
          `No handoff defined for "${currentAgent}". Available: ${Object.keys(HANDOFFS).join(", ")}`,
          "error",
        );
        return;
      }

      const childAgent = handoff.to;
      const childPrompt = readAgentPrompt(childAgent);
      const childDef = AGENTS[childAgent];
      if (!childPrompt || !childDef) {
        ctx.ui.notify(`Agent "${childAgent}" not configured`, "error");
        return;
      }

      const parentSessionFile = ctx.sessionManager.getSessionFile();
      if (!parentSessionFile) {
        ctx.ui.notify("Session must be persisted (ephemeral not supported)", "error");
        return;
      }

      const result = await ctx.newSession({
        parentSession: parentSessionFile,
        setup: async (sm: any) => {
          sm.appendCustomEntry("orchestrator-handoff", {
            parentSessionFile,
            parentAgent: currentAgent,
            childAgent,
            specFile: specPath,
          });
          sm.appendCustomEntry("agent-binder", {
            active: childAgent,
            prompt: childPrompt,
          });
          sm.appendMessage({
            role: "user",
            content: [{
              type: "text",
              text: [
                `# Task: Implement \`${specName}\``,
                "",
                "You are the **coder** agent. Your job is to implement the specification below.",
                "Read it carefully and implement exactly what it specifies.",
                "",
                "When you are done, run `/return` to hand results back.",
                "",
                "---",
                "",
                specContent,
              ].join("\n"),
            }],
            timestamp: Date.now(),
          });
        },
        withSession: async (replacementCtx: any) => {
          replacementCtx.ui.notify(
            `${childDef.label} | ${specName} — /return when done.`,
            "info",
          );
        },
      });

      if (result.cancelled) {
        ctx.ui.notify("Handoff cancelled", "info");
      }
    },
  });

  // ── Legacy /return ──
  pi.registerCommand("return", {
    description: "Return implementation results to the parent session",
    handler: async (args, ctx) => {
      if (!handoffState) {
        ctx.ui.notify(
          "Not in a handoff session. /return is for child sessions created by /implement.",
          "error",
        );
        return;
      }

      const note = args?.trim() || null;
      const entries = ctx.sessionManager.getEntries();
      const workSummary = collectWorkSummary(entries);

      const specName = path.basename(handoffState.specFile);
      const statusLine = note
        ? `## Coder returned: ${note}`
        : "## Coder finished implementation";

      const returnContent = [
        statusLine,
        "",
        `**Spec:** \`${specName}\``,
        "",
        "### Implementation Output",
        "",
        workSummary,
      ].join("\n");

      try {
        const parentSm = SessionManager.open(handoffState.parentSessionFile);
        parentSm.appendMessage({
          role: "user",
          content: [{ type: "text", text: returnContent }],
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.ui.notify(`Failed to write to parent session: ${err.message}`, "error");
        return;
      }

      await ctx.switchSession(handoffState.parentSessionFile, {
        withSession: async (replacementCtx: any) => {
          replacementCtx.ui.notify(
            `Returned to ${handoffState!.parentAgent} session. Results below.`,
            "info",
          );
        },
      });
    },
  });
}
