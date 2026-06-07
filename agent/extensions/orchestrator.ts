/**
 * Orchestrator — session handoff between agents.
 *
 * Manages modular context isolation: when handing off from one agent to
 * another, the child session sees ONLY the spec file, not the parent's
 * full conversation history. Results flow back to the parent session.
 *
 * ┌─────────────────────────────────────────────────────┐
 * │  Planner Session (deepseek)                         │
 * │  User: "Build a login system"                       │
 * │  Planner: creates plan.md                           │
 * │                                                     │
 * │  /implement plan.md ─────────────────────────┐      │
 * │                                               │      │
 * │  ┌── Coder Session (qwen) ───────────────┐   │      │
 * │  │  Context: plan.md ONLY                 │   │      │
 * │  │  Coder: implements...                  │   │      │
 * │  │  /return                               │   │      │
 * │  └────────────────────────────────────────┘   │      │
 * │                                               │      │
 * │  ◄── coder results injected ──────────────┘        │
 * │  Planner: reviews, continues...                     │
 * └─────────────────────────────────────────────────────┘
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Configuration ──────────────────────────────────

const AGENTS_DIR = path.join(
  process.env.HOME || "~",
  ".pi/agent/agents",
);

/** Agent definitions (matches agent-binder) */
const AGENTS: Record<string, { model: string; label: string; type: "decision" | "execution" }> = {
  // DeepSeek agents (decision-makers)
  orchestrator: { model: "deepseek/deepseek-v4-pro",          label: "Orchestrator (DeepSeek)", type: "decision" },
  architect:    { model: "deepseek/deepseek-v4-pro",          label: "Architect (DeepSeek)",    type: "decision" },
  planner:      { model: "deepseek/deepseek-v4-pro",          label: "Planner (DeepSeek)",      type: "decision" },
  reviewer:     { model: "deepseek/deepseek-v4-pro",          label: "Reviewer (DeepSeek)",     type: "decision" },
  default:      { model: "deepseek/deepseek-v4-pro",          label: "Default (DeepSeek)",      type: "decision" },

  // Qwen agents (executors)
  researcher:   { model: "llama/Qwen3.6-27B-Q4_K_M.gguf",    label: "Researcher (Qwen)",       type: "execution" },
  tester:       { model: "llama/Qwen3.6-27B-Q4_K_M.gguf",    label: "Tester (Qwen)",           type: "execution" },
  prompter:     { model: "llama/Qwen3.6-27B-Q4_K_M.gguf",    label: "Prompter (Qwen)",         type: "execution" },
  coder:        { model: "llama/Qwen3.6-27B-Q4_K_M.gguf",    label: "Coder (Qwen)",            type: "execution" },
  debugger:     { model: "llama/Qwen3.6-27B-Q4_K_M.gguf",    label: "Debugger (Qwen)",         type: "execution" },
  refactorer:   { model: "llama/Qwen3.6-27B-Q4_K_M.gguf",    label: "Refactorer (Qwen)",       type: "execution" },
  documentor:   { model: "llama/Qwen3.6-27B-Q4_K_M.gguf",    label: "Documentor (Qwen)",       type: "execution" },
};

/** Handoff graph: which agent hands off to which (and what they produce) */
const HANDOFFS: Record<string, { to: string; produces: string }> = {
  orchestrator: { to: "researcher",  produces: "a research task" },
  researcher:   { to: "architect",   produces: "a research report" },
  architect:    { to: "planner",     produces: "an architecture specification" },
  planner:      { to: "tester",      produces: "an implementation plan (.md file)" },
  tester:       { to: "prompter",    produces: "a master test specification" },
  prompter:     { to: "coder",       produces: "a coder prompt" },
  coder:        { to: "debugger",    produces: "implemented code" },
  debugger:     { to: "planner",     produces: "a validation report" },
  reviewer:     { to: "planner",     produces: "review findings" },
  refactorer:   { to: "documentor",  produces: "refactored code" },
  // documentor is terminal — no handoff target
};

// ── State ──────────────────────────────────────────

interface HandoffState {
  parentSessionFile: string;
  parentAgent: string;
  childAgent: string;
  specFile: string;
}

// ── Helpers ────────────────────────────────────────

function readAgentPrompt(name: string): string | null {
  try {
    return fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), "utf-8");
  } catch {
    return null;
  }
}

/** Find which agent is currently active from agent-binder entries. */
function detectCurrentAgent(entries: any[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "custom" && e.customType === "agent-binder") {
      return e.data?.active ?? null;
    }
  }
  return null;
}

/**
 * Collect implementation work from session entries.
 * Extracts assistant messages and tool invocations.
 */
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
      // Track edited files
      if (msg.details?.path) seenFiles.add(msg.details.path);
    }
  }

  let summary = parts.join("\n\n---\n\n");

  if (seenFiles.size > 0) {
    summary += `\n\n### Files Modified\n${[...seenFiles].map((f) => `- \`${f}\``).join("\n")}`;
  }

  return summary || "(no output produced)";
}

// ── Extension ──────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let handoffState: HandoffState | null = null;

  // ── session_start: restore state + auto-set model ──
  pi.on("session_start", async (_event, ctx) => {
    // Find last orchestrator-handoff entry
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === "orchestrator-handoff") {
        handoffState = e.data as HandoffState;
        break;
      }
    }

    if (handoffState) {
      // This is a child session — switch to the child agent's model
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

  // ── /implement — hand off a spec file to the next agent ──
  pi.registerCommand("implement", {
    description: "Hand off a spec file to the next agent in the workflow",
    handler: async (args, ctx) => {
      const specFile = args?.trim();
      if (!specFile) {
        ctx.ui.notify("Usage: /implement <spec-file.md>", "error");
        return;
      }

      // Resolve spec file
      const specPath = path.resolve(ctx.cwd, specFile);
      if (!fs.existsSync(specPath)) {
        ctx.ui.notify(`Spec file not found: ${specPath}`, "error");
        return;
      }
      const specContent = fs.readFileSync(specPath, "utf-8");
      const specName = path.basename(specPath);

      // Detect current agent from session state
      const entries = ctx.sessionManager.getEntries();
      const currentAgent = detectCurrentAgent(entries) ?? "planner";

      // Resolve handoff target
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

      // ── Create child session ──
      const result = await ctx.newSession({
        parentSession: parentSessionFile,
        setup: async (sm) => {
          // 1. Persist handoff state so the child knows its parent
          sm.appendCustomEntry("orchestrator-handoff", {
            parentSessionFile,
            parentAgent: currentAgent,
            childAgent,
            specFile: specPath,
          });

          // 2. Activate the child agent via agent-binder state
          sm.appendCustomEntry("agent-binder", {
            active: childAgent,
            prompt: childPrompt,
          });

          // 3. Inject spec as the ONLY context (no parent conversation history)
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

  // ── /return — return results to parent session ──
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

      // Collect coder's work
      const entries = ctx.sessionManager.getEntries();
      const workSummary = collectWorkSummary(entries);

      // Build the return message
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
        // Write results directly to the parent session file
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

      // Switch back to parent session.
      // After switchSession, the old ctx/pi are stale — all UI work
      // must happen inside withSession.
      await ctx.switchSession(handoffState.parentSessionFile, {
        withSession: async (replacementCtx) => {
          replacementCtx.ui.notify(
            `Returned to ${handoffState!.parentAgent} session. Coder results below.`,
            "info",
          );
        },
      });
    },
  });

}
