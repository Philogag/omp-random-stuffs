// Turns OmniRoute's out-of-band telemetry into omp's billable numbers, plus a
// small in-memory log for `/omniroute-usage`.
//
// omp computes cost from the static per-million token prices on the model, so
// a gateway that bills per request (and applies its own discounts) is invisible
// to the session ledger. The one supported way to correct that is to overwrite
// `usage.cost` on the finished assistant message: the session layer adds those
// numbers verbatim and nothing recomputes them afterwards.
//
// Structural types only — this module must stay importable from plain Node.

import type { OmnirouteTelemetry } from "./omniroute-telemetry.ts";

export interface UsageCostLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageLike {
  cost: UsageCostLike;
}

const COST_SCALE = 1_000_000;

function round6(value: number): number {
  return Math.round(value * COST_SCALE) / COST_SCALE;
}

/**
 * Replaces a modeled cost with the gateway's actual charge.
 *
 * When the model carried real prices the components are scaled by the same
 * factor, so the per-bucket breakdown stays proportional instead of showing a
 * per-token total that disagrees with its own parts. With a zero-price catalog
 * (OmniRoute's case) only the total is meaningful and the components stay 0.
 */
export function applyTelemetryCost(cost: UsageCostLike, gatewayTotal: number): boolean {
  if (!Number.isFinite(gatewayTotal) || gatewayTotal < 0) return false;

  const modeled = cost.total;
  if (Number.isFinite(modeled) && modeled > 0 && gatewayTotal > 0) {
    const factor = gatewayTotal / modeled;
    cost.input = round6(cost.input * factor);
    cost.output = round6(cost.output * factor);
    cost.cacheRead = round6(cost.cacheRead * factor);
    cost.cacheWrite = round6(cost.cacheWrite * factor);
  }
  cost.total = round6(gatewayTotal);
  return true;
}

/** Applies whatever cost telemetry reported. Returns true when cost changed. */
export function applyTelemetryToUsage(usage: UsageLike, telemetry: OmnirouteTelemetry | undefined): boolean {
  if (!telemetry) return false;
  if (telemetry.responseCost === undefined) return false;
  return applyTelemetryCost(usage.cost, telemetry.responseCost);
}

export interface TelemetryLogEntry {
  readonly at: number;
  readonly telemetry: OmnirouteTelemetry;
}

const DEFAULT_CAPACITY = 200;

/** Bounded in-memory log; omp has no per-message diagnostics field to attach to. */
export class TelemetryLog {
  readonly #capacity: number;
  #entries: TelemetryLogEntry[] = [];

  constructor(capacity = DEFAULT_CAPACITY) {
    this.#capacity = Math.max(1, capacity);
  }

  record(telemetry: OmnirouteTelemetry | undefined): void {
    if (!telemetry || Object.keys(telemetry).length === 0) return;
    this.#entries.push({ at: Date.now(), telemetry });
    if (this.#entries.length > this.#capacity) {
      this.#entries.splice(0, this.#entries.length - this.#capacity);
    }
  }

  recent(limit = 10): TelemetryLogEntry[] {
    return this.#entries.slice(-Math.max(1, limit));
  }

  clear(): void {
    this.#entries = [];
  }

  get size(): number {
    return this.#entries.length;
  }

  totals(): { requests: number; cost: number; tokensIn: number; tokensOut: number } {
    let cost = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const { telemetry } of this.#entries) {
      cost += telemetry.responseCost ?? 0;
      tokensIn += telemetry.tokensIn ?? 0;
      tokensOut += telemetry.tokensOut ?? 0;
    }
    return { requests: this.#entries.length, cost: round6(cost), tokensIn, tokensOut };
  }
}

/** Shared in-memory log behind both the stream bridge and `/omniroute-usage`. */
export const telemetryLog = new TelemetryLog();

const MISSING = "—";

function num(value: number | undefined, digits = 0): string {
  if (value === undefined) return MISSING;
  return digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
}

function clockTime(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Renders `/omniroute-usage`. Plain text: omp's `ui.notify` shows text, not a
 * TUI component, so the table has to survive a monospace popup.
 */
export function formatTelemetryReport(log: TelemetryLog, limit = 10): string {
  if (log.size === 0) {
    return "No OmniRoute telemetry captured yet.\nSend a message first — the gateway reports cost at the end of each response.";
  }

  const totals = log.totals();
  const lines: string[] = [
    `OmniRoute usage · last ${totals.requests} response${totals.requests === 1 ? "" : "s"}`,
    `total ${num(totals.cost, 6)}  in ${num(totals.tokensIn)}  out ${num(totals.tokensOut)}`,
    "",
  ];

  for (const { at, telemetry } of log.recent(limit)) {
    const parts = [clockTime(at), telemetry.model ?? telemetry.provider ?? "?"];
    parts.push(`cost ${num(telemetry.responseCost, 6)}`);
    parts.push(`tok ${num(telemetry.tokensIn)}/${num(telemetry.tokensOut)}`);
    if (telemetry.tokensPerSecond !== undefined) parts.push(`${num(telemetry.tokensPerSecond, 1)} tok/s`);
    if (telemetry.ttftMs !== undefined) parts.push(`ttft ${num(telemetry.ttftMs)}ms`);
    if (telemetry.cacheHit !== undefined) parts.push(telemetry.cacheHit ? "cache hit" : "no cache");
    lines.push(parts.join(" · "));
  }

  return lines.join("\n");
}
