/* eslint-disable @typescript-eslint/no-floating-promises */
// ImpalaAiAdapter tests.
//
// Background: BG3's matchmaker uses a real managed AI provider
// (Highrise × Impala) behind the provider-neutral AiAdapter
// contract. These tests prove the adapter's correctness using an
// injected fake HTTP transport; automated tests do NOT contact the
// live Impala service. A separate operational smoke is responsible
// for live integration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchmakerCriteriaV1Schema, type AiInterpretBriefInputV1 } from "@soundhub/types";
import {
  FetchHttpTransport,
  HttpTransportError,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
} from "./http-transport.js";
import { AiUnavailableError } from "./ai-adapter.js";
import { ImpalaAiAdapter } from "./impala-ai-adapter.js";

const VALID_INPUT: AiInterpretBriefInputV1 = {
  actingWorkspaceId: "ws-buyer-1",
  briefText: "Need a producer in Brooklyn for a remote Haitian dancehall single.",
  buyerNonSearchRequirements: undefined,
};

// A deterministic, network-free transport that records every
// request and returns a queued response (or a queued error).
class FakeHttpTransport implements HttpTransport {
  readonly calls: HttpTransportRequest[] = [];
  private readonly queue: Array<
    { kind: "ok"; response: HttpTransportResponse } | { kind: "error"; error: Error }
  > = [];

  enqueueResponse(status: number, bodyText: string): void {
    this.queue.push({ kind: "ok", response: { status, bodyText } });
  }

  enqueueError(err: Error): void {
    this.queue.push({ kind: "error", error: err });
  }

  send(request: HttpTransportRequest): Promise<HttpTransportResponse> {
    this.calls.push(request);
    const next = this.queue.shift();
    if (!next) {
      return Promise.reject(new Error("FakeHttpTransport: no queued response"));
    }
    if (next.kind === "error") return Promise.reject(next.error);
    return Promise.resolve(next.response);
  }
}

// Tiny typed JSON helper so test bodies do not need `as` casts.
function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function validChatResponseBody(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-abc123",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "qwen3.6-27b",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
}

// ---------- Configuration guard ----------

test("ImpalaAiAdapter throws when API key is missing", async () => {
  const transport = new FakeHttpTransport();
  const adapter = new ImpalaAiAdapter(
    { baseUrl: "https://ht.getimpala.ai/v1", apiKey: "", model: "qwen3.6-27b" },
    transport,
  );
  assert.equal(adapter.isConfigured(), false);
  await assert.rejects(
    () => adapter.interpretBrief(VALID_INPUT),
    (err: unknown) =>
      err instanceof AiUnavailableError &&
      !err.message.includes("IMPALA") &&
      !err.message.toLowerCase().includes("key"),
  );
  assert.equal(transport.calls.length, 0, "no request must be issued when unconfigured");
});

test("ImpalaAiAdapter rejects a non-http(s) base URL", async () => {
  const transport = new FakeHttpTransport();
  const adapter = new ImpalaAiAdapter(
    { baseUrl: "ftp://example.com", apiKey: "secret", model: "qwen3.6-27b" },
    transport,
  );
  await assert.rejects(
    () => adapter.interpretBrief(VALID_INPUT),
    (err: unknown) => err instanceof AiUnavailableError,
  );
  assert.equal(transport.calls.length, 0);
});

// ---------- Request construction ----------

test("ImpalaAiAdapter builds the documented gateway request", async () => {
  const transport = new FakeHttpTransport();
  transport.enqueueResponse(
    200,
    validChatResponseBody(
      JSON.stringify({
        required: { primaryCategoryKeys: ["music-production"] },
      }),
    ),
  );

  const adapter = new ImpalaAiAdapter(
    {
      baseUrl: "https://ht.getimpala.ai/v1",
      apiKey: "team-secret-key",
      model: "qwen3.6-27b",
      timeoutMs: 5000,
    },
    transport,
  );

  const output = await adapter.interpretBrief(VALID_INPUT);
  assert.equal(output.provider, "managed");
  assert.equal(output.modelId, "qwen3.6-27b");

  const request = transport.calls[0]!;
  // Gateway endpoint
  assert.equal(request.url, "https://ht.getimpala.ai/v1/chat/completions");
  // Method
  assert.equal(request.method, "POST");
  // Headers — auth present but no provider internals exposed
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(request.headers["Accept"], "application/json");
  assert.equal(request.headers["Authorization"], "Bearer team-secret-key");
  // Timeout applied per request
  assert.equal(request.timeoutMs, 5000);

  // Body shape — chat completion with system + user messages and
  // the documented model id. We assert the JSON shape through a
  // dedicated helper to keep ESLint happy without sprinkling
  // `as` casts on every parse call.
  const body = parseJson<{
    model: string;
    temperature: number;
    max_tokens: number;
    messages: Array<{ role: string; content: string }>;
  }>(request.body);
  assert.equal(body.model, "qwen3.6-27b");
  assert.equal(body.messages[0]?.role, "system");
  assert.ok(
    typeof body.messages[0]?.content === "string" &&
      body.messages[0].content.includes("structured JSON"),
    "system prompt must instruct the model to return structured JSON",
  );
  // The system prompt must NOT instruct the model to omit
  // `required` for query-only briefs. matchmakerCriteriaV1Schema
  // declares `required` as a mandatory key, so a prompt that says
  // "omit required when query applies" produces output that fails
  // runtime validation. The mandatory-required invariant must be
  // explicit in the prompt.
  const systemPrompt = body.messages[0]?.content ?? "";
  assert.ok(
    systemPrompt.includes("Always emit a `required` object"),
    "system prompt must instruct the model to always emit `required`",
  );
  assert.ok(
    !systemPrompt.includes("omit `required`") && !systemPrompt.includes('omit "required"'),
    "system prompt must not instruct the model to omit `required`",
  );
  assert.equal(body.messages[1]?.role, "user");
  const userMessage = body.messages[1];
  assert.ok(userMessage);
  const userPayload = parseJson<{ actingWorkspaceId: string; briefText: string }>(
    userMessage.content,
  );
  assert.equal(userPayload.actingWorkspaceId, VALID_INPUT.actingWorkspaceId);
  assert.equal(userPayload.briefText, VALID_INPUT.briefText);
});

test("ImpalaAiAdapter strips a trailing slash from the base URL", async () => {
  const transport = new FakeHttpTransport();
  transport.enqueueResponse(
    200,
    validChatResponseBody(
      JSON.stringify({ required: { primaryCategoryKeys: ["music-production"] } }),
    ),
  );
  const adapter = new ImpalaAiAdapter(
    {
      baseUrl: "https://ht.getimpala.ai/v1/",
      apiKey: "team-secret-key",
      model: "qwen3.6-27b",
    },
    transport,
  );
  await adapter.interpretBrief(VALID_INPUT);
  assert.equal(transport.calls[0]!.url, "https://ht.getimpala.ai/v1/chat/completions");
});

// ---------- Response parsing ----------

test("ImpalaAiAdapter parses a valid assistant content payload", async () => {
  const transport = new FakeHttpTransport();
  transport.enqueueResponse(
    200,
    validChatResponseBody(
      JSON.stringify({
        required: { primaryCategoryKeys: ["music-production"], serviceModes: ["Remote"] },
        preferred: { genreTags: ["dancehall"] },
      }),
    ),
  );
  const adapter = new ImpalaAiAdapter(
    { baseUrl: "https://ht.getimpala.ai/v1", apiKey: "k", model: "qwen3.6-27b" },
    transport,
  );
  const output = await adapter.interpretBrief(VALID_INPUT);
  const validated = matchmakerCriteriaV1Schema.parse(output.candidate);
  assert.deepEqual(validated.required.primaryCategoryKeys, ["music-production"]);
  assert.deepEqual(validated.required.serviceModes, ["Remote"]);
  assert.deepEqual(validated.preferred?.genreTags, ["dancehall"]);
});

test("ImpalaAiAdapter strips a single pair of surrounding code fences from assistant content", async () => {
  const transport = new FakeHttpTransport();
  transport.enqueueResponse(
    200,
    validChatResponseBody(
      "```json\n" + JSON.stringify({ required: { primaryCategoryKeys: ["mixing"] } }) + "\n```",
    ),
  );
  const adapter = new ImpalaAiAdapter(
    { baseUrl: "https://ht.getimpala.ai/v1", apiKey: "k", model: "qwen3.6-27b" },
    transport,
  );
  const output = await adapter.interpretBrief(VALID_INPUT);
  const validated = matchmakerCriteriaV1Schema.parse(output.candidate);
  assert.deepEqual(validated.required.primaryCategoryKeys, ["mixing"]);
});

test("ImpalaAiAdapter tolerates extra provider metadata (id, usage, created)", async () => {
  const transport = new FakeHttpTransport();
  transport.enqueueResponse(
    200,
    JSON.stringify({
      id: "chatcmpl-XYZ",
      object: "chat.completion",
      created: 1_700_000_001,
      model: "qwen3.6-27b-2025-01-01",
      system_fingerprint: "fp_abc",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({ required: { primaryCategoryKeys: ["mixing"] } }),
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }),
  );
  const adapter = new ImpalaAiAdapter(
    { baseUrl: "https://ht.getimpala.ai/v1", apiKey: "k", model: "qwen3.6-27b" },
    transport,
  );
  const output = await adapter.interpretBrief(VALID_INPUT);
  // Provider-reported model id takes precedence in provenance.
  assert.equal(output.modelId, "qwen3.6-27b-2025-01-01");
});

// ---------- Malformed output -> AiUnavailableError (so application fallback kicks in) ----------

test("ImpalaAiAdapter throws on malformed JSON response", async () => {
  const transport = new FakeHttpTransport();
  transport.enqueueResponse(200, "not-json");
  const adapter = new ImpalaAiAdapter(
    { baseUrl: "https://ht.getimpala.ai/v1", apiKey: "k", model: "qwen3.6-27b" },
    transport,
  );
  await assert.rejects(
    () => adapter.interpretBrief(VALID_INPUT),
    (err: unknown) =>
      err instanceof AiUnavailableError &&
      !err.message.includes("not-json") &&
      !err.message.includes("k"),
  );
});

test("ImpalaAiAdapter throws when assistant content is not valid JSON", async () => {
  const transport = new FakeHttpTransport();
  transport.enqueueResponse(200, validChatResponseBody("hello world"));
  const adapter = new ImpalaAiAdapter(
    { baseUrl: "https://ht.getimpala.ai/v1", apiKey: "k", model: "qwen3.6-27b" },
    transport,
  );
  await assert.rejects(
    () => adapter.interpretBrief(VALID_INPUT),
    (err: unknown) => err instanceof AiUnavailableError,
  );
});

test("ImpalaAiAdapter throws when assistant content is a JSON array (not an object)", async () => {
  const transport = new FakeHttpTransport();
  transport.enqueueResponse(200, validChatResponseBody(JSON.stringify([1, 2, 3])));
  const adapter = new ImpalaAiAdapter(
    { baseUrl: "https://ht.getimpala.ai/v1", apiKey: "k", model: "qwen3.6-27b" },
    transport,
  );
  await assert.rejects(
    () => adapter.interpretBrief(VALID_INPUT),
    (err: unknown) => err instanceof AiUnavailableError,
  );
});

test("ImpalaAiAdapter throws when the candidate fails matchmakerCriteriaV1Schema", async () => {
  const transport = new FakeHttpTransport();
  // Required block is present but missing any hard constraint axis.
  transport.enqueueResponse(
    200,
    validChatResponseBody(
      JSON.stringify({
        required: {},
        preferred: {},
      }),
    ),
  );
  const adapter = new ImpalaAiAdapter(
    { baseUrl: "https://ht.getimpala.ai/v1", apiKey: "k", model: "qwen3.6-27b" },
    transport,
  );
  await assert.rejects(
    () => adapter.interpretBrief(VALID_INPUT),
    (err: unknown) => err instanceof AiUnavailableError,
  );
});

test("ImpalaAiAdapter throws when the upstream body is JSON null", async () => {
  // JSON.parse("null") returns the literal null. Without the
  // envelope-shape guard, reading .choices throws a TypeError
  // that bypasses the adapter's fallback path; the application
  // service then surfaces MATCHMAKER_FAILED instead of routing
  // the failure to the deterministic adapter. The guard must
  // translate the malformed envelope into AiUnavailableError so
  // the existing fallback logic takes over.
  const transport = new FakeHttpTransport();
  transport.enqueueResponse(200, "null");
  const adapter = new ImpalaAiAdapter(
    { baseUrl: "https://ht.getimpala.ai/v1", apiKey: "k", model: "qwen3.6-27b" },
    transport,
  );
  let caught: unknown;
  try {
    await adapter.interpretBrief(VALID_INPUT);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiUnavailableError");
});

test("ImpalaAiAdapter throws when the chat envelope is missing choices", async () => {
  const transport = new FakeHttpTransport();
  transport.enqueueResponse(200, JSON.stringify({ id: "x", model: "qwen3.6-27b" }));
  const adapter = new ImpalaAiAdapter(
    { baseUrl: "https://ht.getimpala.ai/v1", apiKey: "k", model: "qwen3.6-27b" },
    transport,
  );
  await assert.rejects(
    () => adapter.interpretBrief(VALID_INPUT),
    (err: unknown) => err instanceof AiUnavailableError,
  );
});

// ---------- Transport failure surfaces as AiUnavailableError (no upstream leak) ----------

test("ImpalaAiAdapter maps transport timeout to AiUnavailableError without leaking the key", async () => {
  const transport = new FakeHttpTransport();
  transport.enqueueError(new HttpTransportError("upstream timed out", "timeout"));
  const adapter = new ImpalaAiAdapter(
    { baseUrl: "https://ht.getimpala.ai/v1", apiKey: "team-secret-key", model: "qwen3.6-27b" },
    transport,
  );
  await assert.rejects(
    () => adapter.interpretBrief(VALID_INPUT),
    (err: unknown) =>
      err instanceof AiUnavailableError &&
      !err.message.includes("team-secret-key") &&
      !err.message.includes("upstream timed out"),
  );
});

test("ImpalaAiAdapter maps network error to AiUnavailableError", async () => {
  const transport = new FakeHttpTransport();
  transport.enqueueError(new HttpTransportError("ECONNREFUSED", "network"));
  const adapter = new ImpalaAiAdapter(
    { baseUrl: "https://ht.getimpala.ai/v1", apiKey: "k", model: "qwen3.6-27b" },
    transport,
  );
  await assert.rejects(
    () => adapter.interpretBrief(VALID_INPUT),
    (err: unknown) => err instanceof AiUnavailableError,
  );
});

test("ImpalaAiAdapter maps upstream HTTP 5xx to AiUnavailableError without echoing status", async () => {
  const transport = new FakeHttpTransport();
  transport.enqueueResponse(500, "internal server error");
  const adapter = new ImpalaAiAdapter(
    { baseUrl: "https://ht.getimpala.ai/v1", apiKey: "k", model: "qwen3.6-27b" },
    transport,
  );
  await assert.rejects(
    () => adapter.interpretBrief(VALID_INPUT),
    (err: unknown) => err instanceof AiUnavailableError && !err.message.includes("500"),
  );
});

// ---------- No leak ----------

test("ImpalaAiAdapter never returns the API key in its output", async () => {
  const transport = new FakeHttpTransport();
  transport.enqueueResponse(
    200,
    validChatResponseBody(
      JSON.stringify({ required: { primaryCategoryKeys: ["music-production"] } }),
    ),
  );
  const adapter = new ImpalaAiAdapter(
    {
      baseUrl: "https://ht.getimpala.ai/v1",
      apiKey: "DO-NOT-LEAK",
      model: "qwen3.6-27b",
    },
    transport,
  );
  const output = await adapter.interpretBrief(VALID_INPUT);
  const serialised = JSON.stringify(output);
  assert.ok(!serialised.includes("DO-NOT-LEAK"));
});

// ---------- Default transport smoke ----------

test("FetchHttpTransport type-checks as a HttpTransport (compile-time guard)", () => {
  // This test exists purely as a smoke that the production
  // transport conforms to the seam; runtime use requires network.
  const transport: HttpTransport = new FetchHttpTransport();
  assert.equal(typeof transport.send, "function");
});
