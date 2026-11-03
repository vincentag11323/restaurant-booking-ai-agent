import { z } from "zod";
import { type CentAiConfig, centAiConfigFromEnv } from "./llm/cent_ai_api.ts";

const envSchema = z.object({
  PORT: z.coerce.number().int().default(4300),
  BOOKING_API_URL: z.url().default("http://localhost:4000"),
  AGENT_API_KEY: z.string().min(32, "AGENT_API_KEY must be at least 32 characters"),
  AGENT_DRAFT_SECRET: z.string().min(16, "AGENT_DRAFT_SECRET must be at least 16 characters"),
  RESTAURANT_UTC_OFFSET: z.string().regex(/^[+-]\d{2}:\d{2}$/).default("+07:00"),
  // Behind a hosting proxy, the client IP comes from X-Forwarded-For (rate limits and audit).
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  // Defaults are the production limits (agent_spec.md §5.4); the e2e run raises them so it isn't throttled.
  CHAT_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  BOOKINGS_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(3),
  SESSION_CHAT_LIMIT: z.coerce.number().int().positive().default(30),
});

export interface AgentConfig {
  port: number;
  bookingApiUrl: string;
  agentApiKey: string;
  draftSecret: string;
  utcOffset: string;
  trustProxy: boolean;
  limits: { chatPerMinute: number; bookingsPerHour: number; perSession: number };
  llm: CentAiConfig;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid .env: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const e = parsed.data;
  return {
    port: e.PORT,
    bookingApiUrl: e.BOOKING_API_URL.replace(/\/+$/, ""),
    agentApiKey: e.AGENT_API_KEY,
    draftSecret: e.AGENT_DRAFT_SECRET,
    utcOffset: e.RESTAURANT_UTC_OFFSET,
    trustProxy: e.TRUST_PROXY === "true",
    limits: { chatPerMinute: e.CHAT_LIMIT_PER_MINUTE, bookingsPerHour: e.BOOKINGS_LIMIT_PER_HOUR, perSession: e.SESSION_CHAT_LIMIT },
    llm: centAiConfigFromEnv(env),
  };
}
