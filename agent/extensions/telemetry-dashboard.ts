/**
 * Telemetry Dashboard — Pi Extension
 *
 * Tracks all token usage (input, output, cache read/write) and costs
 * across sessions. Provides real-time footer display, /usage overlay,
 * and budget tracking.
 *
 * Places:
 *   ~/.pi/agent/extensions/telemetry-dashboard.ts  (this file)
 *   ~/.pi/agent/telemetry.json                      (created at runtime)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { matchesKey } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Types ──────────────────────────────────────────

interface TokenCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

interface CostBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

interface ModelStats {
	tokens: TokenCounts;
	cost: CostBreakdown;
}

interface SessionStats {
	tokens: TokenCounts;
	cost: CostBreakdown;
	models: Record<string, ModelStats>;
}

interface SessionRecord {
	sessionFile: string;
	cwd: string;
	startedAt: string;
	endedAt?: string;
	stats: SessionStats;
}

interface TelemetryStore {
	version: number;
	budget?: { limit: number; currency: string };
	sessions: Record<string, SessionRecord>;
	totals: {
		tokens: TokenCounts;
		cost: { total: number };
		sessionsCount: number;
		firstSessionAt?: string;
		lastSessionAt?: string;
	};
	lastScannedAt?: string;
}

// ── Constants ──────────────────────────────────────

const TELEMETRY_PATH = path.join(os.homedir(), ".pi", "agent", "telemetry.json");
const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");
const BUDGET_THRESHOLDS = [50, 80, 95, 100];

// ── Helpers ────────────────────────────────────────

function emptyTokens(): TokenCounts {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function emptyCost(): CostBreakdown {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function emptyStats(): SessionStats {
	return { tokens: emptyTokens(), cost: emptyCost(), models: {} };
}

function addTokens(a: TokenCounts, b: Partial<TokenCounts>): TokenCounts {
	const t = { ...a };
	t.input += b.input ?? 0;
	t.output += b.output ?? 0;
	t.cacheRead += b.cacheRead ?? 0;
	t.cacheWrite += b.cacheWrite ?? 0;
	t.total = t.input + t.output + t.cacheRead + t.cacheWrite;
	return t;
}

function addCosts(a: CostBreakdown, b: Partial<CostBreakdown>): CostBreakdown {
	const c = { ...a };
	c.input += b.input ?? 0;
	c.output += b.output ?? 0;
	c.cacheRead += b.cacheRead ?? 0;
	c.cacheWrite += b.cacheWrite ?? 0;
	c.total = c.input + c.output + c.cacheRead + c.cacheWrite;
	return c;
}

function fmtTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function fmtCost(n: number): string {
	if (n === 0) return "$0.000";
	if (n < 0.01) return `$<0.01`;
	if (n < 1) return `$${n.toFixed(3)}`;
	if (n < 100) return `$${n.toFixed(2)}`;
	return `$${n.toFixed(1)}`;
}

function fmtDuration(ms: number): string {
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const s = sec % 60;
	if (min < 60) return `${min}m ${s}s`;
	const hr = Math.floor(min / 60);
	return `${hr}h ${min % 60}m`;
}

// ── Accumulation Helper (extracted to reduce duplication) ──

function accumulateUsage(
	stats: SessionStats,
	usage: Usage,
	provider: string,
	model: string,
): void {
	stats.tokens = addTokens(stats.tokens, {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
	});
	stats.cost = addCosts(stats.cost, {
		input: usage.cost?.input ?? 0,
		output: usage.cost?.output ?? 0,
		cacheRead: usage.cost?.cacheRead ?? 0,
		cacheWrite: usage.cost?.cacheWrite ?? 0,
		total: usage.cost?.total ?? 0,
	});

	const modelKey = `${provider}/${model}`;
	if (!stats.models[modelKey]) {
		stats.models[modelKey] = { tokens: emptyTokens(), cost: emptyCost() };
	}
	const ms = stats.models[modelKey];
	ms.tokens = addTokens(ms.tokens, {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
	});
	ms.cost = addCosts(ms.cost, {
		input: usage.cost?.input ?? 0,
		output: usage.cost?.output ?? 0,
		cacheRead: usage.cost?.cacheRead ?? 0,
		cacheWrite: usage.cost?.cacheWrite ?? 0,
		total: usage.cost?.total ?? 0,
	});
}

// ── Storage ────────────────────────────────────────

function loadStore(): TelemetryStore {
	try {
		const raw = fs.readFileSync(TELEMETRY_PATH, "utf8");
		const store = JSON.parse(raw) as TelemetryStore;
		if (store && store.version && typeof store.sessions === "object") {
			return store;
		}
	} catch {
		// File missing or corrupt
	}
	return createEmptyStore();
}

function createEmptyStore(): TelemetryStore {
	return {
		version: 1,
		sessions: {},
		totals: { tokens: emptyTokens(), cost: { total: 0 }, sessionsCount: 0 },
	};
}

function saveStore(store: TelemetryStore): void {
	try {
		const tmp = TELEMETRY_PATH + ".tmp";
		fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
		fs.renameSync(tmp, TELEMETRY_PATH);
	} catch (err) {
		console.error("[telemetry] Failed to save store:", err);
	}
}

// ── Session Scanning ───────────────────────────────

function scanSessionFile(filePath: string): SessionRecord | null {
	try {
		const raw = fs.readFileSync(filePath, "utf8").trim();
		if (!raw) return null;
		const lines = raw.split("\n");

		// Parse header
		let sessionFile = filePath;
		let cwd = "";
		let startedAt = "";
		let sessionId = "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session") {
					sessionId = entry.id || "";
					cwd = entry.cwd || "";
					startedAt = entry.timestamp || "";
					break;
				}
			} catch { /* skip */ }
		}

		const stats = emptyStats();

		// Scan all message entries
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "message" && entry.message?.role === "assistant") {
					const msg = entry.message as AssistantMessage;
					const usage = msg.usage;
					if (!usage) continue;

					stats.tokens = addTokens(stats.tokens, {
						input: usage.input ?? 0,
						output: usage.output ?? 0,
						cacheRead: usage.cacheRead ?? 0,
						cacheWrite: usage.cacheWrite ?? 0,
					});
					stats.cost = addCosts(stats.cost, {
						input: usage.cost?.input ?? 0,
						output: usage.cost?.output ?? 0,
						cacheRead: usage.cost?.cacheRead ?? 0,
						cacheWrite: usage.cost?.cacheWrite ?? 0,
						total: usage.cost?.total ?? 0,
					});

					// Per-model
					const modelKey = `${msg.provider}/${msg.model}`;
					if (!stats.models[modelKey]) {
						stats.models[modelKey] = { tokens: emptyTokens(), cost: emptyCost() };
					}
					const ms = stats.models[modelKey];
					ms.tokens = addTokens(ms.tokens, {
						input: usage.input ?? 0,
						output: usage.output ?? 0,
						cacheRead: usage.cacheRead ?? 0,
						cacheWrite: usage.cacheWrite ?? 0,
					});
					ms.cost = addCosts(ms.cost, {
						input: usage.cost?.input ?? 0,
						output: usage.cost?.output ?? 0,
						cacheRead: usage.cost?.cacheRead ?? 0,
						cacheWrite: usage.cost?.cacheWrite ?? 0,
						total: usage.cost?.total ?? 0,
					});
				}
			} catch { /* skip bad lines */ }
		}

		return {
			sessionFile,
			cwd,
			startedAt,
			stats,
		};
	} catch {
		return null;
	}
}

function findSessionFiles(): string[] {
	try {
		const results: string[] = [];
		const dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
		for (const d of dirs) {
			if (!d.isDirectory()) continue;
			const dirPath = path.join(SESSIONS_DIR, d.name);
			const files = fs.readdirSync(dirPath);
			for (const f of files) {
				if (f.endsWith(".jsonl")) {
					results.push(path.join(dirPath, f));
				}
			}
		}
		return results;
	} catch {
		return [];
	}
}

function scanAllSessions(store: TelemetryStore): TelemetryStore {
	const files = findSessionFiles();
	const lastScanned = store.lastScannedAt
		? new Date(store.lastScannedAt).getTime()
		: 0;

	let newSessions = 0;
	for (const file of files) {
		// Incremental: skip if not modified since last scan
		if (lastScanned > 0) {
			try {
				const stat = fs.statSync(file);
				if (stat.mtimeMs <= lastScanned) continue;
			} catch {
				continue;
			}
		}

		const record = scanSessionFile(file);
		if (!record) continue;

		// Use session file basename as key
		const key = path.basename(file, ".jsonl");
		store.sessions[key] = record;
		newSessions++;
	}

	// Recompute totals from all sessions
	let totalTokens = emptyTokens();
	let totalCost = 0;
	const sessionDates: string[] = [];

	for (const record of Object.values(store.sessions)) {
		totalTokens = addTokens(totalTokens, record.stats.tokens);
		totalCost += record.stats.cost.total;
		if (record.startedAt) sessionDates.push(record.startedAt);
	}

	sessionDates.sort();
	store.totals.tokens = totalTokens;
	store.totals.cost.total = totalCost;
	store.totals.sessionsCount = Object.keys(store.sessions).length;
	store.totals.firstSessionAt = sessionDates[0] || undefined;
	store.totals.lastSessionAt = sessionDates[sessionDates.length - 1] || undefined;
	store.lastScannedAt = new Date().toISOString();

	if (newSessions > 0) {
		console.log(`[telemetry] Scanned ${newSessions} session files`);
	}

	return store;
}

// ── Footer Formatting ──────────────────────────────

function formatFooterStats(
	stats: SessionStats,
	budgetLimit?: number,
): string {
	const parts: string[] = [];
	const t = stats.tokens;
	const c = stats.cost;
	const cacheTotal = t.cacheRead + t.cacheWrite;
	const cachePct = t.total > 0 ? Math.round((cacheTotal / t.total) * 100) : 0;

	parts.push(`↑${fmtTokens(t.input)}`);
	parts.push(`↓${fmtTokens(t.output)}`);
	if (cacheTotal > 0) parts.push(`cache:${fmtTokens(cacheTotal)}(${cachePct}%)`);
	parts.push(fmtCost(c.total));

	// Budget bar
	if (budgetLimit && budgetLimit > 0) {
		const pct = Math.min(100, (c.total / budgetLimit) * 100);
		const remaining = Math.max(0, budgetLimit - c.total);
		const barWidth = 15;
		const filled = Math.round((pct / 100) * barWidth);
		const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
		parts.push(`${bar} ${fmtCost(remaining)} left`);
	}

	return parts.join(" ");
}

// ── Usage Overlay Component ────────────────────────

function createUsageOverlay(
	stats: SessionStats,
	store: TelemetryStore,
	sessionStart: number,
	modelId?: string,
) {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	function renderLines(width: number): string[] {
		if (cachedLines && cachedWidth === width) return cachedLines;

		// Inner content width (minus 2 for border chars)
		const w = width - 2;
		const lines: string[] = [];
		const t = stats.tokens;
		const c = stats.cost;

		function row(text: string): string {
			return "│ " + text.padEnd(w - 2) + " │";
		}
		function sep(char: string = "─"): string {
			return "├" + char.repeat(w) + "┤";
		}

		// Header
		lines.push("┌" + "─".repeat(w) + "┐");
		lines.push(row("📊 Telemetry Dashboard"));
		lines.push(sep());

		// Token breakdown helper
		function tokenRow(t: TokenCounts): string[] {
			const r: string[] = [];
			const nonCache = t.input + t.output;
			const cacheTotal = t.cacheRead + t.cacheWrite;
			const cachePct = t.total > 0 ? ((cacheTotal / t.total) * 100).toFixed(0) : "0";
			const nonCachePct = t.total > 0 ? ((nonCache / t.total) * 100).toFixed(0) : "0";

			r.push(row(`  ↑ input:       ${fmtTokens(t.input).padStart(8)}`));
			r.push(row(`  ↓ output:      ${fmtTokens(t.output).padStart(8)}`));
			if (t.cacheRead > 0 || t.cacheWrite > 0) {
				r.push(row(`  R cache read:  ${fmtTokens(t.cacheRead).padStart(8)}`));
				if (t.cacheWrite > 0) {
					r.push(row(`  W cache write: ${fmtTokens(t.cacheWrite).padStart(8)}`));
				}
			}
			r.push(row(`  ─────────────────────────────`));
			r.push(row(`  total:         ${fmtTokens(t.total).padStart(8)}`));
			r.push(row(`  cache: ${cachePct}%  •  non-cache: ${nonCachePct}%`));
			return r;
		}

		// Current Session
		lines.push(row("Current Session"));
		if (modelId) {
			lines.push(row("Model: " + modelId));
		}
		lines.push(row(`Cost: ${fmtCost(c.total)}`));
		lines.push(row(`Elapsed: ${fmtDuration(Date.now() - sessionStart)}`));
		lines.push(sep());
		lines.push(row("Token Breakdown"));
		lines.push(...tokenRow(t));
		lines.push(sep());

		// Per-Model Breakdown
		lines.push(row("Per-Model Breakdown"));
		const modelEntries = Object.entries(stats.models);
		if (modelEntries.length > 0) {
			const colModel = Math.min(24, w - 36);
			const colIn = 8;
			const colOut = 8;
			const colCache = 8;
			const colCost = 8;
			if (colModel >= 6) {
				const hdr = `Model`.padEnd(colModel) + `  ${`↑In`.padStart(colIn)}  ${`↓Out`.padStart(colOut)}  ${`Cache`.padStart(colCache)}  ${`Cost`.padStart(colCost)}`;
				lines.push(row(hdr));
				lines.push(sep("─"));
				for (const [model, ms] of modelEntries) {
					const mShort = model.slice(0, colModel);
					const cacheTokens = ms.tokens.cacheRead + ms.tokens.cacheWrite;
					const line = mShort.padEnd(colModel) +
						`  ${fmtTokens(ms.tokens.input).padStart(colIn)}` +
						`  ${fmtTokens(ms.tokens.output).padStart(colOut)}` +
						`  ${fmtTokens(cacheTokens).padStart(colCache)}` +
						`  ${fmtCost(ms.cost.total).padStart(colCost)}`;
					lines.push(row(line));
				}
			}
		} else {
			lines.push(row("(no model data yet)"));
		}
		lines.push(sep());

		// All-Time Totals
		lines.push(row("All-Time Totals"));
		const all = store.totals;
		lines.push(row(`Sessions: ${all.sessionsCount}`));
		lines.push(row(`Cost: ${fmtCost(all.cost.total)}`));
		lines.push(sep());
		lines.push(row("Token Breakdown"));
		lines.push(...tokenRow(all.tokens));
		lines.push(sep());
		if (all.firstSessionAt && all.lastSessionAt) {
			lines.push(row(`Period: ${all.firstSessionAt.slice(0, 10)} → ${all.lastSessionAt.slice(0, 10)}`));
		}
		lines.push(sep());

		// Budget
		if (store.budget?.limit) {
			const limit = store.budget.limit;
			const spent = all.cost.total;
			const pct = Math.min(100, (spent / limit) * 100).toFixed(1);
			const remaining = Math.max(0, limit - spent);
			const barWidth = Math.max(10, Math.min(40, w - 30));
			const filled = Math.round((parseFloat(pct) / 100) * barWidth);
			const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
			lines.push(row("Budget"));
			lines.push(row(`${fmtCost(spent)} / ${fmtCost(limit)} (${pct}%) — ${fmtCost(remaining)} left  ${bar}`));
			lines.push(sep());
		}

		// Footer
		lines.push(row("Press Escape to close"));
		lines.push("└" + "─".repeat(w) + "┘");

		cachedWidth = width;
		cachedLines = lines;
		return lines;
	}

	return {
		render: (w: number) => renderLines(Math.max(w, 40)),
		invalidate: () => { cachedWidth = undefined; cachedLines = undefined; },
	};
}

// ── Extension ──────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let telemetryStore: TelemetryStore = createEmptyStore();
	let currentSessionStats: SessionStats = emptyStats();
	let sessionStartTime = Date.now();
	let lastNotifiedThreshold = -1;

	// ── session_start ──
	pi.on("session_start", async (_event, ctx) => {
		sessionStartTime = Date.now();
		currentSessionStats = emptyStats();
		lastNotifiedThreshold = -1;

		// Load store (with historical scan if needed)
		telemetryStore = loadStore();

		// Run historical scan in background
		setTimeout(() => {
			telemetryStore = scanAllSessions(telemetryStore);
			saveStore(telemetryStore);
		}, 100);

		// Scan current session entries for existing data
		const entries = ctx.sessionManager.getEntries();
		for (const entry of entries) {
			if (entry.type === "message" && entry.message?.role === "assistant") {
				const msg = entry.message as AssistantMessage;
				const usage = msg.usage;
				if (!usage) continue;

				currentSessionStats.tokens = addTokens(currentSessionStats.tokens, {
					input: usage.input ?? 0,
					output: usage.output ?? 0,
					cacheRead: usage.cacheRead ?? 0,
					cacheWrite: usage.cacheWrite ?? 0,
				});
				currentSessionStats.cost = addCosts(currentSessionStats.cost, {
					input: usage.cost?.input ?? 0,
					output: usage.cost?.output ?? 0,
					cacheRead: usage.cost?.cacheRead ?? 0,
					cacheWrite: usage.cost?.cacheWrite ?? 0,
					total: usage.cost?.total ?? 0,
				});

				const modelKey = `${msg.provider}/${msg.model}`;
				if (!currentSessionStats.models[modelKey]) {
					currentSessionStats.models[modelKey] = { tokens: emptyTokens(), cost: emptyCost() };
				}
				const ms = currentSessionStats.models[modelKey];
				ms.tokens = addTokens(ms.tokens, {
					input: usage.input ?? 0,
					output: usage.output ?? 0,
					cacheRead: usage.cacheRead ?? 0,
					cacheWrite: usage.cacheWrite ?? 0,
				});
				ms.cost = addCosts(ms.cost, {
					input: usage.cost?.input ?? 0,
					output: usage.cost?.output ?? 0,
					cacheRead: usage.cost?.cacheRead ?? 0,
					cacheWrite: usage.cost?.cacheWrite ?? 0,
					total: usage.cost?.total ?? 0,
				});
			}
		}

		if (ctx.hasUI) {
			ctx.ui.setStatus("telemetry", "📊 ready");
		}
	});

	// ── message_end ──
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const msg = event.message as AssistantMessage;
		const usage = msg.usage;
		if (!usage) return;

		// Accumulate session stats
		currentSessionStats.tokens = addTokens(currentSessionStats.tokens, {
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
		});
		currentSessionStats.cost = addCosts(currentSessionStats.cost, {
			input: usage.cost?.input ?? 0,
			output: usage.cost?.output ?? 0,
			cacheRead: usage.cost?.cacheRead ?? 0,
			cacheWrite: usage.cost?.cacheWrite ?? 0,
			total: usage.cost?.total ?? 0,
		});

		// Per-model
		const modelKey = `${msg.provider}/${msg.model}`;
		if (!currentSessionStats.models[modelKey]) {
			currentSessionStats.models[modelKey] = { tokens: emptyTokens(), cost: emptyCost() };
		}
		const ms = currentSessionStats.models[modelKey];
		ms.tokens = addTokens(ms.tokens, {
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
		});
		ms.cost = addCosts(ms.cost, {
			input: usage.cost?.input ?? 0,
			output: usage.cost?.output ?? 0,
			cacheRead: usage.cost?.cacheRead ?? 0,
			cacheWrite: usage.cost?.cacheWrite ?? 0,
			total: usage.cost?.total ?? 0,
		});

		// Update footer
		if (ctx.hasUI) {
			const budgetLimit = telemetryStore.budget?.limit;
			ctx.ui.setStatus("telemetry", formatFooterStats(currentSessionStats, budgetLimit));

						// Budget threshold notifications (use current session cost only to avoid double-counting)
			if (budgetLimit && budgetLimit > 0) {
				const sessionCost = currentSessionStats.cost.total;
				const pct = (sessionCost / budgetLimit) * 100;
				for (const threshold of BUDGET_THRESHOLDS) {
					if (pct >= threshold && lastNotifiedThreshold < threshold) {
						lastNotifiedThreshold = threshold;
						const level = threshold >= 100 ? "error" : threshold >= 80 ? "warning" : "info";
						ctx.ui.notify(`Budget: ${threshold}% used${threshold >= 100 ? " — exceeded!" : ""}`, level);
					}
				}
			}
		}
	});

	// ── session_shutdown ──
	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		const key = path.basename(sessionFile, ".jsonl");
		telemetryStore.sessions[key] = {
			sessionFile,
			cwd: ctx.sessionManager.getCwd(),
			startedAt: new Date(sessionStartTime).toISOString(),
			endedAt: new Date().toISOString(),
			stats: currentSessionStats,
		};

		// Recompute totals
		telemetryStore = scanAllSessions(telemetryStore);
		saveStore(telemetryStore);
	});

	// ── /usage command ──
	pi.registerCommand("usage", {
		description: "Show detailed token usage and cost breakdown",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Usage overlay requires TUI mode", "warning");
				return;
			}

			await ctx.ui.custom((_tui, _theme, _kb, done) => {
				const component = createUsageOverlay(
					currentSessionStats,
					telemetryStore,
					sessionStartTime,
					ctx.model?.provider ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				);

				return {
					...component,
					handleInput(data: string) {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
							done(undefined);
						}
					},
				};
			}, { overlay: true });
		},
	});

	// ── LLM-callable tool: show_usage_stats ──
	pi.registerTool({
		name: "show_usage_stats",
		label: "Show Usage Stats",
		description: "Return current session and all-time token usage, costs, and budget status.",
		parameters: Type.Object({}),
		async execute() {
			const t = currentSessionStats.tokens;
			const c = currentSessionStats.cost;
			const all = telemetryStore.totals;
			const budget = telemetryStore.budget;
			const cacheTotal = t.cacheRead + t.cacheWrite;
			const cachePct = t.total > 0 ? ((cacheTotal / t.total) * 100).toFixed(1) : "0";
			let text = `## Current Session\n\n`;
			text += `- Cost: ${fmtCost(c.total)}\n`;
			text += `- ↑ input: ${fmtTokens(t.input)}\n`;
			text += `- ↓ output: ${fmtTokens(t.output)}\n`;
			if (t.cacheRead > 0) text += `- R cache read: ${fmtTokens(t.cacheRead)}\n`;
			if (t.cacheWrite > 0) text += `- W cache write: ${fmtTokens(t.cacheWrite)}\n`;
			text += `- total: ${fmtTokens(t.total)} (cache: ${cachePct}%)\n`;
			if (Object.keys(currentSessionStats.models).length > 0) {
				text += `\n### Per-Model\n\n`;
				for (const [model, ms] of Object.entries(currentSessionStats.models)) {
					const mc = ms.tokens.cacheRead + ms.tokens.cacheWrite;
					const mp = ms.tokens.total > 0 ? ((mc / ms.tokens.total) * 100).toFixed(1) : "0";
					text += `- ${model}: ↑${fmtTokens(ms.tokens.input)} ↓${fmtTokens(ms.tokens.output)} cache:${fmtTokens(mc)} (${mp}%) ${fmtCost(ms.cost.total)}\n`;
				}
			}
			text += `\n## All-Time Totals\n\n`;
			text += `- Sessions: ${all.sessionsCount}\n`;
			const allCache = all.tokens.cacheRead + all.tokens.cacheWrite;
			const allCachePct = all.tokens.total > 0 ? ((allCache / all.tokens.total) * 100).toFixed(1) : "0";
			text += `- ↑ input: ${fmtTokens(all.tokens.input)}\n`;
			text += `- ↓ output: ${fmtTokens(all.tokens.output)}\n`;
			if (all.tokens.cacheRead > 0) text += `- R cache read: ${fmtTokens(all.tokens.cacheRead)}\n`;
			if (all.tokens.cacheWrite > 0) text += `- W cache write: ${fmtTokens(all.tokens.cacheWrite)}\n`;
			text += `- total: ${fmtTokens(all.tokens.total)} (cache: ${allCachePct}%)\n`;
			text += `- Cost: ${fmtCost(all.cost.total)}\n`;
			if (budget) {
				const remaining = Math.max(0, budget.limit - c.total);
				text += `\n## Budget\n\n`;
				text += `- Limit: ${fmtCost(budget.limit)}\n`;
				text += `- Spent: ${fmtCost(c.total)}\n`;
				text += `- Remaining: ${fmtCost(remaining)}\n`;
			}
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	// ── /budget command ──
	pi.registerCommand("budget", {
		description: "Set or view budget limit. Usage: /budget <amount>",
		getArgumentCompletions: (prefix) => {
			const defaults = ["5.00", "10.00", "25.00", "50.00", "100.00"];
			const filtered = defaults.filter((d) => d.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((v) => ({ value: v, label: `$${v}` })) : null;
		},
		handler: async (args, ctx) => {
			if (!args) {
				// Show current budget
				const budget = telemetryStore.budget?.limit;
				if (!budget) {
					ctx.ui.notify("No budget set. Use /budget <amount>", "info");
					return;
				}
				const allCost = telemetryStore.totals.cost.total + currentSessionStats.cost.total;
				const pct = ((allCost / budget) * 100).toFixed(1);
				const remaining = Math.max(0, budget - allCost);
				ctx.ui.notify(
					`Budget: ${fmtCost(allCost)} / ${fmtCost(budget)} (${pct}%) — ${fmtCost(remaining)} remaining`,
					"info",
				);
				return;
			}

			const amount = parseFloat(args);
			if (isNaN(amount) || amount <= 0) {
				ctx.ui.notify("Invalid amount. Use a positive number (e.g., /budget 10.00)", "error");
				return;
			}

			telemetryStore.budget = { limit: amount, currency: "USD" };
			saveStore(telemetryStore);
			ctx.ui.notify(`Budget set to ${fmtCost(amount)}`, "success");

			// Update footer
			if (ctx.hasUI) {
				ctx.ui.setStatus("telemetry", formatFooterStats(currentSessionStats, amount));
			}
		},
	});

	// ── /telemetry-reset command ──
	pi.registerCommand("telemetry-reset", {
		description: "Clear all telemetry data",
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm("Reset Telemetry?", "This will delete all usage history and budget data. Continue?");
			if (!ok) return;

			try {
				fs.unlinkSync(TELEMETRY_PATH);
			} catch {
				// ignore
			}

			telemetryStore = createEmptyStore();
			currentSessionStats = emptyStats();
			lastNotifiedThreshold = -1;

			if (ctx.hasUI) {
				ctx.ui.setStatus("telemetry", "📊 reset");
			}
			ctx.ui.notify("Telemetry data cleared", "success");
		},
	});
}
