// `omniroute_web_fetch` — omp tool definition.
//
// Same two structural changes as search.ts: schema from `pi.typebox`, and the
// configured-provider default is resolved inside `execute` because omp's
// ToolDefinition has no `prepareArguments` hook.

import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { omnirouteRequest, resolveApiKey, resolveBaseUrl } from "./http.ts";

export const FETCH_PROVIDERS = ["firecrawl", "jina-reader", "tavily-search", "tinyfish"] as const;
export const FETCH_FORMATS = ["markdown", "html", "links", "screenshot"] as const;

export type FetchProvider = (typeof FETCH_PROVIDERS)[number];
export type FetchFormat = (typeof FETCH_FORMATS)[number];

export interface FetchToolParams {
  url: string;
  provider?: FetchProvider;
  format?: FetchFormat;
  depth?: 0 | 1 | 2;
  wait_for_selector?: string;
  include_metadata?: boolean;
  timeoutMs?: number;
}

export function isFetchFormat(value: string | undefined): value is FetchFormat {
  return typeof value === "string" && (FETCH_FORMATS as readonly string[]).includes(value);
}

export function isFetchProvider(value: string | undefined): value is FetchProvider {
  return typeof value === "string" && (FETCH_PROVIDERS as readonly string[]).includes(value);
}

export function normalizeFetchProvider(raw: string | undefined): FetchProvider | undefined {
  if (raw === undefined) return undefined;
  if (raw === "auto") return undefined;
  return isFetchProvider(raw) ? raw : undefined;
}

export function buildFetchBody(params: FetchToolParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    url: params.url,
    format: params.format ?? "markdown",
    depth: params.depth ?? 0,
    include_metadata: params.include_metadata ?? false,
  };
  if (params.provider !== undefined) body.provider = params.provider;
  if (params.wait_for_selector !== undefined) body.wait_for_selector = params.wait_for_selector;
  return body;
}

const FETCH_CONTENT_LIMIT = 40_000;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function extractFetchContent(json: unknown): string {
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    const content = obj.content;
    if (typeof content === "string") return truncate(content);
    if (content && typeof content === "object") {
      const inner = content as Record<string, unknown>;
      const innerText = asString(inner.markdown) ?? asString(inner.text);
      if (innerText !== undefined) return truncate(innerText);
    }
    for (const key of ["markdown", "html", "text"] as const) {
      const value = asString(obj[key]);
      if (value !== undefined) return truncate(value);
    }
  }
  return JSON.stringify(json).slice(0, FETCH_CONTENT_LIMIT);
}

function truncate(text: string): string {
  if (text.length <= FETCH_CONTENT_LIMIT) return text;
  return `${text.slice(0, FETCH_CONTENT_LIMIT)}\n\n[content truncated at ${FETCH_CONTENT_LIMIT} chars]`;
}

export interface FetchToolDeps {
  pi: ExtensionAPI;
  /** Configured default provider, read at call time so settings edits apply live. */
  getConfiguredProvider: () => string | undefined;
}

export function createFetchTool(deps: FetchToolDeps): ToolDefinition {
  const { Type } = deps.pi.typebox;

  const stringEnum = (values: readonly string[]) =>
    Type.Union(values.map((value) => Type.Literal(value)));

  const parameters = Type.Object(
    {
      url: Type.String(),
      provider: Type.Optional(stringEnum(FETCH_PROVIDERS)),
      format: Type.Optional(stringEnum(FETCH_FORMATS)),
      depth: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)])),
      wait_for_selector: Type.Optional(Type.String({ maxLength: 256 })),
      include_metadata: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 120_000 })),
    },
    { additionalProperties: false },
  );

  type Params = typeof parameters.infer;

  return {
    name: "omniroute_web_fetch",
    label: "OmniRoute Web Fetch",
    description:
      "Fetch and extract content from a URL via OmniRoute's configured web-fetch providers (Firecrawl, Jina Reader, Tavily Extract, TinyFish). Returns the page content as markdown by default.",
    parameters,
    async execute(
      _toolCallId: string,
      params: Params,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(params.url);
      } catch {
        return {
          content: [{ type: "text", text: "url must be a valid http(s) URL" }],
          details: undefined,
        };
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return {
          content: [{ type: "text", text: "url must be an http(s) URL" }],
          details: undefined,
        };
      }

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

      // Explicit param > configured default > omitted, re-gated at call time so a
      // stale config value ("auto"/unknown) cannot reach OmniRoute as a provider.
      const effectiveProvider = isFetchProvider(params.provider)
        ? params.provider
        : normalizeFetchProvider(deps.getConfiguredProvider());

      const res = await omnirouteRequest(
        "/web/fetch",
        buildFetchBody({
          url: params.url,
          provider: effectiveProvider,
          // Schema inference widens these to `string`; re-narrow before handing
          // them to the typed body builder.
          format: isFetchFormat(params.format) ? params.format : undefined,
          depth: params.depth === 0 || params.depth === 1 || params.depth === 2 ? params.depth : undefined,
          wait_for_selector: params.wait_for_selector,
          include_metadata: params.include_metadata,
        }),
        {
          apiKey,
          baseUrl: resolveBaseUrl(ctx),
          signal,
          timeoutMs: params.timeoutMs ?? 30_000,
        },
      );

      if (!res.ok) {
        return {
          content: [{ type: "text", text: res.cancelled ? "Fetch cancelled." : res.message }],
          details: undefined,
        };
      }
      return {
        content: [{ type: "text", text: extractFetchContent(res.json) }],
        details: undefined,
      };
    },
  };
}
