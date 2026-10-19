// OmniRoute provider identity + catalog mapping.
//
// In omp a provider is registered as `registerProvider(name, ProviderConfig)`
// and the model catalog is an async `fetchDynamicModels` factory that omp
// caches in its own model store (24h TTL). That replaces the pi-era
// `getModels` / `refreshModels` / publish+store plumbing entirely.

import type { ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

export const PROVIDER_ID = "omniroute";
export const PROVIDER_NAME = "OmniRoute";
export const PROVIDER_API = "openai-completions";

/** Env var name — omp resolves `apiKey` below stored /login credentials. */
export const OMNIROUTE_API_KEY_ENV = "OMNIROUTE_API_KEY";

/** omp seeds a model's fallback limits from these when discovery omits them. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 4_096;
const MODELS_TIMEOUT_MS = 15_000;

/**
 * Thinking capability advertised for models whose catalog row reports
 * `capabilities.thinking`.
 *
 * `Effort` is a string `const enum` in `@oh-my-pi/pi-catalog`, so its members
 * cannot be referenced under `isolatedModules`; the cast records the same
 * runtime values ("minimal" | "low" | "medium" | "high").
 */
const OMNIROUTE_THINKING = {
  mode: "effort",
  efforts: ["minimal", "low", "medium", "high"],
} as unknown as NonNullable<ProviderModelConfig["thinking"]>;

/** Shape returned by OmniRoute's `GET /models` (OpenAI-compatible + extras). */
export interface OmnirouteModelEntry {
  id: string;
  name?: string;
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  capabilities?: {
    tool_calling?: boolean;
    reasoning?: boolean;
    thinking?: boolean;
    temperature?: boolean;
    vision?: boolean;
  };
  input_modalities?: string[];
}

function pickInt(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

export function toProviderModel(entry: OmnirouteModelEntry): ProviderModelConfig {
  const capabilities = entry.capabilities;
  const vision =
    capabilities?.vision === true ||
    (Array.isArray(entry.input_modalities) && entry.input_modalities.includes("image"));

  return {
    id: entry.id,
    name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
    api: PROVIDER_API,
    reasoning: capabilities?.reasoning === true,
    // `thinking` is omp's effort surface. OmniRoute reports whether a model
    // accepts a reasoning knob but not which efforts it honors, so advertise
    // the OpenAI-compatible ladder and let the gateway clamp.
    thinking:
      capabilities?.thinking === true
        ? OMNIROUTE_THINKING
        : undefined,
    input: vision ? ["text", "image"] : ["text"],
    // OmniRoute bills per request and reports the actual amount out-of-band;
    // per-token prices are not exposed by its catalog.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: pickInt(entry.max_input_tokens, entry.context_length) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: pickInt(entry.max_output_tokens) ?? DEFAULT_MAX_TOKENS,
  };
}

/**
 * Discovery factory handed to `ProviderConfig.fetchDynamicModels`. omp passes
 * the already-resolved API key (undefined when unauthenticated); throwing here
 * keeps omp's cached catalog in place, so a transient gateway outage does not
 * empty the model list.
 */
export async function fetchOmnirouteModels(
  baseUrl: string,
  apiKey: string | undefined,
): Promise<readonly ProviderModelConfig[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
  });
  if (!res.ok) throw new Error(`OmniRoute /models failed: ${res.status}`);

  const body = (await res.json()) as { data?: unknown };
  const rows = Array.isArray(body.data) ? (body.data as OmnirouteModelEntry[]) : [];
  const models: ProviderModelConfig[] = [];
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || row.id.length === 0) continue;
    models.push(toProviderModel(row));
  }
  return models;
}

export function createProviderConfig(resolveCurrentBaseUrl: () => string): ProviderConfig {
  return {
    // Live getter rather than the value at registration time, so a base-URL edit
    // from `/omniroute-settings` applies to the next request without the provider
    // having to be re-registered.
    get baseUrl() {
      return resolveCurrentBaseUrl();
    },
    api: PROVIDER_API,
    // Registered as a fallback rank below stored OAuth / `/login` keys, so an
    // interactive login wins over an exported env var.
    apiKey: OMNIROUTE_API_KEY_ENV,
    oauth: {
      name: PROVIDER_NAME,
      async login(callbacks) {
        callbacks.onAuth({
          url: dashboardUrl(resolveCurrentBaseUrl()),
          instructions: "Create an API key in the OmniRoute dashboard, then paste it here.",
        });
        const key = (await callbacks.onPrompt({ message: "OmniRoute API key", secret: true })).trim();
        if (key.length === 0) throw new Error("No OmniRoute API key provided");
        return key;
      },
    },
    // Reads the live base URL so a settings change applies without re-registering.
    fetchDynamicModels: (apiKey) => fetchOmnirouteModels(resolveCurrentBaseUrl(), apiKey),
  };
}

function dashboardUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}
