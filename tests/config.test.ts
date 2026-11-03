import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";

const env = {
  LLM_API_KEY: "cai_x",
  LLM_MODEL: "deepseek-v4.1-flash",
  AGENT_EMAIL: "assistant@resortos.internal",
  AGENT_PASSWORD: "pw",
  AGENT_DRAFT_SECRET: "a-long-enough-secret",
};

describe("agent config", () => {
  it("applies defaults", () => {
    assert.deepEqual(loadConfig(env), {
      port: 4300,
      bookingApiUrl: "http://localhost:4000",
      agentEmail: "assistant@resortos.internal",
      agentPassword: "pw",
      draftSecret: "a-long-enough-secret",
      utcOffset: "+07:00",
      trustProxy: false,
      limits: { chatPerMinute: 10, bookingsPerHour: 3, perSession: 30 },
      llm: { format: "messages", baseUrl: "https://api.cent-ai.dev/v1", apiKey: "cai_x", model: "deepseek-v4.1-flash" },
    });
  });

  it("names every invalid setting", () => {
    assert.throws(() => loadConfig({ ...env, AGENT_DRAFT_SECRET: "short", AGENT_EMAIL: "nope" }), /AGENT_EMAIL.*AGENT_DRAFT_SECRET must be at least 16 characters|AGENT_DRAFT_SECRET.*AGENT_EMAIL/);
  });
});
