import { z } from "zod";
import { type CentAiConfig, centAiConfigFromEnv } from "./llm/cent_ai_api.ts";

const envSchema = z.object({
  PORT: z.coerce.number().int().default(4300),
  BOOKING_API_URL: z.url().default("http://localhost:4000"),
  AGENT_EMAIL: z.email(),
  AGENT_PASSWORD: z.string().min(1, "AGENT_PASSWORD is not set"),
  AGENT_DRAFT_SECRET: z.string().min(16, "AGENT_DRAFT_SECRET must be at least 16 characters"),
  RESTAURANT_UTC_OFFSET: z.string().regex(/^[+-]\d{2}:\d{2}$/).default("+07:00"),
  // Behind a hosting proxy, the client IP comes from X-Forwarded-For (rate limits and audit).
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
});

export interface AgentConfig {
  port: number;
  bookingApiUrl: string;
  agentEmail: string;
  agentPassword: string;
  draftSecret: string;
  utcOffset: string;
  trustProxy: boolean;
  llm: CentAiConfig;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid .env: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const e = parsed.data;
  return {
    port: e.PORT,
    bookingApiUrl: e.BOOKING_API_URL.replace(/\/+$/, ""),
    agentEmail: e.AGENT_EMAIL,
    agentPassword: e.AGENT_PASSWORD,
    draftSecret: e.AGENT_DRAFT_SECRET,
    utcOffset: e.RESTAURANT_UTC_OFFSET,
    trustProxy: e.TRUST_PROXY === "true",
    llm: centAiConfigFromEnv(env),
  };
}
