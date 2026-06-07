/**
 * Agent Binder — binds planner/coder agents to their assigned models.
 *
 * planner      → deepseek/deepseek-v4-pro          (decisions only, never writes code)
 * orchestrator → deepseek/deepseek-v4-pro          (coordinates, never does work)
 * architect    → deepseek/deepseek-v4-pro          (converts ambiguity to decisions)
 * reviewer     → deepseek/deepseek-v4-pro          (quality gate)
 * default      → deepseek/deepseek-v4-pro          (hands-on engineering)
 *
 * coder        → llama/Qwen3.6-27B-Q4_K_M.gguf    (execution only, never decides)
 * researcher   → llama/Qwen3.6-27B-Q4_K_M.gguf    (gathers information)
 * tester       → llama/Qwen3.6-27B-Q4_K_M.gguf    (defines success criteria)
 * prompter     → llama/Qwen3.6-27B-Q4_K_M.gguf    (translates tasks to coder prompts)
 * debugger     → llama/Qwen3.6-27B-Q4_K_M.gguf    (finds defects, doesn't fix)
 * refactorer   → llama/Qwen3.6-27B-Q4_K_M.gguf    (improves structure, not behavior)
 * documentor   → llama/Qwen3.6-27B-Q4_K_M.gguf    (produces documentation)
 *
 * These bindings are absolute. No agent runs on the wrong model.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const AGENTS_DIR = path.join(
  process.env.HOME || "~",
  ".pi/agent/agents",
);

const LOCKS_DIR = path.join(
  process.env.HOME || "~",
  ".pi/agent/locks",
);

const BINDINGS: Record<string, { model: string; label: string }> = {
  // DeepSeek agents (decision-makers)
  orchestrator: {
    model: "deepseek/deepseek-v4-pro",
    label: "Orchestrator (DeepSeek)",
  },
  architect: {
    model: "deepseek/deepseek-v4-pro",
    label: "Architect (DeepSeek)",
  },
  planner: {
    model: "deepseek/deepseek-v4-pro",
    label: "Planner (DeepSeek)",
  },
  reviewer: {
    model: "deepseek/deepseek-v4-pro",
    label: "Reviewer (DeepSeek)",
  },
  default: {
    model: "deepseek/deepseek-v4-pro",
    label: "Default (DeepSeek)",
  },

  // Qwen agents (executors)
  researcher: {
    model: "llama/Qwen3.6-27B-Q4_K_M.gguf",
    label: "Researcher (Qwen)",
  },
  tester: {
    model: "llama/Qwen3.6-27B-Q4_K_M.gguf",
    label: "Tester (Qwen)",
  },
  prompter: {
    model: "llama/Qwen3.6-27B-Q4_K_M.gguf",
    label: "Prompter (Qwen)",
  },
  coder: {
    model: "llama/Qwen3.6-27B-Q4_K_M.gguf",
    label: "Coder (Qwen)",
  },
  debugger: {
    model: "llama/Qwen3.6-27B-Q4_K_M.gguf",
    label: "Debugger (Qwen)",
  },
  refactorer: {
    model: "llama/Qwen3.6-27B-Q4_K_M.gguf",
    label: "Refactorer (Qwen)",
  },
  documentor: {
    model: "llama/Qwen3.6-27B-Q4_K_M.gguf",
    label: "Documentor (Qwen)",
  },
};

// ── Concurrency guard ───────────────────────────
// Max 1 DeepSeek + 1 Qwen active at any time across all processes.
// Uses PID-based lock files; stale locks (dead PIDs) are auto-cleared.

interface ModelLock {
  pid: number;
  timestamp: number;
  sessionFile: string | undefined;
}

function modelFamily(model: string): string {
  if (model.startsWith("deepseek")) return "deepseek";
  return "qwen";
}

function lockPath(family: string): string {
  return path.join(LOCKS_DIR, `${family}.lock`);
}

function readLock(family: string): ModelLock | null {
  try {
    const raw = fs.readFileSync(lockPath(family), "utf-8");
    return JSON.parse(raw) as ModelLock;
  } catch {
    return null;
  }
}

function writeLock(family: string, lock: ModelLock): void {
  fs.mkdirSync(LOCKS_DIR, { recursive: true });
  fs.writeFileSync(lockPath(family), JSON.stringify(lock));
}

function deleteLock(family: string, expectedPid: number): void {
  const existing = readLock(family);
  if (existing && existing.pid === expectedPid) {
    try { fs.unlinkSync(lockPath(family)); } catch { /* best effort */ }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(
  family: string,
  sessionFile: string | undefined,
): { ok: true } | { ok: false; heldBy: ModelLock } {
  const existing = readLock(family);
  if (existing) {
    if (existing.pid === process.pid) return { ok: true };
    if (isPidAlive(existing.pid)) return { ok: false, heldBy: existing };
    try { fs.unlinkSync(lockPath(family)); } catch { /* stale — proceed */ }
  }
  writeLock(family, { pid: process.pid, timestamp: Date.now(), sessionFile });
  return { ok: true };
}

function releaseLock(family: string): void {
  deleteLock(family, process.pid);
}

function releaseAllLocks(): void {
  releaseLock("deepseek");
  releaseLock("qwen");
}

// ── Agent prompt loading ────────────────────────

function readAgentPrompt(name: string): string | null {
  const filePath = path.join(AGENTS_DIR, `${name}.md`);
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function currentModelId(ctx: { model?: { provider?: string; id?: string } }): string {
  const p = ctx.model?.provider ?? "";
  const i = ctx.model?.id ?? "";
  return p && i ? `${p}/${i}` : "";
}

interface AgentState {
  active: string | null;   // "planner" | "coder" | null
  prompt: string | null;   // raw system prompt content
}

export default function (pi: ExtensionAPI) {
  let state: AgentState = { active: null, prompt: null };
  let acquiredFamily: string | null = null;

  // ──────────────────────────────────────────────
  // Restore persisted state + acquire model lock
  // ──────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Find the LAST agent-binder entry (most recent activation)
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === "agent-binder") {
        state = entry.data as AgentState;
        break;
      }
    }

    // Acquire model-family lock if an agent is active
    if (state.active && state.prompt) {
      const binding = BINDINGS[state.active];
      if (binding) {
        const family = modelFamily(binding.model);
        const result = acquireLock(family, ctx.sessionManager.getSessionFile() ?? undefined);
        if (!result.ok) {
          const age = Math.round((Date.now() - result.heldBy.timestamp) / 1000);
          ctx.ui.notify(
            `🚫 ${family.toUpperCase()} already in use (PID ${result.heldBy.pid}, ${age}s ago). Only 1 ${family} agent at a time.`,
            "error",
          );
          state = { active: null, prompt: null };
        } else {
          acquiredFamily = family;
        }
      }
    }

    updateWidget(ctx);
  });

  // ──────────────────────────────────────────────
  // Release model lock on shutdown
  // ──────────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    releaseAllLocks();
    acquiredFamily = null;
  });

  // ──────────────────────────────────────────────
  // Activate an agent
  // ──────────────────────────────────────────────
  async function activateAgent(name: string, ctx: any) {
    const binding = BINDINGS[name];
    if (!binding) {
      ctx.ui.notify(`Unknown agent: ${name}`, "error");
      return;
    }

    const prompt = readAgentPrompt(name);
    if (!prompt) {
      ctx.ui.notify(`Agent prompt not found: ${name}.md`, "error");
      return;
    }

    const prev = state.active;

    // Release old family lock if switching families.
    // Acquire the NEW lock BEFORE releasing the old one — if the new
    // acquire fails, we still hold the old lock and can bail safely.
    const family = modelFamily(binding.model);
    const oldFamily = prev
      ? modelFamily(BINDINGS[prev]?.model ?? "")
      : null;

    if (oldFamily && oldFamily !== family) {
      const lockResult = acquireLock(family, undefined);
      if (!lockResult.ok) {
        const age = Math.round((Date.now() - lockResult.heldBy.timestamp) / 1000);
        ctx.ui.notify(
          `🚫 ${family.toUpperCase()} already in use (PID ${lockResult.heldBy.pid}, ${age}s ago). Cannot activate ${name}.`,
          "error",
        );
        return;
      }
      releaseLock(oldFamily);
    } else if (!oldFamily) {
      // First activation — just acquire
      const lockResult = acquireLock(family, undefined);
      if (!lockResult.ok) {
        const age = Math.round((Date.now() - lockResult.heldBy.timestamp) / 1000);
        ctx.ui.notify(
          `🚫 ${family.toUpperCase()} already in use (PID ${lockResult.heldBy.pid}, ${age}s ago). Cannot activate ${name}.`,
          "error",
        );
        return;
      }
    }
    // else: same family — lock already held by us, no-op
    acquiredFamily = family;

    state = { active: name, prompt };

    if (prev !== name) {
      pi.appendEntry("agent-binder", state);
    }

    // Switch model using pi.setModel — the proper API
    const [provider, ...idParts] = binding.model.split("/");
    const modelId = idParts.join("/");
    const model = ctx.modelRegistry.find(provider, modelId);
    if (model) {
      const ok = await pi.setModel(model);
      if (!ok) {
        ctx.ui.notify(
          `⚠ Could not switch to ${binding.model} (no API key?)`,
          "warning",
        );
      }
    } else {
      ctx.ui.notify(
        `⚠ Model ${binding.model} not found in registry`,
        "error",
      );
    }

    ctx.ui.notify(
      `Activated ${binding.label} | model: ${binding.model}`,
      "info",
    );
    updateWidget(ctx);
  }

  // ──────────────────────────────────────────────
  // Commands
  // ──────────────────────────────────────────────

  // DeepSeek agents
  pi.registerCommand("orchestrator", {
    description: "Activate Orchestrator agent (DeepSeek — coordinates workflow)",
    handler: async (_args, ctx) => { await activateAgent("orchestrator", ctx); },
  });
  pi.registerCommand("architect", {
    description: "Activate Architect agent (DeepSeek — converts ambiguity to decisions)",
    handler: async (_args, ctx) => { await activateAgent("architect", ctx); },
  });
  pi.registerCommand("planner", {
    description: "Activate Planner agent (DeepSeek — creates implementation plans)",
    handler: async (_args, ctx) => { await activateAgent("planner", ctx); },
  });
  pi.registerCommand("reviewer", {
    description: "Activate Reviewer agent (DeepSeek — quality gate)",
    handler: async (_args, ctx) => { await activateAgent("reviewer", ctx); },
  });
  pi.registerCommand("default", {
    description: "Activate Default agent (DeepSeek — hands-on engineering)",
    handler: async (_args, ctx) => { await activateAgent("default", ctx); },
  });

  // Qwen agents
  pi.registerCommand("researcher", {
    description: "Activate Researcher agent (Qwen — gathers information)",
    handler: async (_args, ctx) => { await activateAgent("researcher", ctx); },
  });
  pi.registerCommand("tester", {
    description: "Activate Tester agent (Qwen — defines test specifications)",
    handler: async (_args, ctx) => { await activateAgent("tester", ctx); },
  });
  pi.registerCommand("prompter", {
    description: "Activate Prompter agent (Qwen — translates tasks to coder prompts)",
    handler: async (_args, ctx) => { await activateAgent("prompter", ctx); },
  });
  pi.registerCommand("coder", {
    description: "Activate Coder agent (Qwen — implementation only)",
    handler: async (_args, ctx) => { await activateAgent("coder", ctx); },
  });
  pi.registerCommand("debugger", {
    description: "Activate Debugger agent (Qwen — finds defects, doesn't fix)",
    handler: async (_args, ctx) => { await activateAgent("debugger", ctx); },
  });
  pi.registerCommand("refactorer", {
    description: "Activate Refactorer agent (Qwen — improves structure, not behavior)",
    handler: async (_args, ctx) => { await activateAgent("refactorer", ctx); },
  });
  pi.registerCommand("documentor", {
    description: "Activate Documentor agent (Qwen — produces documentation)",
    handler: async (_args, ctx) => { await activateAgent("documentor", ctx); },
  });

  // ──────────────────────────────────────────────
  // Inject system prompt on each turn
  // ──────────────────────────────────────────────
  const AGENT_MARKER = "\n\n---\n# ACTIVE AGENT:";

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state.active || !state.prompt) return;

    // Strip any previous agent blocks from the system prompt.
    // Everything from the first AGENT_MARKER onward is removed —
    // handles single and stacked blocks in one pass.
    let base = event.systemPrompt;
    const idx = base.indexOf(AGENT_MARKER);
    if (idx !== -1) {
      base = base.slice(0, idx).trim();
    }

    // Prefix exactly one agent block
    const agentHeader = `${AGENT_MARKER}: ${state.active.toUpperCase()}\n---\n\n`;
    return {
      systemPrompt: agentHeader + state.prompt + "\n\n" + base,
    };
  });

  // ──────────────────────────────────────────────
  // Model guard — prevent mismatches
  // ──────────────────────────────────────────────
  pi.on("model_select", async (event, ctx) => {
    if (!state.active) return;

    const binding = BINDINGS[state.active];
    if (!binding) return;

    const newId = `${event.model.provider}/${event.model.id}`;
    const expected = binding.model;

    if (newId !== expected) {
      ctx.ui.notify(
        `⚠️  ${state.active} agent requires ${expected}, not ${newId}. Run /${state.active} to fix.`,
        "error",
      );
    }
  });

  // ──────────────────────────────────────────────
  // Status widget
  // ──────────────────────────────────────────────
  function updateWidget(ctx: any) {
    if (state.active) {
      const binding = BINDINGS[state.active];
      const modelId = currentModelId(ctx);
      const ok = modelId === binding.model;
      ctx.ui.setStatus(
        "agent",
        `${ok ? "✓" : "⚠"} ${binding.label}`,
      );
    } else {
      ctx.ui.setStatus("agent", "No agent active");
    }
  }

  pi.on("model_select", async (_event, ctx) => {
    updateWidget(ctx);
  });
}
