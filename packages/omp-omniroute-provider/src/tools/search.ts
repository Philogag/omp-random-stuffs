// `omniroute_web_search` — omp tool definition.
//
// Ported from the pi build. Two structural changes: tools are built from the
// injected `pi.typebox` schema builder (omp's only TypeBox surface) and the pi
// `prepareArguments` hook is gone — omp's ToolDefinition has no such field, so
// argument normalization happens at the top of `execute`.

import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { omnirouteRequest, resolveApiKey, resolveBaseUrl } from "./http.ts";

export const STATIC_FALLBACK_PROVIDERS: readonly string[] = [
  "serper-search",
  "brave-search",
  "perplexity-search",
  "exa-search",
  "tavily-search",
  "firecrawl",
  "google-pse-search",
  "linkup-search",
  "ollama-search",
  "searchapi-search",
  "youcom-search",
  "searxng-search",
  "zai-search",
  "duckduckgo-free",
];

export const SEARCH_PROVIDERS = STATIC_FALLBACK_PROVIDERS;
export const SEARCH_TYPES = ["web", "news"] as const;
export const TIME_RANGES = ["any", "hour", "day", "week", "month", "year"] as const;

export interface SearchToolDeps {
  pi: ExtensionAPI;
  /** Configured default provider, read at call time so settings edits apply live. */
  getConfiguredProvider: () => string | undefined;
}

export function isValidProvider(provider: string | undefined): provider is string {
  // Unknown / non-canonical provider ids are dropped rather than forwarded, so
  // a bad setting cannot turn every search into a 4xx from OmniRoute.
  return (
    typeof provider === "string" &&
    STATIC_FALLBACK_PROVIDERS.includes(provider) &&
    provider !== "auto"
  );
}

const SEARCH_RESULT_LIMIT = 20_000;

export function formatSearchResults(json: unknown, query: string): string {
  if (json && typeof json === "object" && Array.isArray((json as { results?: unknown }).results)) {
    const results = (json as { results: Array<Record<string, unknown>> }).results;
    const blocks: string[] = [];
    let total = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i] ?? {};
      const lines = [`${i + 1}. ${typeof r.title === "string" && r.title ? r.title : "(untitled)"}`];
      if (typeof r.url === "string" && r.url) lines.push(`   URL: ${r.url}`);
      if (typeof r.snippet === "string" && r.snippet) lines.push(`   ${r.snippet}`);
      const block = lines.join("\n");
      if (total + block.length + 1 > SEARCH_RESULT_LIMIT && blocks.length > 0) {
        blocks.push(`[truncated: ${results.length - blocks.length} of ${results.length} results omitted]`);
        break;
      }
      blocks.push(block);
      total += block.length + 1;
    }
    if (blocks.length > 0) return blocks.join("\n\n");
    return `No results for query: ${query}`;
  }
  return JSON.stringify(json).slice(0, SEARCH_RESULT_LIMIT);
}

export function createSearchTool(deps: SearchToolDeps): ToolDefinition {
  const { Type } = deps.pi.typebox;

  const stringEnum = (values: readonly string[]) =>
    Type.Union(values.map((value) => Type.Literal(value)));

  const parameters = Type.Object(
    {
      query: Type.String({ minLength: 1, maxLength: 500 }),
      provider: Type.Optional(stringEnum(SEARCH_PROVIDERS)),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      search_type: Type.Optional(stringEnum(SEARCH_TYPES)),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      country: Type.Optional(Type.String({ maxLength: 2 })),
      language: Type.Optional(Type.String({ minLength: 2, maxLength: 5 })),
      time_range: Type.Optional(stringEnum(TIME_RANGES)),
      content: Type.Optional(
        Type.Object(
          {
            snippet: Type.Optional(Type.Boolean()),
            full_page: Type.Optional(Type.Boolean()),
            format: Type.Optional(stringEnum(["text", "markdown"])),
            max_characters: Type.Optional(Type.Integer({ minimum: 100, maximum: 100_000 })),
          },
          { additionalProperties: false },
        ),
      ),
      filters: Type.Optional(
        Type.Object(
          {
            include_domains: Type.Optional(Type.Array(Type.String({ maxLength: 253 }), { maxItems: 20 })),
            exclude_domains: Type.Optional(Type.Array(Type.String({ maxLength: 253 }), { maxItems: 20 })),
            safe_search: Type.Optional(stringEnum(["off", "moderate", "strict"])),
          },
          { additionalProperties: false },
        ),
      ),
      synthesis: Type.Optional(
        Type.Object(
          {
            strategy: Type.Optional(stringEnum(["none", "auto", "provider", "internal"])),
            model: Type.Optional(Type.String()),
            max_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 4_000 })),
          },
          { additionalProperties: false },
        ),
      ),
      provider_options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      strict_filters: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 120_000 })),
    },
    { additionalProperties: false },
  );

  type Params = typeof parameters.infer;

  return {
    name: "omniroute_web_search",
    label: "OmniRoute Web Search",
    description:
      "Search the web or news via OmniRoute's configured search providers (Tavily, Brave, Exa, Serper, etc.). Returns ranked results with titles and URLs. Use for current events, fact lookup, and finding sources.",
    parameters,
    async execute(
      _toolCallId: string,
      params: Params,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const query = params.query.trim();
      if (query.length === 0) {
        return {
          content: [{ type: "text", text: "query must be a non-empty string" }],
          details: undefined,
        };
      }

      const configProvider = deps.getConfiguredProvider();
      const effectiveProvider =
        params.provider !== undefined
          ? params.provider
          : isValidProvider(configProvider)
            ? configProvider
            : undefined;

      const apiKey = await resolveApiKey(ctx);
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "OmniRoute API key is not configured. Run /login omniroute or set OMNIROUTE_API_KEY.",
            },
          ],
          details: undefined,
        };
      }

      const res = await omnirouteRequest(
        "/search",
        buildSearchBody({ ...params, query, provider: effectiveProvider }),
        {
          apiKey,
          baseUrl: resolveBaseUrl(ctx),
          signal,
          timeoutMs: params.timeoutMs ?? 30_000,
        },
      );

      if (!res.ok) {
        return {
          content: [{ type: "text", text: res.cancelled ? "Search cancelled." : res.message }],
          details: undefined,
        };
      }
      return {
        content: [{ type: "text", text: formatSearchResults(res.json, query) }],
        details: undefined,
      };
    },
  };
}

export type SearchToolParams = {
  query: string;
  provider?: string;
  max_results?: number;
  search_type?: string;
  offset?: number;
  country?: string;
  language?: string;
  time_range?: string;
  content?: unknown;
  filters?: unknown;
  synthesis?: unknown;
  provider_options?: Record<string, unknown>;
  strict_filters?: boolean;
  timeoutMs?: number;
};

export function buildSearchBody(params: SearchToolParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: params.query,
    max_results: params.max_results ?? 5,
    search_type: params.search_type ?? "web",
    offset: params.offset ?? 0,
    strict_filters: params.strict_filters ?? false,
  };
  const passthrough = [
    "provider",
    "country",
    "language",
    "time_range",
    "content",
    "filters",
    "synthesis",
    "provider_options",
  ] as const;
  for (const key of passthrough) {
    const value = params[key];
    if (value !== undefined) body[key] = value;
  }
  return body;
}
