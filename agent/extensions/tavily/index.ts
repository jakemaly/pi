import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { loadConfig, validateApiKey, getConfigPath } from "./config.js";
import { tavilySearch, tavilyExtract, tavilyCrawl, tavilyMap, tavilyResearch, TavilyApiError } from "./tavily.js";
import {
	formatSearchResults,
	formatExtractResults,
	formatCrawlResults,
	formatMapResults,
	formatResearchResult,
} from "./format.js";

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	let researchTimers: ReturnType<typeof setInterval>[] = [];

	// ─── Session lifecycle ─────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		const validation = validateApiKey(config.apiKey);
		if (!validation.ok) {
			ctx.ui.notify(`Tavily: ${validation.error} (${getConfigPath()})`, "warning");
		} else {
			ctx.ui.notify("Tavily loaded", "info");
		}
	});

	pi.on("session_shutdown", async (_event) => {
		// Clear any in-flight research polling
		for (const timer of researchTimers) {
			clearInterval(timer);
		}
		researchTimers = [];
	});

	// ─── Tool: search ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "search",
		label: "Search",
		description:
			"Search the web for real-time information. Returns ranked results with titles, URLs, content snippets, and relevance scores. Use for finding current information, documentation, news, or any topic requiring live web data.",
		promptSnippet: "Search the web for real-time information with ranked results and content snippets.",
		promptGuidelines: [
			"Use search when the user asks about current events, recent changes, documentation, or any topic requiring live web data.",
			"Use search before extract — find relevant URLs first, then extract full content.",
			"Prefer advanced depth for detailed answers; use fast or ultra-fast for quick lookups.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			depth: Type.Optional(
				StringEnum(["basic", "advanced", "fast", "ultra-fast"] as const),
			),
			maxResults: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 20,
					description: "Maximum number of results (1-20)",
				}),
			),
			topic: Type.Optional(
				StringEnum(["general", "news", "finance"] as const),
			),
			timeRange: Type.Optional(
				StringEnum(["day", "week", "month", "year"] as const),
			),
			includeDomains: Type.Optional(
				Type.Array(
					Type.String({ description: "Domains to include" }),
				),
			),
			excludeDomains: Type.Optional(
				Type.Array(
					Type.String({ description: "Domains to exclude" }),
				),
			),
			includeAnswer: Type.Optional(
				Type.Boolean({ description: "Include an LLM-generated answer to the query" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const cfg = loadConfig();
			const validation = validateApiKey(cfg.apiKey);
			if (!validation.ok) throw new Error(validation.error);

			const response = await tavilySearch(cfg.apiKey, {
				query: params.query,
				search_depth: params.depth ?? cfg.search.depth,
				chunks_per_source: cfg.search.chunksPerSource,
				max_results: params.maxResults ?? cfg.search.maxResults,
				topic: params.topic,
				time_range: params.timeRange,
				include_domains: params.includeDomains,
				exclude_domains: params.excludeDomains,
				include_answer: params.includeAnswer ?? false,
			}, signal);

			return {
				content: [{ type: "text", text: formatSearchResults(response) }],
				details: { request_id: response.request_id, credits: response.usage?.credits },
			};
		},
	});

	// ─── Tool: extract ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "extract",
		label: "Extract",
		description:
			"Extract clean, structured content from one or more URLs. Returns markdown or plain text with navigation and ads removed. Use after search to get full page content from specific URLs, or when you already know the URLs you need.",
		promptSnippet: "Extract clean markdown content from specific URLs.",
		promptGuidelines: [
			"Use extract when you have specific URLs and need full page content.",
			"Use search → extract pattern: search to find relevant URLs, then extract for full content.",
			"Pass a query parameter to focus extraction on relevant sections of the page.",
		],
		parameters: Type.Object({
			urls: Type.Union([
				Type.String({ description: "Single URL to extract" }),
				Type.Array(Type.String({ description: "URLs to extract" })),
			]),
			query: Type.Optional(
				Type.String({ description: "Query for reranking extracted chunks" }),
			),
			chunksPerSource: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5,
					description: "Chunks per source (1-5)",
				}),
			),
			depth: Type.Optional(
				StringEnum(["basic", "advanced"] as const),
			),
			includeImages: Type.Optional(Type.Boolean()),
			format: Type.Optional(
				StringEnum(["markdown", "text"] as const),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const cfg = loadConfig();
			const validation = validateApiKey(cfg.apiKey);
			if (!validation.ok) throw new Error(validation.error);

			const urls = typeof params.urls === "string" ? [params.urls] : params.urls;
			if (urls.length === 0) throw new Error("At least one URL is required");

			const response = await tavilyExtract(cfg.apiKey, {
				urls,
				query: params.query,
				chunks_per_source: params.chunksPerSource,
				extract_depth: params.depth ?? cfg.extract.depth,
				include_images: params.includeImages,
				format: params.format ?? cfg.extract.format,
			}, signal);

			return {
				content: [{ type: "text", text: formatExtractResults(response) }],
				details: { request_id: response.request_id, credits: response.usage?.credits },
			};
		},
	});

	// ─── Tool: crawl ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "crawl",
		label: "Crawl",
		description:
			"Crawl a website and extract content from multiple pages. Graph-based traversal that discovers and extracts content from linked pages. Use when you need to read many pages from a single site, such as documentation sites or blogs.",
		promptSnippet: "Crawl and extract content from multiple pages on a website.",
		promptGuidelines: [
			"Use crawl when you need content from many pages on the same site.",
			"Use map first to discover site structure, then crawl targeted sections.",
			"Use instructions to focus the crawl on specific topics or page types.",
			"Keep limit reasonable (default 50) to avoid excessive credit usage.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Root URL to begin crawling" }),
			instructions: Type.Optional(
				Type.String({ description: "Natural language instructions for the crawler" }),
			),
			maxDepth: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5,
					description: "Maximum crawl depth (1-5)",
				}),
			),
			maxBreadth: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 500,
					description: "Max links per level (1-500)",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Total pages to crawl",
				}),
			),
			selectPaths: Type.Optional(
				Type.Array(Type.String({ description: "Regex patterns for path selection" })),
			),
			excludePaths: Type.Optional(
				Type.Array(Type.String({ description: "Regex patterns for path exclusion" })),
			),
			extractDepth: Type.Optional(
				StringEnum(["basic", "advanced"] as const),
			),
			includeImages: Type.Optional(Type.Boolean()),
			format: Type.Optional(
				StringEnum(["markdown", "text"] as const),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const cfg = loadConfig();
			const validation = validateApiKey(cfg.apiKey);
			if (!validation.ok) throw new Error(validation.error);

			const response = await tavilyCrawl(cfg.apiKey, {
				url: params.url,
				instructions: params.instructions,
				max_depth: params.maxDepth ?? cfg.crawl.maxDepth,
				max_breadth: params.maxBreadth,
				limit: params.limit ?? cfg.crawl.limit,
				select_paths: params.selectPaths,
				exclude_paths: params.excludePaths,
				extract_depth: params.extractDepth ?? cfg.crawl.extractDepth,
				include_images: params.includeImages,
				format: params.format ?? cfg.extract.format,
			}, signal);

			return {
				content: [{ type: "text", text: formatCrawlResults(response) }],
				details: { request_id: response.request_id, credits: response.usage?.credits },
			};
		},
	});

	// ─── Tool: map ─────────────────────────────────────────────────────────

	pi.registerTool({
		name: "map",
		label: "Map",
		description:
			"Generate a site map by discovering all URLs on a website. Returns a list of URLs without content. Use before crawl to understand a site's structure and plan targeted crawling.",
		promptSnippet: "Discover all URLs on a website without extracting content.",
		promptGuidelines: [
			"Use map before crawl to understand site structure and plan targeted crawling.",
			"Use instructions to filter for specific page types or topics.",
			"Map is cheap (1 credit per 10 pages) — use it freely for site exploration.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Root URL to begin mapping" }),
			instructions: Type.Optional(
				Type.String({ description: "Natural language instructions for filtering" }),
			),
			maxDepth: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5,
					description: "Maximum mapping depth (1-5)",
				}),
			),
			maxBreadth: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 500,
					description: "Max links per level (1-500)",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Maximum URLs to discover",
				}),
			),
			selectPaths: Type.Optional(
				Type.Array(Type.String({ description: "Regex patterns for path selection" })),
			),
			excludePaths: Type.Optional(
				Type.Array(Type.String({ description: "Regex patterns for path exclusion" })),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const cfg = loadConfig();
			const validation = validateApiKey(cfg.apiKey);
			if (!validation.ok) throw new Error(validation.error);

			const response = await tavilyMap(cfg.apiKey, {
				url: params.url,
				instructions: params.instructions,
				max_depth: params.maxDepth ?? cfg.map.maxDepth,
				max_breadth: params.maxBreadth,
				limit: params.limit ?? cfg.map.limit,
				select_paths: params.selectPaths,
				exclude_paths: params.excludePaths,
			}, signal);

			return {
				content: [{ type: "text", text: formatMapResults(response) }],
				details: { request_id: response.request_id, credits: response.usage?.credits },
			};
		},
	});

	// ─── Tool: research ────────────────────────────────────────────────────

	pi.registerTool({
		name: "research",
		label: "Research",
		description:
			"Run comprehensive multi-source research that searches, analyzes sources, and generates a cited report. Use when you need a finished, synthesis-level answer with citations — not raw search results. Returns a complete research report with sources. This is an async operation that may take 30-120 seconds.",
		promptSnippet: "Run comprehensive multi-source research and get a cited report with sources.",
		promptGuidelines: [
			"Use research when the user asks for a report, comparison, analysis, or decision-ready answer.",
			"Use search when you need raw source URLs and content to process yourself.",
			"Research is expensive (4-250 credits) — use it for complex questions only.",
			"Research is async and may take 30-120 seconds — inform the user if relevant.",
		],
		parameters: Type.Object({
			input: Type.String({
				description: "The research question or topic to investigate",
			}),
			model: Type.Optional(
				StringEnum(["mini", "pro", "auto"] as const),
			),
			outputLength: Type.Optional(
				StringEnum(["short", "standard", "long"] as const),
			),
			citationFormat: Type.Optional(
				StringEnum(["numbered", "mla", "apa", "chicago"] as const),
			),
			includeDomains: Type.Optional(
				Type.Array(Type.String({ description: "Preferred source domains" })),
			),
			excludeDomains: Type.Optional(
				Type.Array(Type.String({ description: "Excluded source domains" })),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const cfg = loadConfig();
			const validation = validateApiKey(cfg.apiKey);
			if (!validation.ok) throw new Error(validation.error);

			const response = await tavilyResearch(
				cfg.apiKey,
				{
					input: params.input,
					model: params.model ?? cfg.research.model,
					output_length: params.outputLength ?? cfg.research.outputLength,
					citation_format: params.citationFormat ?? cfg.research.citationFormat,
					include_domains: params.includeDomains,
					exclude_domains: params.excludeDomains,
				},
				signal,
				(text) => {
					onUpdate?.({ content: [{ type: "text", text }] });
				},
			);

			return {
				content: [{ type: "text", text: formatResearchResult(response) }],
				details: { request_id: response.request_id, credits: response.usage?.credits },
			};
		},
	});

	// ─── Command: /tavily ──────────────────────────────────────────────────

	pi.registerCommand("tavily", {
		description: "Show Tavily extension status and settings",
		handler: async (_args, ctx) => {
			const cfg = loadConfig();
			const validation = validateApiKey(cfg.apiKey);

			let info = "Tavily Extension Status\n\n";
			info += `Config: ${getConfigPath()}\n`;
			info += `API Key: ${validation.ok ? "✓ configured" : "✗ " + validation.error}\n`;
			info += `\nDefaults:\n`;
			info += `  Search depth: ${cfg.search.depth}\n`;
			info += `  Search max results: ${cfg.search.maxResults}\n`;
			info += `  Extract depth: ${cfg.extract.depth}\n`;
			info += `  Crawl max depth: ${cfg.crawl.maxDepth}\n`;
			info += `  Crawl limit: ${cfg.crawl.limit}\n`;
			info += `  Map max depth: ${cfg.map.maxDepth}\n`;
			info += `  Research model: ${cfg.research.model}\n`;

			ctx.ui.notify(info.split("\n")[0], "info");
		},
	});
}
