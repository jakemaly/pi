// Tavily API request/response types derived from OpenAPI specs

// ─── Search ───────────────────────────────────────────────────────────────────

export type SearchDepth = "basic" | "advanced" | "fast" | "ultra-fast";
export type SearchTopic = "general" | "news" | "finance";
export type TimeRange = "day" | "week" | "month" | "year";

export interface SearchRequest {
	query: string;
	search_depth?: SearchDepth;
	chunks_per_source?: number;
	max_results?: number;
	topic?: SearchTopic;
	time_range?: TimeRange;
	start_date?: string;
	end_date?: string;
	include_answer?: boolean | "basic" | "advanced";
	include_raw_content?: boolean | "markdown" | "text";
	include_images?: boolean;
	include_image_descriptions?: boolean;
	include_favicon?: boolean;
	include_domains?: string[];
	exclude_domains?: string[];
	country?: string;
	auto_parameters?: boolean;
	exact_match?: boolean;
	include_usage?: boolean;
}

export interface SearchResult {
	title: string;
	url: string;
	content: string;
	score?: number;
	raw_content?: string;
	favicon?: string;
	images?: Array<{ url: string; description?: string }>;
}

export interface SearchResponse {
	query: string;
	answer?: string;
	results: SearchResult[];
	images?: Array<{ url: string; description?: string }>;
	auto_parameters?: Record<string, unknown>;
	response_time?: number;
	usage?: { credits: number };
	request_id?: string;
}

// ─── Extract ──────────────────────────────────────────────────────────────────

export type ExtractDepth = "basic" | "advanced";
export type ContentFormat = "markdown" | "text";

export interface ExtractRequest {
	urls: string | string[];
	query?: string;
	chunks_per_source?: number;
	extract_depth?: ExtractDepth;
	include_images?: boolean;
	include_favicon?: boolean;
	format?: ContentFormat;
	timeout?: number;
	include_usage?: boolean;
}

export interface ExtractResult {
	url: string;
	raw_content: string;
	images?: string[];
	favicon?: string;
}

export interface ExtractFailedResult {
	url: string;
	error: string;
}

export interface ExtractResponse {
	results: ExtractResult[];
	failed_results?: ExtractFailedResult[];
	response_time?: number;
	usage?: { credits: number };
	request_id?: string;
}

// ─── Crawl ────────────────────────────────────────────────────────────────────

export interface CrawlRequest {
	url: string;
	instructions?: string;
	chunks_per_source?: number;
	max_depth?: number;
	max_breadth?: number;
	limit?: number;
	select_paths?: string[];
	select_domains?: string[];
	exclude_paths?: string[];
	exclude_domains?: string[];
	allow_external?: boolean;
	include_images?: boolean;
	extract_depth?: ExtractDepth;
	format?: ContentFormat;
	include_favicon?: boolean;
	timeout?: number;
	include_usage?: boolean;
}

export interface CrawlResult {
	url: string;
	raw_content: string;
	favicon?: string;
}

export interface CrawlResponse {
	base_url: string;
	results: CrawlResult[];
	response_time?: number;
	usage?: { credits: number };
	request_id?: string;
}

// ─── Map ──────────────────────────────────────────────────────────────────────

export interface MapRequest {
	url: string;
	instructions?: string;
	max_depth?: number;
	max_breadth?: number;
	limit?: number;
	select_paths?: string[];
	select_domains?: string[];
	exclude_paths?: string[];
	exclude_domains?: string[];
	allow_external?: boolean;
	timeout?: number;
	include_usage?: boolean;
}

export interface MapResponse {
	base_url: string;
	results: string[];
	response_time?: number;
	usage?: { credits: number };
	request_id?: string;
}

// ─── Research ─────────────────────────────────────────────────────────────────

export type ResearchModel = "mini" | "pro" | "auto";
export type OutputLength = "short" | "standard" | "long";
export type CitationFormat = "numbered" | "mla" | "apa" | "chicago";

export interface ResearchRequest {
	input: string;
	model?: ResearchModel;
	stream?: boolean;
	output_schema?: Record<string, unknown>;
	citation_format?: CitationFormat;
	include_domains?: string[];
	exclude_domains?: string[];
	output_length?: OutputLength;
}

export interface ResearchTask {
	request_id: string;
	created_at: string;
	status: "pending" | "processing" | "completed" | "failed";
	input: string;
	model?: ResearchModel;
	response_time?: number;
}

export interface ResearchResponse {
	request_id: string;
	created_at: string;
	status: string;
	input: string;
	model?: ResearchModel;
	completion?: {
		answer: string;
		citations?: string[];
	};
	error?: string;
	response_time?: number;
	usage?: { credits: number };
}

// ─── Error ────────────────────────────────────────────────────────────────────

export interface TavilyError {
	detail: {
		error: string;
	};
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface TavilyConfig {
	apiKey: string;
	search: {
		depth: SearchDepth;
		maxResults: number;
		chunksPerSource: number;
	};
	extract: {
		depth: ExtractDepth;
		format: ContentFormat;
	};
	crawl: {
		maxDepth: number;
		limit: number;
		extractDepth: ExtractDepth;
	};
	map: {
		maxDepth: number;
		limit: number;
	};
	research: {
		model: ResearchModel;
		outputLength: OutputLength;
		citationFormat: CitationFormat;
	};
}
