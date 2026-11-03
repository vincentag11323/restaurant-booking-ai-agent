// Provider-neutral LLM types. The agent depends only on these; each provider file
// (src/llm/cent_ai_api.ts today) translates them to and from its own wire format.

/** JSON Schema object describing a tool's input. */
export type JsonSchema = Record<string, unknown>;

export interface LlmTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface LlmToolCall {
  /** Provider-issued id; send it back on the matching tool message. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxOutputTokens?: number;
}

export type LlmStopReason = "end" | "tool_calls" | "max_tokens" | "other";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD, when the provider reports it (Cent AI does, as usage.cost). */
  costUsd?: number;
}

export interface LlmResult {
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
}

export interface LlmModel {
  id: string;
  ownedBy?: string;
  contextWindow?: number;
  capabilities: string[];
  status?: string;
}

/** What every provider file must export (via its factory function). */
export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResult>;
  listModels(): Promise<LlmModel[]>;
}

/** Normalised provider failure, so callers never parse provider error shapes. */
export class LlmError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** Worth retrying later: rate limit, timeout, network, or a 5xx. */
  get retryable(): boolean {
    return this.code === "rate_limited" || this.code === "timeout" || this.code === "network" || this.status >= 500;
  }
}
