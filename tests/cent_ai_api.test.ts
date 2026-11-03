import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { centAiConfigFromEnv, createCentAiProvider, type CentAiConfig } from "../src/llm/cent_ai_api.ts";
import { LlmError, type LlmMessage, type LlmTool } from "../src/types/llm.ts";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** A fetch stand-in that records the request and answers with the given status/body/headers. */
function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const base: Omit<CentAiConfig, "format"> = { baseUrl: "https://api.cent-ai.dev/v1", apiKey: "cai_test", model: "test-model" };

const availabilityTool: LlmTool = {
  name: "checkAvailability",
  description: "Free tables per sitting",
  parameters: { type: "object", properties: { date: { type: "string" } }, required: ["date"] },
};

// A full tool round trip: user asks, model calls a tool, we return its result.
const conversation: LlmMessage[] = [
  { role: "user", content: "Any tables on 2026-12-24?" },
  { role: "assistant", content: "Let me check.", toolCalls: [{ id: "call_1", name: "checkAvailability", input: { date: "2026-12-24" } }] },
  { role: "tool", toolCallId: "call_1", name: "checkAvailability", content: '{"freeUnits":42}' },
];

describe("Cent AI, Messages format (Anthropic)", () => {
  it("sends an Anthropic-shaped request to /messages with x-api-key", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { content: [{ type: "text", text: "Yes" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    const llm = createCentAiProvider({ ...base, format: "messages", fetch: fetchImpl });
    await llm.complete({ system: "Booking help only.", messages: conversation, tools: [availabilityTool] });

    const [call] = calls;
    assert.equal(call.url, "https://api.cent-ai.dev/v1/messages");
    assert.equal(call.method, "POST");
    assert.equal(call.headers["x-api-key"], "cai_test");
    assert.equal(call.headers["anthropic-version"], "2023-06-01");
    assert.equal(call.headers.authorization, undefined);
    assert.deepEqual(call.body, {
      model: "test-model",
      max_tokens: 1024,
      system: "Booking help only.",
      messages: [
        { role: "user", content: "Any tables on 2026-12-24?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "call_1", name: "checkAvailability", input: { date: "2026-12-24" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"freeUnits":42}' }] },
      ],
      tools: [{ name: "checkAvailability", description: "Free tables per sitting", input_schema: availabilityTool.parameters }],
    });
  });

  it("merges consecutive tool results into one user turn, as Anthropic requires", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } });
    const llm = createCentAiProvider({ ...base, format: "messages", fetch: fetchImpl });
    await llm.complete({
      system: "s",
      messages: [
        { role: "user", content: "both branches?" },
        { role: "assistant", content: "", toolCalls: [{ id: "a", name: "t", input: {} }, { id: "b", name: "t", input: {} }] },
        { role: "tool", toolCallId: "a", name: "t", content: "1" },
        { role: "tool", toolCallId: "b", name: "t", content: "2" },
      ],
    });
    const messages = calls[0].body?.messages as { role: string; content: unknown }[];
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[1].content, [
      { type: "tool_use", id: "a", name: "t", input: {} },
      { type: "tool_use", id: "b", name: "t", input: {} },
    ]);
    assert.deepEqual(messages[2], {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "1" },
        { type: "tool_result", tool_use_id: "b", content: "2" },
      ],
    });
  });

  it("normalises text, tool calls, stop reason and cost", async () => {
    const { fetchImpl } = fakeFetch(200, {
      content: [
        { type: "text", text: "Checking " },
        { type: "text", text: "now." },
        { type: "tool_use", id: "toolu_9", name: "checkAvailability", input: { date: "2026-12-24" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 120, output_tokens: 30, cost: "0.003210000" },
    });
    const llm = createCentAiProvider({ ...base, format: "messages", fetch: fetchImpl });
    assert.deepEqual(await llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }] }), {
      text: "Checking now.",
      toolCalls: [{ id: "toolu_9", name: "checkAvailability", input: { date: "2026-12-24" } }],
      stopReason: "tool_calls",
      usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.00321 },
    });
  });

  it("maps end_turn and max_tokens stop reasons", async () => {
    for (const [wire, expected] of [["end_turn", "end"], ["max_tokens", "max_tokens"], ["refusal", "other"]] as const) {
      const { fetchImpl } = fakeFetch(200, { content: [], stop_reason: wire, usage: { input_tokens: 0, output_tokens: 0 } });
      const result = await createCentAiProvider({ ...base, format: "messages", fetch: fetchImpl }).complete({ system: "s", messages: [] });
      assert.equal(result.stopReason, expected);
    }
  });
});

describe("Cent AI, Responses format (OpenAI)", () => {
  it("sends a Responses-shaped request to /responses with a Bearer token, stateless", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0 } });
    const llm = createCentAiProvider({ ...base, format: "responses", fetch: fetchImpl });
    await llm.complete({ system: "Booking help only.", messages: conversation, tools: [availabilityTool], maxOutputTokens: 300 });

    const [call] = calls;
    assert.equal(call.url, "https://api.cent-ai.dev/v1/responses");
    assert.equal(call.headers.authorization, "Bearer cai_test");
    assert.equal(call.headers["x-api-key"], undefined);
    assert.deepEqual(call.body, {
      model: "test-model",
      instructions: "Booking help only.",
      store: false,
      max_output_tokens: 300,
      input: [
        { role: "user", content: "Any tables on 2026-12-24?" },
        { role: "assistant", content: "Let me check." },
        { type: "function_call", call_id: "call_1", name: "checkAvailability", arguments: '{"date":"2026-12-24"}' },
        { type: "function_call_output", call_id: "call_1", output: '{"freeUnits":42}' },
      ],
      tools: [{ type: "function", name: "checkAvailability", description: "Free tables per sitting", parameters: availabilityTool.parameters }],
    });
  });

  it("normalises output text, function calls and cost", async () => {
    const { fetchImpl } = fakeFetch(200, {
      status: "completed",
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "One moment." }] },
        { type: "function_call", call_id: "fc_1", name: "checkAvailability", arguments: '{"date":"2026-12-24"}' },
      ],
      usage: { input_tokens: 5200, output_tokens: 310, cost: "0.000124000" },
    });
    const llm = createCentAiProvider({ ...base, format: "responses", fetch: fetchImpl });
    assert.deepEqual(await llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }] }), {
      text: "One moment.",
      toolCalls: [{ id: "fc_1", name: "checkAvailability", input: { date: "2026-12-24" } }],
      stopReason: "tool_calls",
      usage: { inputTokens: 5200, outputTokens: 310, costUsd: 0.000124 },
    });
  });

  it("reports a cut-off answer as max_tokens and a normal one as end", async () => {
    const cut = fakeFetch(200, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 1, output_tokens: 1 } });
    const done = fakeFetch(200, { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }], usage: { input_tokens: 1, output_tokens: 1 } });
    assert.equal((await createCentAiProvider({ ...base, format: "responses", fetch: cut.fetchImpl }).complete({ system: "s", messages: [] })).stopReason, "max_tokens");
    assert.equal((await createCentAiProvider({ ...base, format: "responses", fetch: done.fetchImpl }).complete({ system: "s", messages: [] })).stopReason, "end");
  });

  it("rejects tool arguments that are not valid JSON", async () => {
    const { fetchImpl } = fakeFetch(200, { status: "completed", output: [{ type: "function_call", call_id: "x", name: "t", arguments: "{oops" }], usage: { input_tokens: 0, output_tokens: 0 } });
    await assert.rejects(createCentAiProvider({ ...base, format: "responses", fetch: fetchImpl }).complete({ system: "s", messages: [] }), {
      name: "LlmError",
      code: "bad_response",
    });
  });
});

describe("Cent AI errors are normalised", () => {
  it("turns an OpenAI-shaped 401 into LlmError", async () => {
    const { fetchImpl } = fakeFetch(401, { error: { code: "invalid_api_key", message: "Invalid API key.", type: "authentication_error" } });
    await assert.rejects(createCentAiProvider({ ...base, format: "responses", fetch: fetchImpl }).complete({ system: "s", messages: [] }), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.deepEqual([err.status, err.code, err.message, err.retryable], [401, "invalid_api_key", "Invalid API key.", false]);
      return true;
    });
  });

  it("turns an Anthropic-shaped 429 into a retryable rate_limited error with Retry-After", async () => {
    const { fetchImpl } = fakeFetch(429, { type: "error", error: { type: "rate_limit_error", message: "Slow down" } }, { "retry-after": "12" });
    await assert.rejects(createCentAiProvider({ ...base, format: "messages", fetch: fetchImpl }).complete({ system: "s", messages: [] }), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.deepEqual([err.status, err.code, err.retryAfterSeconds, err.retryable], [429, "rate_limited", 12, true]);
      return true;
    });
  });

  it("keeps Cent AI's budget codes so callers can tell them apart", async () => {
    const { fetchImpl } = fakeFetch(429, { error: { code: "project_budget_exceeded", message: "Budget reached", type: "rate_limit_error" } });
    await assert.rejects(createCentAiProvider({ ...base, format: "responses", fetch: fetchImpl }).complete({ system: "s", messages: [] }), { code: "project_budget_exceeded" });
  });

  it("falls back to a generic message when the error body isn't JSON", async () => {
    const fetchImpl = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch;
    await assert.rejects(createCentAiProvider({ ...base, format: "messages", fetch: fetchImpl }).complete({ system: "s", messages: [] }), {
      status: 502,
      code: "http_502",
      message: "Cent AI request failed with HTTP 502",
    });
  });

  it("reports network failures and timeouts as retryable", async () => {
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const slow = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch;
    await assert.rejects(createCentAiProvider({ ...base, format: "messages", fetch: offline }).complete({ system: "s", messages: [] }), { code: "network", status: 0 });
    await assert.rejects(createCentAiProvider({ ...base, format: "messages", fetch: slow }).complete({ system: "s", messages: [] }), { code: "timeout", status: 0 });
  });
});

describe("Cent AI models", () => {
  it("lists models with their capabilities via GET /models", async () => {
    const { fetchImpl, calls } = fakeFetch(200, {
      object: "list",
      data: [
        { id: "claude-opus-5", owned_by: "anthropic", context_window: 200000, capabilities: ["tools", "reasoning"], status: "operational" },
        { id: "glm-5.3", owned_by: "zhipu" },
      ],
    });
    const models = await createCentAiProvider({ ...base, format: "messages", fetch: fetchImpl }).listModels();
    assert.equal(calls[0].url, "https://api.cent-ai.dev/v1/models");
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].headers.authorization, "Bearer cai_test");
    assert.deepEqual(models, [
      { id: "claude-opus-5", ownedBy: "anthropic", contextWindow: 200000, capabilities: ["tools", "reasoning"], status: "operational" },
      { id: "glm-5.3", ownedBy: "zhipu", contextWindow: undefined, capabilities: [], status: undefined },
    ]);
  });
});

describe("config from env", () => {
  const env = { LLM_API_FORMAT: "messages", LLM_BASE_URL: "https://api.cent-ai.dev/v1/", LLM_API_KEY: "cai_x", LLM_MODEL: "claude-opus-5" };

  it("reads the four LLM_ variables and trims a trailing slash", () => {
    assert.deepEqual(centAiConfigFromEnv(env), { format: "messages", baseUrl: "https://api.cent-ai.dev/v1", apiKey: "cai_x", model: "claude-opus-5" });
  });

  it("defaults the base URL and refuses missing or invalid values", () => {
    assert.equal(centAiConfigFromEnv({ ...env, LLM_BASE_URL: undefined }).baseUrl, "https://api.cent-ai.dev/v1");
    assert.throws(() => centAiConfigFromEnv({ ...env, LLM_API_KEY: "" }), /LLM_API_KEY is not set/);
    assert.throws(() => centAiConfigFromEnv({ ...env, LLM_MODEL: undefined }), /LLM_MODEL is not set/);
    assert.throws(() => centAiConfigFromEnv({ ...env, LLM_API_FORMAT: "chat" }), /LLM_API_FORMAT must be "messages" or "responses"/);
  });
});
