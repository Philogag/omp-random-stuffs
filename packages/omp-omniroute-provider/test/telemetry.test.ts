// Unit tests for the OmniRoute cost-telemetry pipeline.
//
// All of these exercise plain TypeScript — `src/telemetry/pi-ai.ts` is the only
// file that touches the harness and it is never imported here.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyTelemetryCost,
  applyTelemetryToUsage,
  formatTelemetryReport,
  TelemetryLog,
} from "../src/telemetry/cost.ts";
import {
  createTelemetrySink,
  createTelemetryTransformStream,
  extractOmnirouteTelemetry,
  parseOmnirouteTelemetryLine,
  withOmnirouteFetch,
} from "../src/telemetry/omniroute-telemetry.ts";
import { BUILTIN_OPENAI_API, buildTelemetryStreamSimple } from "../src/telemetry/stream-bridge.ts";

const SSE_BODY = [
  'data: {"choices":[{"delta":{"content":"hi"}}]}',
  "",
  ": x-omniroute-model=gpt-4o-mini",
  ": x-omniroute-provider=openai",
  ": x-omniroute-response-cost=0.0123",
  ": x-omniroute-tokens-in=42",
  ": x-omniroute-tokens-out=7",
  ": x-omniroute-tokens-per-second=18.5",
  ": x-omniroute-ttft-ms=210",
  ": x-omniroute-cache-hit=true",
  "",
  "data: [DONE]",
  "",
].join("\n");

test("parseOmnirouteTelemetryLine recognizes every documented key", () => {
  assert.deepEqual(parseOmnirouteTelemetryLine(": x-omniroute-response-cost=0.5"), { responseCost: 0.5 });
  assert.deepEqual(parseOmnirouteTelemetryLine(": x-omniroute-tokens-in=10"), { tokensIn: 10 });
  assert.deepEqual(parseOmnirouteTelemetryLine(": x-omniroute-tokens-out=20"), { tokensOut: 20 });
  assert.deepEqual(parseOmnirouteTelemetryLine(": x-omniroute-latency-ms=1200"), { latencyMs: 1200 });
  assert.deepEqual(parseOmnirouteTelemetryLine(": x-omniroute-tokens-per-second=33.3"), { tokensPerSecond: 33.3 });
  assert.deepEqual(parseOmnirouteTelemetryLine(": x-omniroute-ttft-ms=180"), { ttftMs: 180 });
  assert.deepEqual(parseOmnirouteTelemetryLine(": x-omniroute-model=x/y"), { model: "x/y" });
  assert.deepEqual(parseOmnirouteTelemetryLine(": x-omniroute-provider=openai"), { provider: "openai" });
  assert.deepEqual(parseOmnirouteTelemetryLine(": x-omniroute-cache-hit=true"), { cacheHit: true });
  assert.deepEqual(parseOmnirouteTelemetryLine(": x-omniroute-cache-hit=false"), { cacheHit: false });
});

test("parseOmnirouteTelemetryLine rejects foreign lines, unknown keys, and junk values", () => {
  assert.equal(parseOmnirouteTelemetryLine('data: {"id":"1"}'), null);
  assert.equal(parseOmnirouteTelemetryLine(": keep-alive"), null);
  // Future gateway field: recognized prefix, unknown key — not our data.
  assert.equal(parseOmnirouteTelemetryLine(": x-omniroute-future-thing=1"), null);
  // Recognized key with an unusable value: empty, not wrong.
  assert.deepEqual(parseOmnirouteTelemetryLine(": x-omniroute-response-cost=abc"), {});
  assert.deepEqual(parseOmnirouteTelemetryLine(": x-omniroute-tokens-per-second=0"), {});
  assert.deepEqual(parseOmnirouteTelemetryLine(": x-omniroute-model="), {});
});

test("extractOmnirouteTelemetry folds a whole body", () => {
  assert.deepEqual(extractOmnirouteTelemetry(SSE_BODY), {
    model: "gpt-4o-mini",
    provider: "openai",
    responseCost: 0.0123,
    tokensIn: 42,
    tokensOut: 7,
    tokensPerSecond: 18.5,
    ttftMs: 210,
    cacheHit: true,
  });
  assert.equal(extractOmnirouteTelemetry("data: [DONE]\n"), undefined);
});

test("applyTelemetryCost sets the total when the catalog has no prices", () => {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  assert.equal(applyTelemetryCost(cost, 0.0123), true);
  assert.deepEqual(cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 });
});

test("applyTelemetryCost scales components so the breakdown matches the total", () => {
  // Modeled: 1 per bucket = 4 total; gateway charged 2 → factor 0.5.
  const cost = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 };
  assert.equal(applyTelemetryCost(cost, 2), true);
  assert.deepEqual(cost, { input: 0.5, output: 0.5, cacheRead: 0.5, cacheWrite: 0.5, total: 2 });
});

test("applyTelemetryCost ignores absent or nonsense charges", () => {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  assert.equal(applyTelemetryCost(cost, Number.NaN), false);
  assert.equal(applyTelemetryCost(cost, -1), false);
  assert.equal(cost.total, 0);
});

test("applyTelemetryToUsage no-ops without a reported cost", () => {
  const usage = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  assert.equal(applyTelemetryToUsage(usage, undefined), false);
  assert.equal(applyTelemetryToUsage(usage, { tokensIn: 5 }), false);
  assert.equal(usage.cost.total, 0);
  assert.equal(applyTelemetryToUsage(usage, { responseCost: 0.25 }), true);
  assert.equal(usage.cost.total, 0.25);
});

test("TelemetryLog is bounded, sums, and renders", () => {
  const log = new TelemetryLog(2);
  log.record(undefined);
  log.record({ responseCost: 0.5, tokensIn: 10, tokensOut: 4 });
  log.record({ responseCost: 0.25, tokensIn: 2, tokensOut: 1, model: "m", cacheHit: true });
  log.record({ responseCost: 0.25, tokensIn: 1, tokensOut: 1, model: "m" });

  assert.equal(log.size, 2, "capacity drops the oldest entries");
  assert.deepEqual(log.totals(), { requests: 2, cost: 0.5, tokensIn: 3, tokensOut: 2 });
  assert.match(formatTelemetryReport(log), /total 0\.5/);
  assert.match(formatTelemetryReport(log), /tok 1\/1/);

  log.clear();
  assert.equal(log.size, 0);
  assert.match(formatTelemetryReport(log), /No OmniRoute telemetry captured yet/);
});

test("withOmnirouteFetch is byte-transparent and fills the sink", async () => {
  const sink = createTelemetrySink();
  const fetchImpl = withOmnirouteFetch(
    async () => new Response(SSE_BODY, { status: 200, headers: { "content-type": "text/event-stream" } }),
    sink,
  );

  const response = await fetchImpl("http://localhost/v1/chat/completions", { method: "POST" });
  const text = await response.text();
  assert.equal(text, SSE_BODY, "consumer sees the original bytes");
  assert.equal(sink.latest()?.responseCost, 0.0123);
  await sink.settle(50);
});

test("withOmnirouteFetch leaves error responses alone", async () => {
  const sink = createTelemetrySink();
  const original = new Response("boom", { status: 500 });
  const fetchImpl = withOmnirouteFetch(async () => original, sink);
  const response = await fetchImpl("http://localhost/v1/chat/completions");
  assert.equal(response, original);
  assert.equal(await response.text(), "boom");
  assert.equal(sink.latest(), undefined);
});

test("createTelemetryTransformStream passes chunks through unchanged", async () => {
  const sink = createTelemetrySink();
  const transform = createTelemetryTransformStream(sink);
  const bytes = new TextEncoder().encode(SSE_BODY);

  const writer = transform.writable.getWriter();
  // Two chunks, splitting a telemetry line across the boundary.
  const cut = Math.floor(bytes.length / 2);
  void writer.write(bytes.slice(0, cut));
  void writer.write(bytes.slice(cut));
  void writer.close();

  const out: Uint8Array[] = [];
  for await (const chunk of transform.readable) out.push(chunk);
  const rejoined = Buffer.concat(out.map((chunk) => Buffer.from(chunk))).toString("utf8");
  assert.equal(rejoined, SSE_BODY);

  const telemetry = sink.latest();
  assert.equal(telemetry?.tokensIn, 42);
  assert.equal(telemetry?.model, "gpt-4o-mini");
});

test("TelemetrySink.settle resolves on drain and times out otherwise", async () => {
  const sink = createTelemetrySink();
  setTimeout(() => sink.markDrained(), 5);
  await sink.settle(200); // resolves via drain
  sink.markDrained(); // idempotent

  const idle = createTelemetrySink();
  const startedAt = Date.now();
  await idle.settle(20); // resolves via timeout, not a hang
  assert.ok(Date.now() - startedAt >= 15);
});

interface FakeEvent {
  type: string;
  message?: { usage: { cost: Record<string, number> } };
}

function fakeEventStream(events: FakeEvent[]) {
  const state = {
    pushed: [] as FakeEvent[],
    ended: false,
    failed: undefined as unknown,
  };
  return {
    state,
    stream: {
      push(event: FakeEvent) {
        state.pushed.push(event);
      },
      end() {
        state.ended = true;
      },
      fail(err: unknown) {
        state.failed = err;
      },
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    },
  };
}

test("buildTelemetryStreamSimple rewrites done cost from the response body", async () => {
  const log = new TelemetryLog();
  const doneCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const done: FakeEvent = { type: "done", message: { usage: { cost: doneCost } } };
  const textEvent: FakeEvent = { type: "text-delta" };

  const out = fakeEventStream([]);
  let dispatchedModel: Record<string, unknown> | undefined;
  let dispatchedFetch: typeof fetch | undefined;

  const streamSimple = buildTelemetryStreamSimple({
    log,
    createStream: () => out.stream,
    dispatch: (model, _context, options) => {
      dispatchedModel = model as Record<string, unknown>;
      dispatchedFetch = (options as { fetch?: typeof fetch }).fetch;
      const target = dispatchedFetch;
      return {
        async *[Symbol.asyncIterator]() {
          yield textEvent;
          // The inner request runs through the injected fetch — that is where
          // the telemetry lines get parsed.
          assert.ok(target);
          const response = await target("http://localhost/v1/chat/completions");
          await response.text();
          yield done;
        },
      } as never;
    },
  });

  const result = streamSimple({ api: "omniroute-openai-completions", id: "m" }, {}, {
    fetch: async () => new Response(SSE_BODY, { status: 200 }),
  });

  assert.equal(result, out.stream);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(dispatchedModel?.api, BUILTIN_OPENAI_API, "inner dispatch uses the real wire api");
  assert.equal(dispatchedModel?.id, "m", "and keeps the rest of the model");
  assert.equal(out.state.pushed.length, 2, "both events are forwarded");
  assert.equal(done.message?.usage.cost.total, 0.0123, "gateway cost wins over the modeled 0");
  assert.equal(out.state.ended, true);
  assert.equal(log.size, 1);
  assert.equal(log.totals().tokensIn, 42);
});

test("buildTelemetryStreamSimple surfaces dispatch failures", async () => {
  const out = fakeEventStream([]);
  const streamSimple = buildTelemetryStreamSimple({
    log: new TelemetryLog(),
    createStream: () => out.stream,
    dispatch: () => {
      throw new Error("boom");
    },
  });

  streamSimple({ api: "omniroute-openai-completions" }, {});
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(out.state.failed instanceof Error, true);
  assert.equal(out.state.ended, true);
});
