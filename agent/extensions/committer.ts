/**
 * Committer — conventional commit tool for the pipeline coder agent.
 *
 * Registered as a tool so the coder can call it directly:
 *   git_commit({ message: "feat: add JWT validation middleware" })
 *
 * Follows conventionalcommits.org v1.0.0.
 * Always commits on a remote tracking branch (creates one if needed).
 * Skips sensitive files (.env, secrets) and pipeline artifacts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ── Sensitive file patterns ──────────────────────

const SENSITIVE_PATTERNS = [
  /\.env(\..*)?$/,           // .env, .env.local, .env.production
  /\.pem$/,                   // private keys
  /\.key$/,                   // key files  
  /secret/i,                  // anything with "secret" in path
  /password/i,                // anything with "password" in path
  /token/i,                   // anything with "token" in path
  /credentials/i,             // credential files
];

const SKIP_DIRS = [
  ".pi/pipeline/",           // pipeline artifacts (plans, specs)
  "node_modules/",
  ".git/",
];

function isSensitive(filePath: string): boolean {
  const basename = path.basename(filePath);
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(basename) || pattern.test(filePath)) return true;
  }
  for (const dir of SKIP_DIRS) {
    if (filePath.startsWith(dir)) return true;
  }
  return false;
}

// ── Conventional commit validation ───────────────

const CONVENTIONAL_TYPES = [
  "feat", "fix", "docs", "style", "refactor", "perf",
  "test", "build", "ci", "chore", "revert",
];

const CONVENTIONAL_RE = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9._-]+\))?!?: .+/;

function validateMessage(message: string): string | null {
  if (!CONVENTIONAL_RE.test(message)) {
    const types = CONVENTIONAL_TYPES.join(", ");
    return `Commit message must follow conventional commits: <type>: <description>\nValid types: ${types}\nExample: feat: add JWT validation middleware`;
  }
  if (message.length > 72) {
    return `Subject line too long (${message.length} chars). Max 72 characters.`;
  }
  return null;
}

// ── Git helpers ──────────────────────────────────

function exec(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, {
      cwd: cwd || process.cwd(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e: any) {
    return "";
  }
}

function currentBranch(cwd: string): string {
  return exec("git rev-parse --abbrev-ref HEAD", cwd);
}

function hasRemote(branch: string, cwd: string): boolean {
  const remote = exec(`git rev-parse --abbrev-ref "${branch}@{upstream}"`, cwd);
  return remote !== "" && !remote.startsWith("fatal:");
}

function ensureRemoteBranch(cwd: string): { branch: string; created: boolean } {
  const branch = currentBranch(cwd);

  // If on main/master, create a feature branch
  if (branch === "main" || branch === "master") {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const newBranch = `feature/pipeline-${ts}`;
    exec(`git checkout -b "${newBranch}"`, cwd);
    return { branch: newBranch, created: true };
  }

  // Check if branch has a remote
  if (!hasRemote(branch, cwd)) {
    // Push and set upstream
    exec(`git push -u origin "${branch}"`, cwd);
    return { branch, created: false };
  }

  return { branch, created: false };
}

// ── Tool implementation ──────────────────────────

const gitCommitTool = {
  name: "git_commit",
  label: "Git Commit",
  description:
    "Create a conventional commit on a remote branch. Skips sensitive files automatically. " +
    "Use after completing each implementation task or making significant progress.",
  parameters: Type.Object({
    message: Type.String({
      description:
        "Commit message in conventional format. Examples: " +
        '"feat: add JWT validation middleware", ' +
        '"fix: correct token expiry check", ' +
        '"refactor: extract auth helpers". ' +
        "Must start with type: (feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert).",
    }),
    scope: Type.Optional(
      Type.String({
        description: "Optional scope. Example: feat(auth): add JWT middleware",
      }),
    ),
    files: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Specific files to commit. If omitted, commits all tracked changes " +
          "(sensitive files are always excluded).",
      }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: { message: string; scope?: string; files?: string[] },
    _signal: AbortSignal,
    _onUpdate: (update: any) => void,
    _ctx: ExtensionContext,
  ) {
    const cwd = process.cwd();
    const results: string[] = [];

    // 1. Check we're in a git repo
    if (!fs.existsSync(path.join(cwd, ".git"))) {
      return {
        content: [{ type: "text", text: "Error: Not a git repository. Initialize with `git init` first." }],
        details: { success: false, error: "not a git repo" },
      };
    }

    // 2. Validate message format
    const fullMessage = params.scope
      ? `${params.message.split(":")[0]}(${params.scope}): ${params.message.split(": ").slice(1).join(": ")}`
      : params.message;
    
    const msgError = validateMessage(params.message);
    if (msgError) {
      return {
        content: [{ type: "text", text: `Invalid commit message:\n${msgError}` }],
        details: { success: false, error: msgError },
      };
    }

    // 3. Ensure we're on a remote branch
    try {
      const { branch, created } = ensureRemoteBranch(cwd);
      if (created) {
        results.push(`Created branch: ${branch}`);
      } else {
        results.push(`On branch: ${branch}`);
      }
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Failed to create/push branch:\n${e.message}` }],
        details: { success: false, error: e.message },
      };
    }

    // 4. Check for changes
    const status = exec("git status --porcelain", cwd);
    if (!status) {
      return {
        content: [{ type: "text", text: "Nothing to commit. Working tree clean." }],
        details: { success: true, committed: false, reason: "no changes" },
      };
    }

    // 5. Stage files (excluding sensitive ones)
    const skipped: string[] = [];
    if (params.files && params.files.length > 0) {
      for (const file of params.files) {
        if (isSensitive(file)) {
          skipped.push(file);
          continue;
        }
        const out = exec(`git add "${file}"`, cwd);
        if (out.startsWith("fatal:")) {
          skipped.push(`${file} (${out})`);
        }
      }
      if (skipped.length > 0) {
        results.push(`Skipped ${skipped.length} file(s): ${skipped.join(", ")}`);
      }
    } else {
      // Stage all, but check each tracked change
      const lines = status.split("\n").filter(Boolean);
      let staged = 0;
      for (const line of lines) {
        const filePath = line.slice(3).trim();
        if (isSensitive(filePath)) {
          skipped.push(filePath);
          continue;
        }
        exec(`git add "${filePath}"`, cwd);
        staged++;
      }
      if (skipped.length > 0) {
        results.push(`Auto-skipped ${skipped.length} sensitive file(s): ${skipped.join(", ")}`);
      }
      if (staged === 0 && skipped.length > 0) {
        return {
          content: [{ type: "text", text: `All ${skipped.length} changed files are sensitive. Nothing committed.\nSkipped: ${skipped.join(", ")}` }],
          details: { success: false, reason: "all files sensitive", skipped },
        };
      }
    }

    // 6. Check staging area has something
    const staged = exec("git diff --cached --name-only", cwd);
    if (!staged) {
      return {
        content: [{ type: "text", text: `No files staged after filtering. Skipped: ${skipped.join(", ") || "none"}` }],
        details: { success: false, reason: "nothing staged" },
      };
    }

    // 7. Commit
    const commitOut = exec(`git commit -m "${params.message.replace(/"/g, '\\"')}"`, cwd);
    results.push(commitOut);

    // 8. Push
    try {
      const branch = currentBranch(cwd);
      const pushOut = exec(`git push origin "${branch}"`, cwd);
      results.push(pushOut || "Pushed successfully.");
    } catch (e: any) {
      results.push(`Warning: Push failed — ${e.message}. Commit is local.`);
    }

    return {
      content: [{ type: "text", text: results.join("\n") }],
      details: {
        success: true,
        message: params.message,
        skipped: skipped.length > 0 ? skipped : undefined,
        branch: currentBranch(cwd),
      },
    };
  },
};

// ── Extension entry point ────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool(gitCommitTool);
}
