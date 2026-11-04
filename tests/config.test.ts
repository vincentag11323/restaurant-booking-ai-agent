import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";

const env = {
  LLM_API_KEY: "cai_x",
  LLM_MODEL: "deepseek-v4.1-flash",
  AGENT_API_KEY: "test-agent-key-test-agent-key-0001",
  AGENT_DRAFT_SECRET: "a-long-enough-secret",
};

describe("agent config", () => {
  it("applies defaults", () => {
    assert.deepEqual(loadConfig(env), {
      port: 4300,
      bookingApiUrl: "http://localhost:4000",
      agentApiKey: "test-agent-key-test-agent-key-0001",
      draftSecret: "a-long-enough-secret",
      utcOffset: "+07:00",
      trustProxy: false,
      limits: { chatPerMinute: 10, bookingsPerHour: 3, perSession: 30 },
      llm: { format: "messages", baseUrl: "https://api.cent-ai.dev/v1", apiKey: "cai_x", model: "deepseek-v4.1-flash" },
      apiDocs: true,
    });
  });

  it("names every invalid setting", () => {
    assert.throws(
      () => loadConfig({ ...env, AGENT_DRAFT_SECRET: "short", AGENT_API_KEY: "short" }),
      /AGENT_API_KEY: AGENT_API_KEY must be at least 32 characters.*AGENT_DRAFT_SECRET must be at least 16 characters|AGENT_DRAFT_SECRET must be at least 16 characters.*AGENT_API_KEY: AGENT_API_KEY must be at least 32 characters/,
    );
  });

  describe("API_DOCS (owner request 2026-11-04: interactive docs, off in production unless asked for)", () => {
    it("shows the docs outside production by default", () => {
      assert.equal(loadConfig(env).apiDocs, true);
      assert.equal(loadConfig({ ...env, NODE_ENV: "development" }).apiDocs, true);
      assert.equal(loadConfig({ ...env, NODE_ENV: "test" }).apiDocs, true);
    });

    it("hides the docs in production unless API_DOCS=true", () => {
      assert.equal(loadConfig({ ...env, NODE_ENV: "production" }).apiDocs, false);
      assert.equal(loadConfig({ ...env, NODE_ENV: "production", API_DOCS: "true" }).apiDocs, true);
      assert.equal(loadConfig({ ...env, NODE_ENV: "production", API_DOCS: "false" }).apiDocs, false);
    });
  });
});
