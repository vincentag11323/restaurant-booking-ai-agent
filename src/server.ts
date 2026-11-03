import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type { ChatResult } from "./chat.ts";

export interface ServerDeps {
  handleChat(body: unknown, request: { clientIp?: string }): Promise<ChatResult>;
  trustProxy?: boolean;
  log?: (line: string) => void;
  limits?: { chatPerMinute: number; bookingsPerHour: number; perSession: number };
}

export function createServer(deps: ServerDeps) {
  const log = deps.log ?? ((line: string) => console.info(line));
  const limits = deps.limits ?? { chatPerMinute: 10, bookingsPerHour: 3, perSession: 30 };
  const app = express();
  app.disable("x-powered-by");
  if (deps.trustProxy) app.set("trust proxy", 1);
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const chatLimiter = rateLimit({ windowMs: 60_000, limit: limits.chatPerMinute, message: { reply: "Too many messages. Please wait a minute and try again." } });
  // Confirmations are the only requests that book, so they get their own, tighter limit (AGENT_SPEC.md §5.4).
  const bookingLimiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: limits.bookingsPerHour,
    skip: (req) => !(req.body && typeof req.body === "object" && "confirm" in req.body),
    message: { reply: "Too many bookings from this connection. Please try again later or book in the app." },
  });

  // One chat session = the guest's email (no sign-in). Keyed by email so it holds across IPs; the IP limits
  // above still apply because an email can be made up (AGENT_SPEC.md §5.4).
  const sessionEmail = (req: Request): string | undefined => {
    const email = (req.body as { contact?: { email?: unknown } } | undefined)?.contact?.email;
    return typeof email === "string" && email.includes("@") ? email.trim().toLowerCase() : undefined;
  };
  const sessionLimiter = rateLimit({
    windowMs: 30 * 60_000,
    limit: limits.perSession,
    skip: (req) => !sessionEmail(req),
    keyGenerator: (req) => `session:${sessionEmail(req)}`,
    message: { reply: "You've sent a lot of messages. Please wait a while and try again." },
  });

  app.post("/chat", chatLimiter, sessionLimiter, bookingLimiter, async (req, res) => {
    const result = await deps.handleChat(req.body, { clientIp: req.ip });
    if (result.retryAfterSeconds) res.set("Retry-After", String(result.retryAfterSeconds));
    log(`chat status=${result.status}`);
    res.status(result.status).json(result.body);
  });

  app.use((_req, res) => {
    res.status(404).json({ reply: "Not found" });
  });

  // Chat content is never logged; only the error type.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (typeof err === "object" && err !== null && "type" in err && err.type === "entity.parse.failed") {
      res.status(400).json({ reply: "Invalid request: the body must be JSON" });
      return;
    }
    log(`chat error=${err instanceof Error ? err.name : "unknown"}`);
    res.status(500).json({ reply: "Something went wrong. Nothing was booked; please try again." });
  });

  return app;
}
