// Provider-neutral LLM types. The rest of the agent depends only on these and on the model handed to Mastra;
// src/llm/centAiApi.ts is the one file that knows the provider.

export interface LlmModel {
  id: string;
  ownedBy?: string;
  contextWindow?: number;
  capabilities: string[];
  status?: string;
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
