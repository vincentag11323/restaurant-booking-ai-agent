import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APICallError } from "@ai-sdk/provider";
import { centAiConfigFromEnv, createCentAiModel, listCentAiModels, toLlmError } from "../src/llm/cent_ai_api.ts";
import { LlmError } from "../src/types/llm.ts";

const base = { baseUrl: "https://api.cent-ai.dev/v1", apiKey: "cai_test", model: "deepseek-v4.1-flash" };

describe("Cent AI model for Mastra", () => {
  it("uses the Anthropic Messages provider for format=messages", () => {
    const model = createCentAiModel({ ...base, format: "messages" });
    assert.equal(model.modelId, "deepseek-v4.1-flash");
    assert.match(model.provider, /anthropic/);
  });

  it("uses the OpenAI Responses provider for format=responses", () => {
    const model = createCentAiModel({ ...base, format: "responses" });
    assert.equal(model.modelId, "deepseek-v4.1-flash");
    assert.match(model.provider, /openai\.responses/);
  });
});

describe("Cent AI models list", () => {
  it("calls GET /models with a Bearer token and normalises the entries", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get("authorization") });
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4.1-flash", owned_by: "deepseek", context_window: 128000, capabilities: ["tools"], status: "operational" }, { id: "x" }] }));
    }) as typeof fetch;
    assert.deepEqual(await listCentAiModels({ ...base, format: "messages", fetch: fetchImpl }), [
      { id: "deepseek-v4.1-flash", ownedBy: "deepseek", contextWindow: 128000, capabilities: ["tools"], status: "operational" },
      { id: "x", ownedBy: undefined, contextWindow: undefined, capabilities: [], status: undefined },
    ]);
    assert.deepEqual(calls, [{ url: "https://api.cent-ai.dev/v1/models", auth: "Bearer cai_test" }]);
  });

  it("turns a failed listing into LlmError", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "Invalid API key." } }), { status: 401 })) as typeof fetch;
    await assert.rejects(listCentAiModels({ ...base, format: "messages", fetch: fetchImpl }), { name: "LlmError", status: 401, code: "invalid_api_key" });
  });
});

describe("errors from Cent AI become LlmError", () => {
  const apiError = (statusCode: number, body: unknown, headers: Record<string, string> = {}) =>
    new APICallError({ message: "failed", url: "https://api.cent-ai.dev/v1/messages", requestBodyValues: {}, statusCode, responseHeaders: headers, responseBody: JSON.stringify(body) });

  it("reads the OpenAI and Anthropic error shapes and Retry-After", () => {
    assert.deepEqual(pick(toLlmError(apiError(429, { error: { code: "project_budget_exceeded", message: "Budget reached" } }))), [429, "project_budget_exceeded", "Budget reached", undefined]);
    assert.deepEqual(pick(toLlmError(apiError(429, { type: "error", error: { type: "rate_limit_error", message: "Slow down" } }, { "retry-after": "12" }))), [429, "rate_limited", "Slow down", 12]);
    assert.deepEqual(pick(toLlmError(apiError(500, "<html>"))), [500, "http_500", "Cent AI request failed with HTTP 500", undefined]);
  });

  it("finds the provider error when Mastra wraps it", () => {
    const wrapped = new Error("agent failed", { cause: new Error("step failed", { cause: apiError(401, { error: { code: "invalid_api_key", message: "Invalid API key." } }) }) });
    assert.deepEqual(pick(toLlmError(wrapped)), [401, "invalid_api_key", "Invalid API key.", undefined]);
  });

  it("recognises timeouts and network failures, and leaves other errors alone", () => {
    assert.equal(toLlmError(new DOMException("timed out", "TimeoutError"))?.code, "timeout");
    assert.equal(toLlmError(new TypeError("fetch failed"))?.code, "network");
    assert.equal(toLlmError(new LlmError(400, "x", "already normalised"))?.code, "x");
    assert.equal(toLlmError(new Error("a bug")), null);
  });

  function pick(err: LlmError | null) {
    assert.ok(err);
    return [err.status, err.code, err.message, err.retryAfterSeconds];
  }
});

describe("config from env", () => {
  const env = { LLM_API_FORMAT: "messages", LLM_BASE_URL: "https://api.cent-ai.dev/v1/", LLM_API_KEY: "cai_x", LLM_MODEL: "deepseek-v4.1-flash" };

  it("reads the four LLM_ variables and trims a trailing slash", () => {
    assert.deepEqual(centAiConfigFromEnv(env), { format: "messages", baseUrl: "https://api.cent-ai.dev/v1", apiKey: "cai_x", model: "deepseek-v4.1-flash" });
  });

  it("defaults the base URL and refuses missing or invalid values", () => {
    assert.equal(centAiConfigFromEnv({ ...env, LLM_BASE_URL: undefined }).baseUrl, "https://api.cent-ai.dev/v1");
    assert.throws(() => centAiConfigFromEnv({ ...env, LLM_API_KEY: "" }), /LLM_API_KEY is not set/);
    assert.throws(() => centAiConfigFromEnv({ ...env, LLM_MODEL: undefined }), /LLM_MODEL is not set/);
    assert.throws(() => centAiConfigFromEnv({ ...env, LLM_API_FORMAT: "chat" }), /LLM_API_FORMAT must be "messages" or "responses"/);
  });
});
