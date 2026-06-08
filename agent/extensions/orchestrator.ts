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

/** Fixed handoff chain (used by legacy /implement command) */
const HANDOFFS: Record<string, { to: string; produces: string }> = {
  orchestrator: { to: "researcher",  produces: "a research task" },
  researcher:   { to: "architect",   produces: "a research report" },
  architect:    { to: "planner",     produces: "an architecture specification" },
  planner:      { to: "tester",      produces: "an implementation plan" },
  tester:       { to: "prompter",    produces: "a master test specification" },
  prompter:     { to: "coder",       produces: "a coder prompt" },
  coder:        { to: "debugger",    produces: "implemented code" },
  debugger:     { to: "planner",     produces: "a validation report" },
  reviewer:     { to: "planner",     produces: "review findings" },
  refactorer:   { to: "documentor",  produces: "refactored code" },
};

/** State machine: what comes after each stage */
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

/** Stage → artifact path (relative to artifacts dir) */
const STAGE_ARTIFACTS: Record<string, string> = {
  research:      "research.md",
  architecture:  "architecture.md",
  planning:      "plan.md",
  testing:       "tests.md",
  prompting:     "tasks/",           // prompter creates tasks/ dir
  coding:        "",                 // coder works on tasks, doesn't produce single artifact
  debugging:     "validation.md",
  review:        "review.md",
  refactoring:   "refactor.md",
  documentation: "docs.md",
};

/** Stages where the agent runs in the DASHBOARD session (interactive) */
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

// ── Pipeline state helpers ────────────────────────

function pipelinePath(pipelineId: string): string {
  return path.join(PIPELINE_BASE, pipelineId, "pipeline.json");
}

function artifactsDir(pipelineId: string): string {
  return path.join(PIPELINE_BASE, pipelineId, "artifacts");
}

function readPipeline(pipelineId: string): Pipeline | null {
  try {
    const raw = fs.readFileSync(pipelinePath(pipelineId), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writePipeline(pipeline: Pipeline): void {
  const dir = path.dirname(pipelinePath(pipeline.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pipelinePath(pipeline.id), JSON.stringify(pipeline, null, 2));
}

/** Find the active pipeline ID from session entries */
function findPipelineId(entries: any[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "custom" && e.customType === "pipeline-state") {
      return e.data?.pipelineId ?? null;
    }
  }
  return null;
}

function findPipelineSessionId(entries: any[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "custom" && e.customType === "pipeline-state") {
      return e.data?.sessionId ?? null;
    }
  }
  return null;
}

// ── Session helpers ───────────────────────────────

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

/** Parse the last assistant text message from a session JSONL file */
function getLastAssistantMessage(sessionPath: string): string | null {
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8").trim();
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]);
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
  nextStage: string | null;  // null = pipeline complete
  isLoop: boolean;
  loopType?: "remediation" | "review";
  reason?: string;
  skipAdvanceMessage?: boolean; // don't send "Starting X..." notification
}

function decideNextStage(pipeline: Pipeline): AdvanceDecision {
  const stage = pipeline.currentStage;

  // Terminal
  if (stage === "documentation") return { nextStage: null, isLoop: false };

  // Debugger → check validation.json for failures
  if (stage === "debugging") {
    const validationPath = path.join(pipeline.artifactsDir, "validation.json");
    if (fs.existsSync(validationPath)) {
      try {
        const v = JSON.parse(fs.readFileSync(validationPath, "utf-8"));
        if (v.failed > 0) {
          // Remediation loop
          const count = (pipeline.loops.remediation ?? 0) + 1;
          if (count <= pipeline.maxLoops.remediation) {
            pipeline.loops.remediation = count;
            writePipeline(pipeline);
            return {
              nextStage: "planning",
              isLoop: true,
              loopType: "remediation",
              reason: `Debugger found ${v.failed} failures (remediation loop ${count}/${pipeline.maxLoops.remediation})`,
            };
          }
          // Max loops exceeded — fail
          pipeline.status = "failed";
          writePipeline(pipeline);
          return { nextStage: null, isLoop: false, reason: "Max remediation loops exceeded" };
        }
      } catch { /* malformed JSON, fall through to normal advance */ }
    }
  }

  // Reviewer → check review.json for verdict
  if (stage === "review") {
    const reviewPath = path.join(pipeline.artifactsDir, "review.json");
    if (fs.existsSync(reviewPath)) {
      try {
        const r = JSON.parse(fs.readFileSync(reviewPath, "utf-8"));
        if (r.verdict === "issues") {
          const count = (pipeline.loops.review ?? 0) + 1;
          if (count <= pipeline.maxLoops.review) {
            pipeline.loops.review = count;
            writePipeline(pipeline);
            return {
              nextStage: "planning",
              isLoop: true,
              loopType: "review",
              reason: `Reviewer found issues (quality loop ${count}/${pipeline.maxLoops.review})`,
            };
          }
          pipeline.status = "failed";
          writePipeline(pipeline);
          return { nextStage: null, isLoop: false, reason: "Max review loops exceeded" };
        }
        if (r.verdict === "blocked") {
          pipeline.status = "failed";
          writePipeline(pipeline);
          return { nextStage: null, isLoop: false, reason: "Reviewer blocked — critical issue" };
        }
        // approved — normal advance
      } catch { /* fall through */ }
    }
  }

  // Normal advance
  const next = NEXT_STAGE[stage];
  if (!next) return { nextStage: null, isLoop: false };
  return { nextStage, isLoop: false };
}

// ── Stage session factory ─────────────────────────

async function createStageSession(
  pi: ExtensionAPI,
  ctx: any,
  pipeline: Pipeline,
  stageName: string,
  isLoop: boolean,
  loopType?: string,
) {
  const stageMap: Record<string, string> = {
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

  const agentName = stageMap[stageName];
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

  // Update pipeline state
  pipeline.currentStage = stageName;
  pipeline.stages[stageName].status = "in_progress";
  writePipeline(pipeline);

  // Determine input artifacts for this stage
  const inputText = buildStageInput(pipeline, stageName, isLoop, loopType);

  // ARCHITECT runs in dashboard — activate agent, inject context, let user talk
  if (DASHBOARD_STAGES.has(stageName)) {
    // Activate architect in the current (dashboard) session
    ctx.sessionManager.appendCustomEntry("agent-binder", {
      active: agentName,
      prompt: agentPrompt,
    });

    ctx.sessionManager.appendCustomEntry("pipeline-state", {
      pipelineId: pipeline.id,
      sessionId: ctx.sessionManager.getSessionFile(),
    });

    if (inputText) {
      ctx.sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: inputText }],
        timestamp: Date.now(),
      });
    }

    await pi.setModel(ctx.modelRegistry.find(
      ...agentDef.model.split("/"),
    ));

    pipeline.stages[stageName].sessionFile = ctx.sessionManager.getSessionFile();
    writePipeline(pipeline);

    ctx.ui.notify(
      `${agentDef.label} — ask questions until zero remain. [PIPELINE_DONE] when ready.`,
      "info",
    );
    return;
  }

  // All other stages: create isolated child session
  const pipelineJson = JSON.stringify({
    pipelineId: pipeline.id,
    stageName,
    artifactsDir: pipeline.artifactsDir,
    isLoop,
    loopType: loopType ?? null,
  });

  const result = await ctx.newSession({
    setup: async (sm) => {
      sm.appendCustomEntry("pipeline-state", {
        pipelineId: pipeline.id,
        stageName,
      });
      sm.appendCustomEntry("agent-binder", {
        active: agentName,
        prompt: agentPrompt,
      });

      // Inject stage context: pipeline config + input artifacts
      const header = [
        `# Pipeline Stage: ${agentDef.label}`,
        `Pipeline: ${pipeline.title}`,
        `Stage: ${stageName}`,
        isLoop ? `Mode: ${loopType} loop (targeted fix)` : "",
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
    withSession: async (replacementCtx) => {
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

  // Record session for tracking
  // (SessionFile is set from inside the child session via session_start)
  pipeline.stages[stageName].sessionFile = "";  // filled by session_start handler
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
      parts.push(`## Research\n\n${readArtifact("research.md")}`);
      parts.push(`## Prompt\n\n${readArtifact("prompt.md")}`);
      break;

    case "planning":
      if (isLoop && loopType === "remediation") {
        // Remediation: validation.json + pipeline_status.json + plan.md
        parts.push("## Remediation Mode");
        parts.push("You are fixing test failures. Do NOT redesign the architecture.");
        parts.push(`## Failures\n\n${readArtifact("validation.json")}`);
        parts.push(`## Original Plan\n\n${readArtifact("plan.md")}`);
      } else if (isLoop && loopType === "review") {
        // Quality loop: review.json + plan.md
        parts.push("## Quality Fix Mode");
        parts.push("Address the reviewer's findings. Do NOT redesign the architecture.");
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
      parts.push(`## Plan\n\n${readArtifact("plan.md")}`);
      parts.push(`## Tests\n\n${readArtifact("tests.md")}`);
      break;

    case "coding": {
      // Determine which task to execute
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
      parts.push(`## Tests\n\n${readArtifact("tests.md")}`);
      parts.push(`## Test Scripts Location\n\n${path.join(artDir, "tests")}`);
      break;

    case "review":
      parts.push(`## Architecture\n\n${readArtifact("architecture.md")}`);
      parts.push(`## Tests\n\n${readArtifact("tests.md")}`);
      break;

    case "refactoring": {
      parts.push(`## Review\n\n${readArtifact("review.md")}`);
      break;
    }

    case "documentation":
      // Terminal stage — gets everything
      parts.push("## All Artifacts");
      parts.push(`- Prompt: ${readArtifact("prompt.md")}`);
      parts.push(`- Research: ${readArtifact("research.md")}`);
      parts.push(`- Architecture: ${readArtifact("architecture.md")}`);
      parts.push(`- Plan: ${readArtifact("plan.md")}`);
      parts.push(`- Tests: ${readArtifact("tests.md")}`);
      parts.push(`- Review: ${readArtifact("review.md")}`);
      parts.push(`- Refactor: ${readArtifact("refactor.md")}`);
      break;
  }

  return parts.join("\n\n");
}

// ── Extension ──────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let handoffState: any = null; // for legacy /implement /return

  // ── session_start: restore pipeline state ──
  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();

    // Check for pipeline state first
    const pipelineId = findPipelineId(entries);
    if (pipelineId) {
      const pipeline = readPipeline(pipelineId);
      if (pipeline) {
        // Record this session's file in the pipeline stage
        const sessionFile = ctx.sessionManager.getSessionFile();
        const stage = pipeline.stages[pipeline.currentStage];
        if (stage && sessionFile) {
          stage.sessionFile = sessionFile;
          writePipeline(pipeline);
        }

        // Switch to the stage agent's model
        const stageMap: Record<string, string> = {
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
        const agentName = stageMap[pipeline.currentStage];
        if (agentName) {
          const agentDef = AGENTS[agentName];
          if (agentDef) {
            const [provider, ...idParts] = agentDef.model.split("/");
            const model = ctx.modelRegistry.find(provider, idParts.join("/"));
            if (model) {
              await pi.setModel(model);
            }
          }
        }
        return;
      }
    }

    // Legacy handoff state
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
        if (model) {
          await pi.setModel(model);
        }
      }
      const specName = path.basename(handoffState.specFile);
      ctx.ui.notify(
        `${agent?.label ?? handoffState.childAgent} session — ${specName}. /return when done.`,
        "info",
      );
      ctx.ui.setStatus("handoff", `🔄 ${handoffState.childAgent}`);
    } else {
      handoffState = null;
      ctx.ui.setStatus("handoff", undefined);
    }
  });

  // ── agent_end: detect [PIPELINE_DONE] marker ──
  pi.on("agent_end", async (event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const pipelineId = findPipelineId(entries);
    if (!pipelineId) return;

    const pipeline = readPipeline(pipelineId);
    if (!pipeline || pipeline.status !== "running") return;

    const stage = pipeline.stages[pipeline.currentStage];
    if (!stage) return;

    stage.turns = (stage.turns ?? 0) + 1;

    // Check for token-limit stop — don't count as nudge, let agent continue
    if ((event as any).stopReason === "length") {
      writePipeline(pipeline);
      return; // Agent hit max_tokens, gets another turn automatically
    }

    // Check for [PIPELINE_DONE] in the last assistant message
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;

    const lastMsg = getLastAssistantMessage(sessionFile);
    if (lastMsg && lastMsg.includes(MARKER)) {
      // Agent declared completion!
      stage.status = "done";
      stage.artifact = stage.artifact ?? STAGE_ARTIFACTS[pipeline.currentStage] ?? null;

      // Special: architect completion runs in dashboard; no session to close
      if (DASHBOARD_STAGES.has(pipeline.currentStage)) {
        writePipeline(pipeline);
        ctx.ui.notify("Architect complete. Advancing pipeline...", "info");
        pi.sendUserMessage(`/pipeline-advance ${pipeline.currentStage}`, {
          deliverAs: "followUp" as any,
        });
        return;
      }

      writePipeline(pipeline);
      pi.sendUserMessage(`/pipeline-advance ${pipeline.currentStage}`, {
        deliverAs: "followUp" as any,
      });
      return;
    }

    // Agent not done — check nudge threshold
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

      // Build failure recap
      const recap = buildFailureRecap(pipeline);
      ctx.sessionManager.appendCustomEntry("pipeline-status", recap);
      ctx.ui.notify(
        `Stage ${pipeline.currentStage} failed — ${stage.turns} turns without completion marker.`,
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

      // Create pipeline ID from timestamp
      const now = new Date();
      const id = now.toISOString().replace(/[:.]/g, "-");
      const artDir = artifactsDir(id);

      // Ensure directories exist
      fs.mkdirSync(artDir, { recursive: true });

      // Save brain dump as prompt.md
      const promptPath = path.join(artDir, "prompt.md");
      fs.writeFileSync(promptPath, `# Design Prompt\n\n${prompt}\n\n---\nStarted: ${now.toISOString()}\n`);

      // Create pipeline state
      const pipeline: Pipeline = {
        id,
        title: prompt.split("\n")[0].slice(0, 80),
        status: "running",
        currentStage: "research",
        startedAt: now.toISOString(),
        stages: defaultStages(),
        loops: { remediation: 0, review: 0 },
        maxLoops: { remediation: 3, review: 2 },
        artifactsDir: artDir,
      };

      pipeline.stages.research.status = "in_progress";
      writePipeline(pipeline);

      // Mark this session as the dashboard
      ctx.sessionManager.appendCustomEntry("pipeline-state", {
        pipelineId: id,
        sessionId: ctx.sessionManager.getSessionFile(),
        role: "dashboard",
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

      // Kick off first stage: researcher
      await createStageSession(pi, ctx, pipeline, "research", false);
    },
  });

  // ── /pipeline-advance — advance to next stage ─────
  pi.registerCommand("pipeline-advance", {
    description: "Advance pipeline to next stage (internal, auto-triggered)",
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

      // Special: coding task loop
      if (stageName === "coding") {
        const coding = pipeline.stages.coding;
        const tasksTotal = coding.tasksTotal ?? 0;
        const tasksDone = (coding.tasksDone ?? 0) + 1;
        coding.tasksDone = tasksDone;

        if (tasksDone < tasksTotal) {
          // More tasks — create next coder session
          writePipeline(pipeline);
          ctx.ui.notify(
            `Task ${tasksDone}/${tasksTotal} done. Starting task ${tasksDone + 1}...`,
            "info",
          );
          await createStageSession(pi, ctx, pipeline, "coding", false);
          return;
        }
        // All tasks done — fall through to normal advance
      }

      // Decide next stage
      const decision = decideNextStage(pipeline);

      if (!decision.nextStage) {
        if (pipeline.status === "failed") {
          ctx.ui.notify(
            `Pipeline failed: ${decision.reason || "unknown"}`,
            "error",
          );
          return;
        }
        // Pipeline complete
        pipeline.status = "done";
        writePipeline(pipeline);
        ctx.ui.notify("Pipeline complete!", "info");
        return;
      }

      // Advance
      writePipeline(pipeline);
      ctx.ui.notify(
        decision.isLoop
          ? `⚠ ${decision.reason}`
          : `→ Starting ${decision.nextStage}...`,
        "info",
      );

      await createStageSession(
        pi, ctx, pipeline,
        decision.nextStage,
        decision.isLoop,
        decision.loopType,
      );
    },
  });

  // ── /pipeline-status — show pipeline state ────────
  pi.registerCommand("pipeline-status", {
    description: "Display current pipeline status",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries();
      const pipelineId = findPipelineId(entries);
      if (!pipelineId) {
        ctx.ui.notify("No active pipeline. Use /design to start one.", "info");
        return;
      }

      const pipeline = readPipeline(pipelineId);
      if (!pipeline) {
        ctx.ui.notify("Pipeline state not found", "error");
        return;
      }

      const statusIcons: Record<string, string> = {
        pending: " ",
        in_progress: "●",
        done: "✓",
        failed: "✗",
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
        const icon = statusIcons[stage.status] ?? "?";
        const extra = s === "coding" && stage.tasksTotal
          ? ` [${stage.tasksDone ?? 0}/${stage.tasksTotal} tasks]`
          : "";
        lines.push(`│ [${icon}] ${s}${extra}`);
      }

      lines.push("│");
      lines.push("│ Commands: /pipeline-status  /pipeline-pause  /pipeline-abort");
      lines.push("└──────────────────────────────────────────────────────────────");

      // Display as a user message in the session
      const dashboardId = findPipelineSessionId(entries);
      if (dashboardId) {
        try {
          const sm = SessionManager.open(dashboardId);
          sm.appendMessage({
            role: "user",
            content: [{ type: "text", text: lines.join("\n") }],
            timestamp: Date.now(),
          });
        } catch {
          // If dashboard session isn't accessible, show inline
          ctx.ui.notify(lines.join("\n"), "info");
        }
      } else {
        ctx.ui.notify(lines.join("\n"), "info");
      }
    },
  });

  // ── Failure recap builder ─────────────────────
  function buildFailureRecap(pipeline: Pipeline): any {
    const statusIcons: Record<string, string> = {
      pending: " ",
      in_progress: "●",
      done: "✓",
      failed: "✗",
    };
    const completed: string[] = [];
    const failed: string[] = [];
    const pending: string[] = [];

    const stageOrder = [
      "research", "architecture", "planning", "testing", "prompting",
      "coding", "debugging", "review", "refactoring", "documentation",
    ];

    for (const s of stageOrder) {
      const stage = pipeline.stages[s];
      const icon = statusIcons[stage.status] ?? "?";
      const line = `[${icon}] ${s}`;
      if (stage.status === "done") completed.push(line);
      else if (stage.status === "failed") failed.push(line);
      else pending.push(line);
    }

    return {
      title: pipeline.title,
      status: "failed",
      failedStage: pipeline.currentStage,
      failedTurns: pipeline.stages[pipeline.currentStage]?.turns ?? 0,
      completed,
      failed,
      pending,
      artifactsDir: pipeline.artifactsDir,
    };
  }

  // ── Legacy /implement — hand off a spec file ──
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
        ctx.ui.notify("Session must be persisted for handoff (ephemeral not supported)", "error");
        return;
      }

      const result = await ctx.newSession({
        parentSession: parentSessionFile,
        setup: async (sm) => {
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
            content: [
              {
                type: "text",
                text: [
                  `# Task: Implement \`${specName}\``,
                  "",
                  "You are the **coder** agent. Your job is to implement the specification below.",
                  "Read it carefully and implement exactly what it specifies.",
                  "",
                  "When you are done (success or failure), run `/return` to hand results back.",
                  "",
                  "---",
                  "",
                  specContent,
                ].join("\n"),
              },
            ],
            timestamp: Date.now(),
          });
        },
        withSession: async (replacementCtx) => {
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

  // ── Legacy /return — return results to parent session ──
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
        withSession: async (replacementCtx) => {
          replacementCtx.ui.notify(
            `Returned to ${handoffState!.parentAgent} session. Results below.`,
            "info",
          );
        },
      });
    },
  });

}
