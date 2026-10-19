// `/login-omniroute` — guided first-run setup.
//
// Three steps: point the extension at a gateway, check that the gateway answers,
// then store an API key through omp's own credential pipeline (the same store
// `/login` writes to). Everything is dependency-injected so the flow is testable
// without a harness runtime.

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { OMNIROUTE_API_KEY_ENV } from "./provider.ts";

export interface GatewayProbe {
  readonly ok: boolean;
  readonly status?: number;
  readonly modelCount?: number;
  readonly error?: string;
}

export const AUTH_PASTE = "Paste API key now (stored by omp)";
export const AUTH_ENV = "I'll export OMNIROUTE_API_KEY myself";
export const AUTH_SKIP = "Skip for now";

const PROBE_TIMEOUT_MS = 8_000;

export interface LoginWizardDeps {
  readonly getBaseUrl: () => string;
  /** Persists `undefined` as "use the default"; rejects on an invalid URL. */
  readonly setBaseUrl: (value: string | undefined) => Promise<void>;
  readonly getApiKey: () => Promise<string | undefined>;
  readonly probe: (baseUrl: string, apiKey: string | undefined) => Promise<GatewayProbe>;
  /** Runs omp's OAuth/API-key login for this provider; resolves to a source label. */
  readonly login: () => Promise<string | undefined>;
  readonly refreshModels: () => Promise<void>;
  readonly configPath: () => string;
  readonly defaultBaseUrl: string;
  readonly validateBaseUrl: (input: string) => string;
}

export interface LoginWizardResult {
  readonly cancelled: boolean;
  readonly baseUrl: string;
  readonly authenticated: boolean;
  readonly modelCount?: number;
}

/** `GET /models` with the status preserved, so 401 vs unreachable stay distinct. */
export async function probeGateway(
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<GatewayProbe> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetch(url, {
      method: "GET",
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: true, status: res.status, modelCount: 0 };
    }
    const data = (body as { data?: unknown })?.data;
    const modelCount = Array.isArray(data) ? data.length : 0;
    return { ok: true, status: res.status, modelCount };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runLoginWizard(
  ctx: ExtensionContext,
  deps: LoginWizardDeps,
): Promise<LoginWizardResult> {
  const ui = ctx.ui;
  const start = deps.getBaseUrl();

  ui.notify(
    [
      "OmniRoute setup",
      `current base URL: ${start}`,
      `config file: ${deps.configPath()}`,
    ].join("\n"),
    "info",
  );

  // 1. Base URL -----------------------------------------------------------
  const entered = await ui.input("OmniRoute base URL (blank = default)", start);
  if (entered === undefined) return { cancelled: true, baseUrl: start, authenticated: false };

  let nextBaseUrl: string;
  try {
    nextBaseUrl = deps.validateBaseUrl(entered);
  } catch (err) {
    ui.notify(err instanceof Error ? err.message : String(err), "error");
    return { cancelled: false, baseUrl: start, authenticated: false };
  }
  const changed = nextBaseUrl !== start;
  if (changed) {
    try {
      await deps.setBaseUrl(nextBaseUrl === deps.defaultBaseUrl ? undefined : nextBaseUrl);
    } catch (err) {
      ui.notify(`Could not save the base URL: ${err instanceof Error ? err.message : String(err)}`, "error");
      return { cancelled: false, baseUrl: start, authenticated: false };
    }
  }

  // 2. Reachability ------------------------------------------------------
  const existingKey = await deps.getApiKey();
  const probe = await deps.probe(nextBaseUrl, existingKey);
  let keyKnown = existingKey !== undefined;

  if (probe.ok) {
    ui.notify(`Gateway reachable — ${probe.modelCount ?? 0} models advertised`, "info");
  } else if (probe.status === 401 || probe.status === 403) {
    ui.notify("Gateway is up but rejected the request: an API key is required", "warning");
  } else {
    ui.notify(
      `Could not reach ${nextBaseUrl}: ${probe.error ?? "unknown error"} — the URL was saved, fix it in /omniroute-settings`,
      "warning",
    );
  }

  // 3. Credentials -------------------------------------------------------
  if (keyKnown) {
    ui.notify("API key already configured (omp auth store or OMNIROUTE_API_KEY)", "info");
  } else {
    const choice = await ui.select("OmniRoute API key", [
      { label: AUTH_PASTE, description: "Opens the dashboard URL, then asks for the key and stores it" },
      { label: AUTH_ENV, description: `Export ${OMNIROUTE_API_KEY_ENV} in your shell profile and restart omp` },
      { label: AUTH_SKIP, description: "Configure it later with /login omniroute" },
    ]);
    if (choice === AUTH_PASTE) {
      try {
        const source = await deps.login();
        keyKnown = source !== undefined;
        ui.notify(
          keyKnown ? `API key stored (${source})` : "Login finished without storing a credential",
          keyKnown ? "info" : "warning",
        );
      } catch (err) {
        ui.notify(`Login failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    } else if (choice === AUTH_ENV) {
      ui.notify(`Set ${OMNIROUTE_API_KEY_ENV} in your environment, then restart omp`, "info");
    }
  }

  // 4. Catalog -----------------------------------------------------------
  try {
    await deps.refreshModels();
  } catch (err) {
    ui.notify(`Model refresh failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
  }
  const after = await deps.probe(nextBaseUrl, keyKnown ? await deps.getApiKey() : undefined);
  if (after.ok) {
    ui.notify(
      [
        "OmniRoute is ready",
        `${after.modelCount ?? 0} models available — pick one from the model selector`,
        "Tune web search / web fetch providers with /omniroute-settings",
      ].join("\n"),
      "info",
    );
  }

  return {
    cancelled: false,
    baseUrl: nextBaseUrl,
    authenticated: keyKnown,
    ...(after.modelCount !== undefined ? { modelCount: after.modelCount } : {}),
  };
}
