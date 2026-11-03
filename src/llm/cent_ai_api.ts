// Cent AI (https://cent-ai.dev): the only file that knows the AI provider.
// To switch providers, replace this file with one exporting the same three functions:
//   createXModel(config) → a Vercel AI SDK model for Mastra
//   listXModels(config)  → the models this key can use
//   toLlmError(err)      → provider failures as LlmError
//
// Cent AI formats (LLM_API_FORMAT). Chosen by testing: messages (≈3.3× fewer input tokens, agent_spec.md §11.2c).
//   messages  → POST {baseUrl}/messages   Anthropic shape (x-api-key)
//   responses → POST {baseUrl}/responses  OpenAI Responses shape (Bearer)
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { LlmError, type LlmModel } from "../types/llm.ts";

export type CentAiFormat = "messages" | "responses";

export interface CentAiConfig {
  format: CentAiFormat;
  /** Includes /v1, e.g. https://api.cent-ai.dev/v1 (the AI SDK appends /messages or /responses). */
  baseUrl: string;
  apiKey: string;
  /** Exact model ID from GET /models */
  model: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.cent-ai.dev/v1";

export function centAiConfigFromEnv(env: Record<string, string | undefined> = process.env): CentAiConfig {
  const format = env.LLM_API_FORMAT ?? "messages";
  if (format !== "messages" && format !== "responses") throw new Error('LLM_API_FORMAT must be "messages" or "responses"');
  if (!env.LLM_API_KEY) throw new Error("LLM_API_KEY is not set (put your Cent AI key in .env)");
  if (!env.LLM_MODEL) throw new Error("LLM_MODEL is not set (use an ID from GET /v1/models)");
  return { format, baseUrl: (env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""), apiKey: env.LLM_API_KEY, model: env.LLM_MODEL };
}

export function createCentAiModel(config: CentAiConfig) {
  const http = config.fetch ?? fetch;
  if (config.format === "messages") {
    return createAnthropic({ baseURL: config.baseUrl, apiKey: config.apiKey, fetch: dropUnsignedThinking(http) })(config.model);
  }
  return createOpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey, fetch: http }).responses(config.model);
}

/**
 * Non-Claude models on Cent AI's Messages format (e.g. DeepSeek) return `thinking` blocks without the
 * `signature` the Anthropic provider requires, so the SDK rejects an otherwise valid reply. We never use the
 * model's thinking, so unsigned thinking blocks are dropped from successful JSON responses.
 */
function dropUnsignedThinking(http: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await http(input, init);
    if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) return res;
    const body = (await res.clone().json().catch(() => null)) as { content?: { type?: string; signature?: string }[] } | null;
    if (!Array.isArray(body?.content) || !body.content.some((b) => b.type === "thinking" && !b.signature)) return res;
    body.content = body.content.filter((b) => !(b.type === "thinking" && !b.signature));
    return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

export async function listCentAiModels(config: CentAiConfig): Promise<LlmModel[]> {
  const res = await (config.fetch ?? fetch)(`${config.baseUrl}/models`, { headers: { authorization: `Bearer ${config.apiKey}` } });
  const body = (await res.json().catch(() => ({}))) as { data?: CentAiModel[]; error?: ErrorBody };
  if (!res.ok) throw fromErrorBody(res.status, body.error, res.headers.get("retry-after"));
  return (body.data ?? []).map((m) => ({ id: m.id, ownedBy: m.owned_by, contextWindow: m.context_window, capabilities: m.capabilities ?? [], status: m.status }));
}

/** Normalises a model-call failure (possibly wrapped by Mastra) into LlmError; null if it isn't a provider failure. */
export function toLlmError(err: unknown): LlmError | null {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof LlmError) return e;
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) return new LlmError(0, "timeout", "Cent AI request timed out");
    if (e instanceof TypeError && /fetch failed/i.test(e.message)) return new LlmError(0, "network", "Could not reach Cent AI");
    const apiError = e as { statusCode?: number; responseBody?: string; responseHeaders?: Record<string, string> };
    if (typeof apiError.statusCode === "number") {
      let body: { error?: ErrorBody } = {};
      try {
        body = JSON.parse(apiError.responseBody ?? "");
      } catch {
        // Non-JSON body (e.g. a gateway HTML page): use the generic message.
      }
      return fromErrorBody(apiError.statusCode, body.error, apiError.responseHeaders?.["retry-after"]);
    }
  }
  return null;
}

interface CentAiModel {
  id: string;
  owned_by?: string;
  context_window?: number;
  capabilities?: string[];
  status?: string;
}

/** OpenAI shape `{ error: { code, type, message } }` or Anthropic shape `{ type: "error", error: { type, message } }`. */
type ErrorBody = { code?: string; type?: string; message?: string };

function fromErrorBody(status: number, error: ErrorBody | undefined, retryAfterHeader: string | null | undefined): LlmError {
  const code = error?.code ?? (error?.type === "rate_limit_error" ? "rate_limited" : error?.type) ?? `http_${status}`;
  const retryAfter = Number(retryAfterHeader);
  return new LlmError(status, code, error?.message ?? `Cent AI request failed with HTTP ${status}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
}
