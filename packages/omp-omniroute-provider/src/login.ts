// `/login-omniroute` — setup: edit the gateway URL (prefilled), ask for the API
// key, store it, verify.
//
// Two prompts, not a wizard. The URL prompt is prefilled with the live value so
// an already configured gateway can be corrected in place; `/omniroute-settings`
// still owns the search/fetch provider menus. Everything is dependency-injected
// so the flow is testable without a harness runtime.

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export interface GatewayProbe {
  readonly ok: boolean;
  readonly status?: number;
  readonly modelCount?: number;
  readonly error?: string;
}

const PROBE_TIMEOUT_MS = 8_000;

export interface LoginWizardDeps {
  readonly getBaseUrl: () => string;
  /** Validates/normalizes an edited URL; throws on malformed input. */
  readonly normalizeBaseUrl: (value: string) => string;
  /** Persists the normalized URL and re-registers the provider. */
  readonly saveBaseUrl: (value: string) => void;
  readonly getApiKey: () => Promise<string | undefined>;
  readonly probe: (baseUrl: string, apiKey: string | undefined) => Promise<GatewayProbe>;
  /**
   * Runs omp's API-key login for this provider, replacing any stored key;
   * resolves to a source label.
   */
  readonly login: () => Promise<string | undefined>;
  readonly refreshModels: () => Promise<void>;
}

export interface LoginWizardResult {
  /** The user abandoned the key prompt without storing anything. */
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

/**
 * Asks for the gateway URL (prefilled with the live value), then for the key,
 * and reports whether the gateway accepted it.
 *
 * The URL prompt always runs, so an already configured base URL can be edited
 * here instead of detouring through `/omniroute-settings`. Both prompts belong
 * to omp (`ui.editor`, `authStorage.oauth.login`), so the key goes straight
 * into the credential store `/login` uses and this extension never persists a
 * secret. The key prompt always runs too, so an existing key can be replaced.
 */
export async function runLoginWizard(
  ctx: ExtensionContext,
  deps: LoginWizardDeps,
): Promise<LoginWizardResult> {
  const ui = ctx.ui;
  let baseUrl = deps.getBaseUrl();

  // `ui.input` only renders a placeholder, so the edit uses the prefilled
  // editor in prompt style: Enter submits, Esc cancels the whole login.
  let draft = baseUrl;
  for (;;) {
    const entered = await ui.editor("OmniRoute base URL", draft, undefined, { promptStyle: true });
    if (entered === undefined) return { cancelled: true, baseUrl, authenticated: false };
    let normalized: string;
    try {
      normalized = deps.normalizeBaseUrl(entered);
    } catch (err) {
      ui.notify(err instanceof Error ? err.message : String(err), "error");
      draft = entered;
      continue;
    }
    if (normalized !== baseUrl) {
      baseUrl = normalized;
      deps.saveBaseUrl(normalized);
    }
    break;
  }

  let authenticated = false;
  let cancelled = false;

  try {
    const source = await deps.login();
    if (source === undefined) {
      cancelled = true;
    } else {
      // Trust the store, not the login's return value: omp may resolve the
      // key through its own serializer (env fallback, refresh, ...).
      authenticated = (await deps.getApiKey()) !== undefined;
      ui.notify(
        authenticated ? `OmniRoute API key stored (${source})` : "Login finished without storing a key",
        authenticated ? "info" : "warning",
      );
    }
  } catch (err) {
    cancelled = true;
    ui.notify(`Login failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }

  if (!authenticated) {
    return { cancelled, baseUrl, authenticated: false };
  }

  const probe = await deps.probe(baseUrl, await deps.getApiKey());
  if (!probe.ok) {
    const detail =
      probe.status === 401 || probe.status === 403
        ? "the gateway rejected the key"
        : (probe.error ?? "unknown error");
    ui.notify(
      [
        `Key stored, but ${baseUrl} did not accept it: ${detail}`,
        "Check the base URL with /omniroute-settings, or re-run /login-omniroute to replace the key.",
      ].join("\n"),
      "warning",
    );
    return { cancelled: false, baseUrl, authenticated: true, ...(probe.modelCount !== undefined ? { modelCount: probe.modelCount } : {}) };
  }

  try {
    await deps.refreshModels();
  } catch (err) {
    ui.notify(`Model refresh failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
  }

  ui.notify(
    [
      `OmniRoute is ready — ${probe.modelCount ?? 0} models available`,
      "Pick one from the model selector; tune web search / web fetch with /omniroute-settings",
    ].join("\n"),
    "info",
  );

  return {
    cancelled: false,
    baseUrl,
    authenticated: true,
    ...(probe.modelCount !== undefined ? { modelCount: probe.modelCount } : {}),
  };
}
