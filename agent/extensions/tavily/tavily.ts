import type {
	SearchRequest,
	SearchResponse,
	ExtractRequest,
	ExtractResponse,
	CrawlRequest,
	CrawlResponse,
	MapRequest,
	MapResponse,
	ResearchRequest,
	ResearchResponse,
	TavilyError,
} from "./types.js";

const BASE_URL = "https://api.tavily.com";

function headers(apiKey: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
	};
}

async function tavilyPost<T>(
	endpoint: string,
	body: Record<string, unknown>,
	apiKey: string,
	signal?: AbortSignal,
): Promise<T> {
	const res = await fetch(`${BASE_URL}/${endpoint}`, {
		method: "POST",
		headers: headers(apiKey),
		body: JSON.stringify(body),
		signal,
	});

	if (!res.ok) {
		const err = (await res.json()) as TavilyError;
		throw new TavilyApiError(err.detail?.error ?? `HTTP ${res.status}`, res.status);
	}

	return res.json() as Promise<T>;
}

async function tavilyGet<T>(
	endpoint: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<T> {
	const res = await fetch(`${BASE_URL}/${endpoint}`, {
		headers: headers(apiKey),
		signal,
	});

	if (!res.ok) {
		const err = (await res.json()) as TavilyError;
		throw new TavilyApiError(err.detail?.error ?? `HTTP ${res.status}`, res.status);
	}

	return res.json() as Promise<T>;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export async function tavilySearch(
	apiKey: string,
	params: SearchRequest,
	signal?: AbortSignal,
): Promise<SearchResponse> {
	return tavilyPost<SearchResponse>("search", params, apiKey, signal);
}

// ─── Extract ──────────────────────────────────────────────────────────────────

export async function tavilyExtract(
	apiKey: string,
	params: ExtractRequest,
	signal?: AbortSignal,
): Promise<ExtractResponse> {
	return tavilyPost<ExtractResponse>("extract", params, apiKey, signal);
}

// ─── Crawl ────────────────────────────────────────────────────────────────────

export async function tavilyCrawl(
	apiKey: string,
	params: CrawlRequest,
	signal?: AbortSignal,
): Promise<CrawlResponse> {
	return tavilyPost<CrawlResponse>("crawl", params, apiKey, signal);
}

// ─── Map ──────────────────────────────────────────────────────────────────────

export async function tavilyMap(
	apiKey: string,
	params: MapRequest,
	signal?: AbortSignal,
): Promise<MapResponse> {
	return tavilyPost<MapResponse>("map", params, apiKey, signal);
}

// ─── Research (async with polling) ────────────────────────────────────────────

export async function tavilyResearch(
	apiKey: string,
	params: ResearchRequest,
	signal?: AbortSignal,
	onUpdate?: (text: string) => void,
): Promise<ResearchResponse> {
	// Step 1: Create research task
	onUpdate?.("Creating research task...");
	const task = await tavilyPost<ResearchResponse>("research", params, apiKey, signal);
	const requestId = task.request_id;
	if (!requestId) {
		throw new Error("Research task created but no request_id returned");
	}

	// Step 2: Poll for completion
	const pollInterval = 3000; // 3 seconds
	const maxAttempts = 200; // Up to 10 minutes
	let attempts = 0;

	while (attempts < maxAttempts) {
		if (signal?.aborted) {
			throw new Error("Research cancelled");
		}

		await sleep(pollInterval, signal);
		attempts++;

		const status = await tavilyGet<ResearchResponse>(`research/${requestId}`, apiKey, signal);
		const statusText = status.status;

		if (statusText === "pending") {
			onUpdate?.("Research task queued...");
		} else if (statusText === "processing") {
			onUpdate?.(`Research in progress... (${attempts * 3}s elapsed)`);
		} else if (statusText === "completed") {
			return status;
		} else if (statusText === "failed") {
			throw new Error(`Research failed: ${status.error ?? "unknown error"}`);
		} else {
			throw new Error(`Unknown research status: ${statusText}`);
		}
	}

	throw new Error(`Research timed out after ${maxAttempts * pollInterval / 1000}s`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		}, { once: true });
	});
}

// ─── Error class ──────────────────────────────────────────────────────────────

export class TavilyApiError extends Error {
	constructor(message: string, public status: number) {
		super(`Tavily API (${status}): ${message}`);
		this.name = "TavilyApiError";
	}
}
