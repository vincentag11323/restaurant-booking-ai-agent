// One chat turn: validate, then either confirm a signed draft (no model call) or let the model use the
// booking tools. Replies that matter (read-back, alternatives, confirmation, refusal) come from templates,
// so they're exact and never depend on model wording.
import { z } from "zod";
import { findAlternatives } from "./booking/alternatives.ts";
import { BookingApiError, type BookingApi } from "./booking/booking_api.ts";
import { signDraft, verifyDraft } from "./booking/draft_token.ts";
import { describeDraft, formatDay, guests, localNow, unitsNeeded, validateDate, validateDraft } from "./booking/rules.ts";
import { BRANCHES, type BookingDraft, SECTORS, SLOT_START_TIMES } from "./types/booking.ts";
import type { ChatMessage, ChatResponse, PendingBooking } from "./types/chat.ts";
import { LlmError } from "./types/llm.ts";

export const REFUSAL = "I can only help with table bookings at ResortOS Dining.";
const FALLBACK = "Sorry, I didn't catch that. Could you tell me the branch, room, date, time and number of guests?";
const EXPIRED = "Those booking details changed or expired. Please ask again.";
const API_DOWN = "The booking system isn't responding. Nothing was booked; please try again in a minute.";
const BUSY = "The assistant is busy. Please try again in a moment.";
const UNAVAILABLE = "The assistant is unavailable right now. You can still book in the app.";
const LLM_PROBLEM = "The assistant had a problem. Please try again.";
// The booking API's per-email limits (agent_spec.md §5.4). Safe to show: they only concern the email the guest typed.
const LIMIT_NOT_SIGNED_UP = "This email already has a booking made with the assistant. To book a different time, sign up with this email in the app, cancel that booking there, then ask me again.";
const LIMIT_SIGNED_UP = "This email already has 3 upcoming assistant bookings. Sign in to manage them.";
const NOT_BOOKED = "That booking couldn't be made. Please try another time, or book in the app.";


/** The tools the model may call. Results go back to the model; side effects stay in this turn. */
export interface TurnTools {
  checkAvailability(input: unknown): Promise<unknown>;
  proposeBooking(input: unknown): Promise<unknown>;
  notSupportedYet(input: unknown): Promise<unknown>;
}

/** Runs the model with the tools. Production: Mastra (src/agent/mastra_brain.ts). Tests: a scripted fake. */
export interface Brain {
  run(messages: ChatMessage[], tools: TurnTools, today: { date: string; time: string; weekday: string }): Promise<string>;
}

export interface ChatDeps {
  brain: Brain;
  api: BookingApi;
  draftSecret: string;
  utcOffset: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ChatResult {
  status: number;
  body: ChatResponse;
  retryAfterSeconds?: number;
}

const draftSchema = z.object({
  branch: z.enum(BRANCHES),
  sector: z.enum(SECTORS),
  date: z.string(),
  startTime: z.enum(SLOT_START_TIMES),
  partySize: z.number(),
  specialRequests: z.string().trim().max(500).optional().transform((s) => s || undefined),
});

const requestSchema = z.object({
  contact: z.object({
    email: z.email().max(254),
    phone: z.string().trim().regex(/^\+?[0-9 -]{6,20}$/, "Invalid phone number").optional(),
  }),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) })).min(1).max(30),
  confirm: z.object({ draft: draftSchema, token: z.string().max(200) }).optional(),
});

/** Guest-facing text never carries em dashes (antislop R-02). */
function tidy(text: string): string {
  return text.replace(/\s*—\s*/g, ", ").trim();
}

function listAlternatives(intro: string, alternatives: PendingBooking[]): string {
  if (alternatives.length === 0) return `${intro}, and nothing nearby has space either. Try another date or a smaller group.`;
  const lines = alternatives.map((a, i) => `${i + 1}. ${describeDraft(a.draft)}`);
  return `${intro}. These sittings have space:\n${lines.join("\n")}\nPick one to book it.`;
}

function mapLlmError(err: LlmError): ChatResult {
  if (err.code === "project_budget_exceeded" || err.code === "key_limit_exceeded") return { status: 503, body: { reply: UNAVAILABLE } };
  if (err.retryable) return { status: 503, retryAfterSeconds: err.retryAfterSeconds, body: { reply: BUSY } };
  return { status: 502, body: { reply: LLM_PROBLEM } };
}

export async function handleChat(raw: unknown, request: { clientIp?: string }, deps: ChatDeps): Promise<ChatResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { reply: `Invalid request: ${parsed.error.issues[0].message}` } };
  const { contact, messages, confirm } = parsed.data;
  const email = contact.email.toLowerCase();

  const sign = (draft: BookingDraft): PendingBooking => ({ draft, token: signDraft(draft, email, deps.draftSecret, now()) });
  const alternativesFor = async (draft: BookingDraft) =>
    (await findAlternatives((b, s, d) => deps.api.availability(b, s, d), draft, deps.utcOffset, now())).map(sign);

  try {
    if (confirm) return await confirmBooking(confirm, email, contact.phone, request.clientIp, deps, now, alternativesFor, log);
    if (messages.at(-1)?.role !== "user") return { status: 400, body: { reply: "Invalid request: the last message must be from the guest" } };

    // What the tools learned this turn. The reply is decided from this, not from model text, when it matters.
    const turn: { draft?: BookingDraft; full?: { draft: BookingDraft; alternatives: PendingBooking[] }; topic?: string } = {};
    const tools: TurnTools = {
      async checkAvailability(input) {
        const args = z.object({ branch: z.enum(BRANCHES), sector: z.enum(SECTORS), date: z.string() }).safeParse(input);
        if (!args.success) return { ok: false, error: "I need a branch, a room and a date." };
        const problem = validateDate(args.data.date, deps.utcOffset, now());
        if (problem) return { ok: false, error: problem };
        const slots = await deps.api.availability(args.data.branch, args.data.sector, args.data.date);
        const unit = args.data.sector === "MAIN_HALL" ? "tables" : "rooms";
        return { date: args.data.date, sittings: slots.map((s) => ({ startTime: s.startTime, free: s.freeUnits, unit, bookable: s.bookable })) };
      },
      async proposeBooking(input) {
        const args = draftSchema.safeParse(input);
        if (!args.success) return { ok: false, error: "I need the branch, room, date, sitting time and number of guests." };
        const draft = args.data;
        const problem = validateDraft(draft, deps.utcOffset, now());
        if (problem) return { ok: false, error: problem };
        const guest = await deps.api.lookupGuest(email);
        if (guest.upcomingAssistantBookings >= guest.assistantBookingLimit) {
          return { ok: false, error: guest.assistantBookingLimit === 1 ? LIMIT_NOT_SIGNED_UP : LIMIT_SIGNED_UP };
        }
        const slot = (await deps.api.availability(draft.branch, draft.sector, draft.date)).find((s) => s.startTime === draft.startTime);
        if (!slot?.bookable || slot.freeUnits < unitsNeeded(draft.sector, draft.partySize)) {
          turn.full = { draft, alternatives: await alternativesFor(draft) };
          return { ok: false, error: "That sitting can't seat the party. Alternatives were shown to the guest." };
        }
        turn.draft = draft;
        return { ok: true, readBack: describeDraft(draft) };
      },
      async notSupportedYet(input) {
        turn.topic = z.object({ topic: z.string().max(60) }).safeParse(input).data?.topic ?? "unknown";
        return { ok: true };
      },
    };

    const text = await deps.brain.run(messages, tools, localNow(deps.utcOffset, now()));

    if (turn.topic) {
      log(`not_supported topic=${JSON.stringify(turn.topic)}`);
      return { status: 200, body: { reply: REFUSAL } };
    }
    if (turn.draft) {
      return { status: 200, body: { reply: `Here's the booking: ${describeDraft(turn.draft)}. Shall I book it?`, pendingBooking: sign(turn.draft) } };
    }
    if (turn.full) {
      const { draft, alternatives } = turn.full;
      const intro = `There isn't room for ${guests(draft.partySize)} at ${draft.startTime} on ${formatDay(draft.date)}`;
      return { status: 200, body: { reply: listAlternatives(intro, alternatives), alternatives } };
    }
    return { status: 200, body: { reply: tidy(text) || FALLBACK } };
  } catch (err) {
    if (err instanceof BookingApiError) return { status: 502, body: { reply: API_DOWN } };
    if (err instanceof LlmError) return mapLlmError(err);
    throw err;
  }
}

async function confirmBooking(
  confirm: PendingBooking,
  email: string,
  phone: string | undefined,
  clientIp: string | undefined,
  deps: ChatDeps,
  now: () => Date,
  alternativesFor: (draft: BookingDraft) => Promise<PendingBooking[]>,
  log: (line: string) => void,
): Promise<ChatResult> {
  const { draft, token } = confirm;
  if (!verifyDraft(token, draft, email, deps.draftSecret, now())) return { status: 400, body: { reply: EXPIRED } };
  const problem = validateDraft(draft, deps.utcOffset, now());
  if (problem) return { status: 200, body: { reply: problem } };

  try {
    const booking = await deps.api.book({ draft, email, phone, clientIp, idempotencyKey: token });
    log(`booked code=${booking.code}`);
    return {
      status: 200,
      body: {
        reply: `You're booked: ${describeDraft(draft)}. Your code is ${booking.code}. Show it to the host when you arrive.`,
        booking: { code: booking.code, slotStart: booking.slotStart, slotEnd: booking.slotEnd, tableIds: booking.tableIds },
      },
    };
  } catch (err) {
    if (!(err instanceof BookingApiError) || err.status !== 400) throw err;
    // The sitting filled between read-back and confirm: offer what's still free.
    if (err.message === "Insufficient capacity for the selected slot" || err.message === "Table overlap conflict, please try again") {
      const alternatives = await alternativesFor(draft);
      const intro = `Someone just took the last space at ${draft.startTime} on ${formatDay(draft.date)}`;
      return { status: 200, body: { reply: listAlternatives(intro, alternatives), alternatives } };
    }
    // Any other refusal gets one generic reply, so the wording can't reveal what kind of account an email has.
    const limitMessage = err.message === LIMIT_NOT_SIGNED_UP || err.message === LIMIT_SIGNED_UP;
    return { status: 200, body: { reply: limitMessage ? err.message : NOT_BOOKED } };
  }
}
