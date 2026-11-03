// Cent AI adapter (https://cent-ai.dev). The only file that knows Cent AI's URLs, headers and wire formats.
// To switch providers, add a sibling file whose factory returns the same LlmProvider interface.
//
// Two Cent AI formats, picked by LLM_API_FORMAT:
//   messages  → POST {baseUrl}/messages   Anthropic shape, x-api-key + anthropic-version (Claude models)
//   responses → POST {baseUrl}/responses  OpenAI Responses shape, Bearer token (GPT-style models)
// Cent AI keeps no conversation state, so every call sends the full history (store: false).

import {
  LlmError,
  type LlmMessage,
  type LlmModel,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type LlmStopReason,
  type LlmTool,
  type LlmToolCall,
  type LlmUsage,
} from "../types/llm.ts";

export type CentAiFormat = "messages" | "responses";

export interface CentAiConfig {
  format: CentAiFormat;
  /** Includes /v1, e.g. https://api.cent-ai.dev/v1 */
  baseUrl: string;
  apiKey: string;
  /** Exact model ID from GET /models */
  model: string;
  timeoutMs?: number;
  /** Default output cap; the Messages format requires one on every request. */
  maxOutputTokens?: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.cent-ai.dev/v1";
const ANTHROPIC_VERSION = "2023-06-01";

export function centAiConfigFromEnv(env: Record<string, string | undefined> = process.env): CentAiConfig {
  const format = env.LLM_API_FORMAT ?? "messages";
  if (format !== "messages" && format !== "responses") throw new Error('LLM_API_FORMAT must be "messages" or "responses"');
  if (!env.LLM_API_KEY) throw new Error("LLM_API_KEY is not set (put your Cent AI key in .env)");
  if (!env.LLM_MODEL) throw new Error("LLM_MODEL is not set (use an ID from GET /v1/models)");
  return {
    format,
    baseUrl: (env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
  };
}

export function createCentAiProvider(config: CentAiConfig): LlmProvider {
  const http = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const defaultMaxTokens = config.maxOutputTokens ?? 1024;

  async function call(path: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: unknown }): Promise<unknown> {
    let res: Response;
    try {
      res = await http(`${config.baseUrl}${path}`, {
        method: init.method,
        headers: init.headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
      throw timedOut ? new LlmError(0, "timeout", "Cent AI request timed out") : new LlmError(0, "network", "Could not reach Cent AI");
    }
    if (!res.ok) throw await toLlmError(res);
    return res.json();
  }

  const bearer = { authorization: `Bearer ${config.apiKey}` };
  const json = { "content-type": "application/json" };

  return {
    name: `cent-ai:${config.format}:${config.model}`,

    async complete(request: LlmRequest): Promise<LlmResult> {
      const maxTokens = request.maxOutputTokens ?? defaultMaxTokens;
      if (config.format === "messages") {
        const body = await call("/messages", {
          method: "POST",
          headers: { ...json, "x-api-key": config.apiKey, "anthropic-version": ANTHROPIC_VERSION },
          body: {
            model: config.model,
            max_tokens: maxTokens,
            system: request.system,
            messages: toAnthropicMessages(request.messages),
            ...(request.tools?.length ? { tools: request.tools.map(toAnthropicTool) } : {}),
          },
        });
        return fromAnthropic(body as AnthropicResponse);
      }
      const body = await call("/responses", {
        method: "POST",
        headers: { ...json, ...bearer },
        body: {
          model: config.model,
          instructions: request.system,
          input: toResponsesInput(request.messages),
          store: false,
          max_output_tokens: maxTokens,
          ...(request.tools?.length ? { tools: request.tools.map(toResponsesTool) } : {}),
        },
      });
      return fromResponses(body as ResponsesResponse);
    },

    async listModels(): Promise<LlmModel[]> {
      const body = (await call("/models", { method: "GET", headers: bearer })) as { data?: CentAiModel[] };
      return (body.data ?? []).map((m) => ({
        id: m.id,
        ownedBy: m.owned_by,
        contextWindow: m.context_window,
        capabilities: m.capabilities ?? [],
        status: m.status,
      }));
    },
  };
}

// ── Anthropic Messages format ────────────────────────────────────────────────

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: string };
}

function toAnthropicTool(tool: LlmTool) {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

function toAnthropicMessages(messages: LlmMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      if (!message.toolCalls?.length) {
        out.push({ role: "assistant", content: message.content });
        continue;
      }
      const blocks: AnthropicBlock[] = message.content ? [{ type: "text", text: message.content }] : [];
      for (const tc of message.toolCalls) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      out.push({ role: "assistant", content: blocks });
    } else {
      // Anthropic wants all results for one assistant turn inside a single user message.
      const result: AnthropicBlock = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content };
      const last = out.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
        last.content.push(result);
      } else {
        out.push({ role: "user", content: [result] });
      }
    }
  }
  return out;
}

const ANTHROPIC_STOP: Record<string, LlmStopReason> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_calls",
  max_tokens: "max_tokens",
};

function fromAnthropic(body: AnthropicResponse): LlmResult {
  const toolCalls: LlmToolCall[] = [];
  let text = "";
  for (const block of body.content ?? []) {
    if (block.type === "text") text += block.text;
    if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
  }
  return {
    text,
    toolCalls,
    stopReason: ANTHROPIC_STOP[body.stop_reason ?? ""] ?? "other",
    usage: toUsage(body.usage?.input_tokens, body.usage?.output_tokens, body.usage?.cost),
  };
}

// ── OpenAI Responses format ──────────────────────────────────────────────────

type ResponsesInputItem =
  | { role: "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

interface ResponsesOutputItem {
  type: string;
  content?: { type: string; text?: string }[];
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface ResponsesResponse {
  status?: string;
  incomplete_details?: { reason?: string };
  output?: ResponsesOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number; cost?: string };
}

function toResponsesTool(tool: LlmTool) {
  return { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters };
}

function toResponsesInput(messages: LlmMessage[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      out.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.content) out.push({ role: message.role, content: message.content });
    if (message.role === "assistant") {
      for (const tc of message.toolCalls ?? []) {
        out.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.input) });
      }
    }
  }
  return out;
}

function parseArguments(raw: string, toolName: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    throw new LlmError(502, "bad_response", `Cent AI returned invalid JSON arguments for tool "${toolName}"`);
  }
}

function fromResponses(body: ResponsesResponse): LlmResult {
  const toolCalls: LlmToolCall[] = [];
  let text = "";
  for (const item of body.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) if (part.type === "output_text" && part.text) text += part.text;
    }
    if (item.type === "function_call" && item.call_id && item.name) {
      toolCalls.push({ id: item.call_id, name: item.name, input: parseArguments(item.arguments ?? "{}", item.name) });
    }
  }
  const stopReason: LlmStopReason = toolCalls.length
    ? "tool_calls"
    : body.status === "incomplete" && body.incomplete_details?.reason === "max_output_tokens"
      ? "max_tokens"
      : body.status === "completed"
        ? "end"
        : "other";
  return { text, toolCalls, stopReason, usage: toUsage(body.usage?.input_tokens, body.usage?.output_tokens, body.usage?.cost) };
}

// ── Shared ───────────────────────────────────────────────────────────────────

interface CentAiModel {
  id: string;
  owned_by?: string;
  context_window?: number;
  capabilities?: string[];
  status?: string;
}

function toUsage(inputTokens = 0, outputTokens = 0, cost?: string): LlmUsage {
  const costUsd = cost === undefined ? undefined : Number(cost);
  return { inputTokens, outputTokens, ...(costUsd !== undefined && Number.isFinite(costUsd) ? { costUsd } : {}) };
}

/** Reads either error shape: OpenAI `{ error: { code, type, message } }` or Anthropic `{ type: "error", error: { type, message } }`. */
async function toLlmError(res: Response): Promise<LlmError> {
  let error: { code?: string; type?: string; message?: string } = {};
  try {
    error = ((await res.json()) as { error?: typeof error }).error ?? {};
  } catch {
    // Non-JSON body (e.g. an HTML gateway page): fall through to the generic message.
  }
  const code = error.code ?? (error.type === "rate_limit_error" ? "rate_limited" : error.type) ?? `http_${res.status}`;
  const retryAfter = Number(res.headers.get("retry-after"));
  return new LlmError(
    res.status,
    code,
    error.message ?? `Cent AI request failed with HTTP ${res.status}`,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  );
}
