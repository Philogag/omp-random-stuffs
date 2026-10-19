// Shared HTTP layer for the OmniRoute tools.

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveBaseUrl as resolveConfiguredBaseUrl } from "../config.ts";
import { PROVIDER_ID } from "../provider.ts";

/** Prefer the model's own base URL (per-session override), else the extension config. */
export function resolveBaseUrl(ctx: ExtensionContext): string {
  if (ctx.model?.provider === PROVIDER_ID && ctx.model.baseUrl) return ctx.model.baseUrl;
  return resolveConfiguredBaseUrl();
}

/** Resolves through omp's auth store: `/login`, stored keys, then the env fallback. */
export async function resolveApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  return ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
}

export type OmnirouteResult =
  | { ok: true; text: string; json?: unknown }
  | { ok: false; status: number; message: string; cancelled?: boolean };

export interface OmnirouteRequestOptions {
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
  timeoutMs: number;
}

export async function omnirouteRequest(
  path: string,
  body: unknown,
  opts: OmnirouteRequestOptions,
): Promise<OmnirouteResult> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}${path}`;
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    if (res.ok) {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        // Non-JSON body (e.g. a screenshot) — leave json unset, callers use text.
      }
      return { ok: true, text, json };
    }
    let message = `OmniRoute ${path} failed: ${res.status}`;
    try {
      const err = JSON.parse(text) as { error?: unknown; message?: unknown; detail?: unknown };
      const detail =
        typeof err.error === "string"
          ? err.error
          : typeof err.message === "string"
            ? err.message
            : typeof err.detail === "string"
              ? err.detail
              : undefined;
      if (detail) message += ` (${detail})`;
    } catch {
      // Non-JSON error body — the status code is all we have.
    }
    return { ok: false, status: res.status, message };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (opts.signal?.aborted) {
        return { ok: false, status: 0, message: "cancelled", cancelled: true };
      }
      return {
        ok: false,
        status: 0,
        message: `OmniRoute ${path} timed out after ${opts.timeoutMs}ms`,
      };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, message: `Cannot reach OmniRoute at ${opts.baseUrl}: ${reason}` };
  }
}
