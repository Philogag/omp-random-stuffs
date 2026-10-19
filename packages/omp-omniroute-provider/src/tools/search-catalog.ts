// Live search-provider catalog for the settings menu.
//
// OmniRoute exposes `GET /search` → `{ data: [{ id, name, search_types }] }`
// listing the providers it actually has configured. The settings menu prefers
// that list and falls back to the static id list when the gateway is
// unreachable or unauthenticated (e.g. before `/login`).

import { SEARCH_PROVIDERS } from "./search.ts";

export interface SearchProviderEntry {
  readonly id: string;
  readonly name: string;
  readonly search_types: readonly string[];
}

export interface SearchCatalog {
  readonly providers: readonly SearchProviderEntry[];
  readonly isFallback: boolean;
}

export class SearchCatalogError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SearchCatalogError";
    this.cause = cause;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

function isSearchProviderEntry(value: unknown): value is SearchProviderEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    Array.isArray(entry.search_types) &&
    entry.search_types.every((type) => typeof type === "string")
  );
}

export function staticSearchCatalog(): SearchCatalog {
  return {
    providers: SEARCH_PROVIDERS.map((id) => ({ id, name: id, search_types: ["web"] as const })),
    isFallback: true,
  };
}

export async function fetchSearchProviders(
  baseUrl: string,
  apiKey: string | undefined,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SearchProviderEntry[]> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const url = `${baseUrl.replace(/\/+$/, "")}/search`;

  try {
    const res = await fetch(url, {
      method: "GET",
      // Auth is optional on purpose: the menu must open before `/login` so a
      // first-time user can point the extension at their gateway first.
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      signal,
    });
    if (!res.ok) throw new SearchCatalogError(`GET /search returned ${res.status}`);

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new SearchCatalogError("response body is not valid JSON", err);
    }
    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data)) {
      throw new SearchCatalogError("response body missing or invalid `data` array");
    }
    if (data.length === 0) throw new SearchCatalogError("response body `data` is empty");
    for (const item of data) {
      if (!isSearchProviderEntry(item)) {
        throw new SearchCatalogError("response body `data` contains malformed provider entry");
      }
    }
    return data;
  } catch (err) {
    if (err instanceof SearchCatalogError) throw err;
    throw new SearchCatalogError(err instanceof Error ? err.message : "fetch failed", err);
  }
}

/** Never throws: any failure degrades to the static id list. */
export async function resolveSearchCatalog(
  baseUrl: string,
  apiKey: string | undefined,
  options: { signal?: AbortSignal; timeoutMs?: number; onError?: (err: unknown) => void } = {},
): Promise<SearchCatalog> {
  try {
    const providers = await fetchSearchProviders(baseUrl, apiKey, options);
    return { providers, isFallback: false };
  } catch (err) {
    options.onError?.(err);
    return staticSearchCatalog();
  }
}

/**
 * Display description for a catalog row. The select dialog returns the option
 * *label*, so labels stay equal to provider ids and the human name goes here.
 */
export function searchProviderDescription(provider: SearchProviderEntry): string {
  const types = provider.search_types.length > 0 ? provider.search_types.join(", ") : "web";
  return provider.name && provider.name !== provider.id
    ? `${provider.name} · ${types}`
    : `search types: ${types}`;
}
