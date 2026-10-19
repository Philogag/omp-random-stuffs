// Real-harness integration probe (run under Bun, from the package dir):
//   bun test/integration/stream-probe.ts
//
// Starts a fake OmniRoute gateway that emits the X-OmniRoute-* SSE comments,
// then drives the *real* `@oh-my-pi/pi-ai` dispatch through our custom api to
// prove the gateway cost lands on the finished message.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { omnirouteStreamSimple } from "../../src/telemetry/pi-ai.ts";

const TELEMETRY_COST = 0.0123;

const server = createServer((req, res) => {
  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  if (req.url?.endsWith("/chat/completions")) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-probe",
          object: "chat.completion.chunk",
          created: 1,
          model: "fake-1",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }));
      res.write(chunk({ content: "hello from the fake gateway" }));
      res.write(chunk({}, "stop"));
      // OmniRoute's out-of-band block: SSE comments, ignored by SSE parsers.
      res.write(`: x-omniroute-model=fake-1\n`);
      res.write(`: x-omniroute-provider=fake\n`);
      res.write(`: x-omniroute-response-cost=${TELEMETRY_COST}\n`);
      res.write(`: x-omniroute-tokens-in=42\n`);
      res.write(`: x-omniroute-tokens-out=7\n`);
      res.end("data: [DONE]\n\n");
    });
    return;
  }
  res.writeHead(404).end();
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

const model = {
  id: "fake-1",
  name: "Fake 1",
  api: "omniroute-openai-completions",
  provider: "omniroute",
  baseUrl: `http://127.0.0.1:${port}/v1`,
  input: ["text"],
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

const context = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

const stream = omnirouteStreamSimple(model as never, context as never, {
  apiKey: "probe-key",
} as never);

const events: string[] = [];
for await (const event of stream as AsyncIterable<{ type: string; message?: AssistantLike }>) {
  events.push(event.type);
}
const final = await (stream as unknown as { result(): Promise<AssistantLike> }).result();
server.close();

interface AssistantLike {
  content: Array<{ type: string; text?: string }>;
  usage: { cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } };
}

const text = final.content
  .map((part) => (part.type === "text" ? part.text : ""))
  .join("");

const failures: string[] = [];
if (!text.includes("hello from the fake gateway")) failures.push(`missing text (got ${JSON.stringify(text)})`);
if (final.usage.cost.total !== TELEMETRY_COST) failures.push(`cost.total=${final.usage.cost.total} != ${TELEMETRY_COST}`);
if (final.usage.cost.input !== 0) failures.push(`cost.input=${final.usage.cost.input} (expected untouched zero)`);
if (!events.includes("done")) failures.push(`no done event (events: ${events.join(",")})`);

console.log(`events: ${events.join(" → ")}`);
console.log(`text: ${JSON.stringify(text)}`);
console.log(`cost: ${JSON.stringify(final.usage.cost)}`);

if (failures.length > 0) {
  console.error("FAIL\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("PASS — gateway cost reached the assistant message");
