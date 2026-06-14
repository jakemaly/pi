import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TavilyConfig } from "./types.js";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "tavily.json");

const DEFAULTS: TavilyConfig = {
	apiKey: "",
	search: {
		depth: "advanced",
		maxResults: 5,
		chunksPerSource: 4,
	},
	extract: {
		depth: "basic",
		format: "markdown",
	},
	crawl: {
		maxDepth: 2,
		limit: 50,
		extractDepth: "basic",
	},
	map: {
		maxDepth: 1,
		limit: 50,
	},
	research: {
		model: "mini",
		outputLength: "standard",
		citationFormat: "numbered",
	},
};

export function getConfigPath(): string {
	return CONFIG_PATH;
}

export function loadConfig(): TavilyConfig {
	if (!fs.existsSync(CONFIG_PATH)) {
		return structuredClone(DEFAULTS);
	}

	const raw = fs.readFileSync(CONFIG_PATH, "utf8");
	let user: Partial<TavilyConfig>;
	try {
		user = JSON.parse(raw) as Partial<TavilyConfig>;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	return {
		apiKey: user.apiKey ?? DEFAULTS.apiKey,
		search: { ...DEFAULTS.search, ...user.search },
		extract: { ...DEFAULTS.extract, ...user.extract },
		crawl: { ...DEFAULTS.crawl, ...user.crawl },
		map: { ...DEFAULTS.map, ...user.map },
		research: { ...DEFAULTS.research, ...user.research },
	};
}

export function saveConfig(updates: Partial<TavilyConfig>): void {
	let config: Record<string, unknown> = {};
	if (fs.existsSync(CONFIG_PATH)) {
		const raw = fs.readFileSync(CONFIG_PATH, "utf8");
		try {
			config = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			// Start fresh if parse fails
		}
	}

	Object.assign(config, updates);
	const dir = path.join(os.homedir(), ".pi");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function validateApiKey(key: string): { ok: boolean; error?: string } {
	if (!key) return { ok: false, error: "No API key configured. Add your key to ~/.pi/tavily.json" };
	if (!key.startsWith("tvly-")) return { ok: false, error: `API key format invalid (expected tvly-... prefix): ${key.slice(0, 8)}...` };
	return { ok: true };
}
