// Extension-owned config store for the OmniRoute provider.
//
// The pi build persisted its settings in pi's `settings.json` under a
// `pi-provider-omniroute` block and migrated two legacy pi sources
// (`omniroute.json` + the `auth.json` credential env). omp records auth in its
// own store, so this port keeps a single extension-owned file in omp's agent
// dir instead of writing into the harness's settings document.
//
// No harness import here on purpose: `index.ts` injects the agent-dir resolver
// (`pi.pi.getAgentDir`), which keeps this module pure Node and unit-testable.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const OMNIROUTE_DEFAULT_BASE_URL = "http://localhost:20128/v1";
export const OMNIROUTE_CONFIG_FILE = "omniroute.json";
export const OMNIROUTE_ENV_BASE_URL = "OMNIROUTE_BASE_URL";

export interface OmnirouteConfig {
  baseUrl?: string;
  search?: { provider?: string };
  fetch?: { provider?: string };
}

type AgentDirResolver = () => string;

let agentDirOverride: AgentDirResolver | undefined;

/** Injected by the extension factory so profile-aware agent dirs are honored. */
export function setAgentDirResolver(resolve: AgentDirResolver | undefined): void {
  agentDirOverride = resolve;
}

export function resolveAgentDir(): string {
  if (agentDirOverride) return agentDirOverride();
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv) return fromEnv;
  return join(homedir(), ".omp", "agent");
}

export function resolveConfigPath(): string {
  return join(resolveAgentDir(), OMNIROUTE_CONFIG_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickProvider(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readConfig(path: string = resolveConfigPath()): OmnirouteConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[omniroute] cannot read ${path}: ${(err as Error).message}`);
    }
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[omniroute] ${path} is not valid JSON: ${(err as Error).message}`);
    return {};
  }
  if (!isRecord(parsed)) return {};
  const config: OmnirouteConfig = {};
  const baseUrl = pickProvider(parsed.baseUrl);
  if (baseUrl) config.baseUrl = baseUrl;
  const search = isRecord(parsed.search) ? pickProvider(parsed.search.provider) : undefined;
  if (search) config.search = { provider: search };
  const fetch = isRecord(parsed.fetch) ? pickProvider(parsed.fetch.provider) : undefined;
  if (fetch) config.fetch = { provider: fetch };
  return config;
}

/** Atomic write (tmp + rename) so a crash never leaves a truncated config. */
export function writeConfig(config: OmnirouteConfig, path: string = resolveConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function update(
  mutate: (config: OmnirouteConfig) => void,
  path: string = resolveConfigPath(),
): OmnirouteConfig {
  const config = readConfig(path);
  mutate(config);
  writeConfig(config, path);
  return config;
}

export function setBaseUrl(baseUrl: string | undefined, path?: string): OmnirouteConfig {
  return update((config) => {
    if (baseUrl) config.baseUrl = baseUrl;
    else delete config.baseUrl;
  }, path);
}

export function setSearchProvider(provider: string | undefined, path?: string): OmnirouteConfig {
  return update((config) => {
    if (provider) config.search = { provider };
    else delete config.search;
  }, path);
}

export function setFetchProvider(provider: string | undefined, path?: string): OmnirouteConfig {
  return update((config) => {
    if (provider) config.fetch = { provider };
    else delete config.fetch;
  }, path);
}

/** config file → `OMNIROUTE_BASE_URL` → default. */
export function resolveBaseUrl(path?: string): string {
  const configured = readConfig(path).baseUrl;
  if (configured) return configured;
  const fromEnv = process.env[OMNIROUTE_ENV_BASE_URL];
  if (fromEnv) return fromEnv;
  return OMNIROUTE_DEFAULT_BASE_URL;
}

export function validateAndNormalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return OMNIROUTE_DEFAULT_BASE_URL;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid base URL: ${JSON.stringify(input)}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`base URL must use http(s): got ${url.protocol}`);
  }
  if (!url.hostname) {
    throw new Error(`base URL missing hostname: ${JSON.stringify(input)}`);
  }
  if (!/\/v1\/?$/.test(url.pathname)) {
    console.warn(`[omniroute] base URL ${JSON.stringify(trimmed)} does not end with /v1 — chat calls may 404`);
  }

  // Every request builder already strips trailing slashes; normalize here too so
  // "changed the URL" comparisons and saved config entries stay canonical.
  return trimmed.replace(/\/+$/, "");
}
