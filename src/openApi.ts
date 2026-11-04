// OpenAPI 3.1 document for this server's own API (AGENT_SPEC.md §4.1). Reuses the same Zod schema that
// validates POST /agents/users/chats, so the docs can't drift from the real rules. Also the one place that
// owns the exact, hoisted reply text for rate limits, malformed input, unknown routes and server failures,
// so server.ts and this document always say the same thing.
import { OpenAPIRegistry, OpenApiGeneratorV31, type ResponseConfig } from "@asteasolutions/zod-to-openapi";
import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { z } from "zod";
import { API_DOWN, BUSY, chatRequestSchema, draftSchema, EXPIRED, LAST_MESSAGE_MUST_BE_USER, LLM_PROBLEM, UNAVAILABLE } from "./chat.ts";

export const registry = new OpenAPIRegistry();

export const NOT_FOUND_REPLY = "Not found";
export const MALFORMED_JSON_REPLY = "Invalid request: the body must be JSON";
export const GENERIC_ERROR_REPLY = "Something went wrong. Nothing was booked; please try again.";
export const CHAT_LIMIT_REPLY = "Too many messages. Please wait a minute and try again.";
export const BOOKING_LIMIT_REPLY = "Too many bookings from this connection. Please try again later or book in the app.";
export const SESSION_LIMIT_REPLY = "You've sent a lot of messages. Please wait a while and try again.";

export const healthSchema = z.object({ status: z.literal("ok") });

const pendingBookingSchema = z.object({ draft: draftSchema, token: z.string() });
export const chatResponseSchema = z.object({
  reply: z.string(),
  pendingBooking: pendingBookingSchema.optional(),
  alternatives: z.array(pendingBookingSchema).optional(),
  booking: z.object({ code: z.string(), slotStart: z.string(), slotEnd: z.string(), tableIds: z.array(z.string()) }).optional(),
});

const errorSchema = z.object({ reply: z.string() });

type ErrorStatus = 400 | 404 | 429 | 500 | 502 | 503;
type ErrorMessages = Partial<Record<ErrorStatus, string[]>>;

const STATUS_DESCRIPTIONS: Record<ErrorStatus, string> = {
  400: "Bad input, or a read-back that changed or expired",
  404: "Unknown path",
  429: "Too many requests",
  500: "Unexpected server error",
  502: "The AI model or the booking API failed",
  503: "Busy; retry after the given number of seconds",
};

/** One response per status, with one named example per exact `{ reply }` (AGENT_SPEC.md §4.1). */
export function errorResponses(messages: ErrorMessages): Record<number, ResponseConfig> {
  const responses: Record<number, ResponseConfig> = {};
  for (const [key, texts] of Object.entries(messages)) {
    const status = Number(key) as ErrorStatus;
    const examples = Object.fromEntries(texts.map((reply) => [reply, { summary: reply, value: { reply } }]));
    responses[status] = { description: STATUS_DESCRIPTIONS[status], content: { "application/json": { schema: errorSchema, examples } } };
  }
  return responses;
}

const DESCRIPTION = `The ResortOS booking assistant: a chat API that books tables at Branch 1 and Branch 2. Guests don't sign in; they give an email and chat in plain language, then confirm before anything books.

**Route groups.** \`/agents/public\`: anyone, nothing is read (health, these docs). \`/agents/users\`: the chat checks (per-IP and per-email rate limits, body validation); no sign-in yet, so the guest's email travels in the body.

**Errors** are always \`{ "reply": string }\`, a sentence for the guest.`;

registry.registerPath({
  method: "get",
  path: "/agents/public/health",
  tags: ["Public"],
  summary: "Health check",
  description: "Always available; no sign-in.",
  responses: { 200: { description: "The server is up.", content: { "application/json": { schema: healthSchema, example: { status: "ok" } } } } },
});

registry.registerPath({
  method: "get",
  path: "/agents/public/docs",
  tags: ["Public"],
  summary: "Swagger UI: try the chat endpoint from the browser",
  description:
    "Anyone may open it (off in production unless `API_DOCS=true`). `/agents/public/docs` redirects to `/agents/public/docs/` so the page's files load.",
  responses: {
    200: { description: "The Swagger UI page.", content: { "text/html": { schema: z.string(), example: "<!DOCTYPE html><html>…swagger-ui…</html>" } } },
    301: { description: "Redirect from `/agents/public/docs` to `/agents/public/docs/`." },
  },
});

registry.registerPath({
  method: "get",
  path: "/agents/public/docs/openapi.json",
  tags: ["Public"],
  summary: "This OpenAPI 3.1 document",
  description: "Anyone may call it (off in production unless `API_DOCS=true`). Built from the same Zod schema that checks every chat request.",
  responses: {
    200: {
      description: "The OpenAPI document.",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()), example: { openapi: "3.1.0", info: { title: "ResortOS booking assistant" } } } },
    },
  },
});

const CHAT_REQUEST_EXAMPLE = { contact: { email: "guest@example.com" }, messages: [{ role: "user", content: "Table for 4 at Branch 1 Main Hall next Friday at 19:30" }] };
const NORMAL_REPLY_EXAMPLE = { reply: "Sittings run at 11:00, 13:30, 17:00 and 19:30, each 2.5 hours. Which would you like?" };
const READ_BACK_EXAMPLE = {
  reply: "Here's the booking: table for 4 at Branch 1, Main Hall, Friday 14 November at 19:30. Shall I book it?",
  pendingBooking: { draft: { branch: "BRANCH_1", sector: "MAIN_HALL", date: "2026-11-14", startTime: "19:30", partySize: 4 }, token: "1762999999999.MDEyMzQ1Njc4OWFiY2RlZg" },
};
const ALTERNATIVES_EXAMPLE = {
  reply: "There isn't room for 4 at 19:30 on Friday 14 November, and nothing nearby has space either. Try another date or a smaller group.",
  alternatives: [{ draft: { branch: "BRANCH_1", sector: "MAIN_HALL", date: "2026-11-14", startTime: "17:00", partySize: 4 }, token: "1762999999999.MDEyMzQ1Njc4OWFiY2RlZg" }],
};
const BOOKED_EXAMPLE = {
  reply: "You're booked: table for 4 at Branch 1, Main Hall, Friday 14 November at 19:30. Your code is RSV-7K3Q9X. Show it to the host when you arrive.",
  booking: { code: "RSV-7K3Q9X", slotStart: "2026-11-14T12:00:00.000Z", slotEnd: "2026-11-14T14:30:00.000Z", tableIds: ["tbl_1"] },
};

registry.registerPath({
  method: "post",
  path: "/agents/users/chats",
  tags: ["Users"],
  summary: "Run one chat turn",
  description:
    "No sign-in: the guest's email travels in the body. Validates the request, then either lets the model use its two tools (`checkAvailability`, `proposeBooking`) or, when `confirm` is sent back, books the signed draft it read back earlier.",
  request: { body: { required: true, content: { "application/json": { schema: chatRequestSchema, example: CHAT_REQUEST_EXAMPLE } } } },
  responses: {
    200: {
      description: "A reply. `pendingBooking` asks the guest to confirm; `alternatives` offers other sittings; `booking` means it was made.",
      content: {
        "application/json": {
          schema: chatResponseSchema,
          examples: {
            normalReply: { summary: "A normal reply", value: NORMAL_REPLY_EXAMPLE },
            readBack: { summary: "A read-back waiting for the guest's confirmation", value: READ_BACK_EXAMPLE },
            alternatives: { summary: "The sitting is full; other options are offered", value: ALTERNATIVES_EXAMPLE },
            booked: { summary: "The booking was made", value: BOOKED_EXAMPLE },
          },
        },
      },
    },
    ...errorResponses({
      400: [LAST_MESSAGE_MUST_BE_USER, EXPIRED],
      404: [NOT_FOUND_REPLY],
      429: [CHAT_LIMIT_REPLY, BOOKING_LIMIT_REPLY, SESSION_LIMIT_REPLY],
      500: [GENERIC_ERROR_REPLY],
      502: [API_DOWN, LLM_PROBLEM],
      503: [BUSY, UNAVAILABLE],
    }),
  },
});

/** Builds the whole document from every path registered above (call after this module has loaded). */
export function buildAgentDocument() {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "ResortOS booking assistant", version: "1.0.0", description: DESCRIPTION },
    tags: [
      { name: "Public", description: "No sign-in: health and these docs." },
      { name: "Users", description: "The chat endpoint. No sign-in yet; the guest's email travels in the body." },
    ],
  });
}

/** GET /agents/public/docs (Swagger UI) and /agents/public/docs/openapi.json. Mounted only when config.apiDocs. */
export const docsRouter = Router();

// Built on first use, after this module's registerPath calls above have run.
let document: ReturnType<typeof buildAgentDocument> | undefined;

docsRouter.get("/openapi.json", (_req, res) => {
  document ??= buildAgentDocument();
  res.json(document);
});

// The page loads its files with relative URLs ("./swagger-ui.css"), which only resolve under the trailing slash.
docsRouter.get(
  "/",
  (req, res, next) => {
    const [path, query] = req.originalUrl.split("?");
    if (!path.endsWith("/")) {
      res.redirect(301, `${path}/${query === undefined ? "" : `?${query}`}`);
      return;
    }
    next();
  },
  swaggerUi.setup(undefined, { swaggerUrl: "openapi.json", customSiteTitle: "ResortOS booking assistant" }),
);
docsRouter.use(swaggerUi.serve);
