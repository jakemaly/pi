import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import type {
	SearchResponse,
	ExtractResponse,
	CrawlResponse,
	MapResponse,
	ResearchResponse,
} from "./types.js";

// ─── Search ───────────────────────────────────────────────────────────────────

export function formatSearchResults(data: SearchResponse): string {
	let output = "";

	if (data.answer) {
		output += `${data.answer}\n\n---\n\n`;
	}

	if (data.results.length === 0) {
		return output + "No results found.";
	}

	output += `**${data.results.length} result${data.results.length !== 1 ? "s" : ""} for:** "${data.query}"\n\n`;

	for (let i = 0; i < data.results.length; i++) {
		const r = data.results[i];
		output += `### ${i + 1}. ${r.title}\n`;
		output += `${r.url}\n`;
		if (r.score !== undefined) {
			output += `Score: ${r.score.toFixed(4)}\n`;
		}
		if (r.content) {
			output += `\n${r.content}\n`;
		}
		output += "\n";
	}

	if (data.usage) {
		output += `\n_Credits used: ${data.usage.credits}_`;
	}

	return output;
}

// ─── Extract ──────────────────────────────────────────────────────────────────

export function formatExtractResults(data: ExtractResponse): string {
	let output = "";

	const successCount = data.results.length;
	const failCount = data.failed_results?.length ?? 0;
	output += `**Extracted ${successCount} page${successCount !== 1 ? "s" : ""}`;
	if (failCount > 0) {
		output += `, ${failCount} failed`;
	}
	output += "**\n\n";

	for (const r of data.results) {
		output += `---\n`;
		output += `**${r.url}**\n\n`;
		output += r.raw_content;
		output += "\n\n";
	}

	if (data.failed_results && data.failed_results.length > 0) {
		output += "---\n**Failed URLs:**\n\n";
		for (const f of data.failed_results) {
			output += `- \`${f.url}\` — ${f.error}\n`;
		}
	}

	if (data.usage) {
		output += `\n_Credits used: ${data.usage.credits}_`;
	}

	return output;
}

// ─── Crawl ────────────────────────────────────────────────────────────────────

export function formatCrawlResults(data: CrawlResponse): string {
	let output = "";

	output += `**Crawled ${data.results.length} page${data.results.length !== 1 ? "s" : ""} from** \`${data.base_url}\`\n\n`;

	for (const r of data.results) {
		output += `---\n`;
		output += `**${r.url}**\n\n`;
		output += r.raw_content;
		output += "\n\n";
	}

	if (data.usage) {
		output += `\n_Credits used: ${data.usage.credits}_`;
	}

	// Truncate large crawl results
	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (truncation.truncated) {
		return truncation.content + `\n\n[Crawl output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines. Full output may be available.]`;
	}

	return output;
}

// ─── Map ──────────────────────────────────────────────────────────────────────

export function formatMapResults(data: MapResponse): string {
	let output = "";

	output += `**Site map for** \`${data.base_url}\` — **${data.results.length} URL${data.results.length !== 1 ? "s" : ""} discovered**\n\n`;

	for (let i = 0; i < data.results.length; i++) {
		output += `${i + 1}. ${data.results[i]}\n`;
	}

	if (data.usage) {
		output += `\n\n_Credits used: ${data.usage.credits}_`;
	}

	return output;
}

// ─── Research ─────────────────────────────────────────────────────────────────

export function formatResearchResult(data: ResearchResponse): string {
	let output = "";

	if (data.completion?.answer) {
		output += data.completion.answer;
	} else {
		output += `Research completed with status: ${data.status}`;
	}

	if (data.completion?.citations && data.completion.citations.length > 0) {
		output += `\n\n---\n\n**Sources:**\n`;
		for (const citation of data.completion.citations) {
			output += `- ${citation}\n`;
		}
	}

	if (data.usage) {
		output += `\n\n_Credits used: ${data.usage.credits}_`;
	}

	return output;
}
