import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BookingApiError, type BookingApi } from "../src/booking/booking_api.ts";
import { signDraft, verifyDraft } from "../src/booking/draft_token.ts";
import { type Brain, type TurnTools, handleChat, REFUSAL } from "../src/chat.ts";
import type { BookingDraft, Reservation, Slot } from "../src/types/booking.ts";
import type { ChatMessage } from "../src/types/chat.ts";
import { LlmError } from "../src/types/llm.ts";

const SECRET = "test-draft-secret-123";
const now = () => new Date("2026-12-20T03:00:00Z"); // 10:00 local, Sun 20 Dec
const contact = { email: "guest@example.com", phone: "+62 811 000 111" };
const draft: BookingDraft = { branch: "BRANCH_1", sector: "MAIN_HALL", date: "2026-12-24", startTime: "19:30", partySize: 4 };
const ask = (content = "Table for 4 at Branch 1 Main Hall on 24 Dec at 19:30"): ChatMessage[] => [{ role: "user", content }];

/** A brain that runs a scripted sequence of tool calls, then returns text (optionally built from tool results). */
function scriptedBrain(script: (tools: TurnTools) => Promise<string>) {
  const seen: { messages: ChatMessage[]; today: unknown }[] = [];
  const brain: Brain = {
    async run(messages, tools, today) {
      seen.push({ messages, today });
      return script(tools);
    },
  };
  return { brain, seen };
}

function fakeApi(opts: { free?: number; upcoming?: number; limit?: number; bookError?: BookingApiError; availabilityError?: BookingApiError } = {}) {
  const booked: Parameters<BookingApi["book"]>[0][] = [];
  const api: BookingApi = {
    async availability(_branch, _sector, date): Promise<Slot[]> {
      if (opts.availabilityError) throw opts.availabilityError;
      return (["11:00", "13:30", "17:00", "19:30"] as const).map((startTime) => ({
        startTime, slotStart: `${date}T00:00:00Z`, slotEnd: "", totalUnits: 50,
        freeUnits: startTime === "19:30" ? (opts.free ?? 10) : 10, bookable: true,
      }));
    },
    async lookupGuest() {
      return { exists: (opts.upcoming ?? 0) > 0, upcomingAssistantBookings: opts.upcoming ?? 0, assistantBookingLimit: opts.limit ?? 1 };
    },
    async book(input): Promise<Reservation> {
      booked.push(input);
      if (opts.bookError) throw opts.bookError;
      return { id: "r1", code: "RSV-ABC234", branch: input.draft.branch, sector: input.draft.sector, slotStart: "2026-12-24T12:30:00.000Z", slotEnd: "2026-12-24T15:00:00.000Z", partySize: input.draft.partySize, tableIds: ["B1-MH-01", "B1-MH-02"] };
    },
  };
  return { api, booked };
}

function deps(brain: Brain, api: BookingApi, logs: string[] = []) {
  return { brain, api, draftSecret: SECRET, utcOffset: "+07:00", now, log: (line: string) => logs.push(line) };
}

describe("input validation", () => {
  const { brain } = scriptedBrain(async () => "hi");
  const { api } = fakeApi();
  const cases: [string, unknown][] = [
    ["no email", { contact: {}, messages: ask() }],
    ["bad email", { contact: { email: "nope" }, messages: ask() }],
    ["bad phone", { contact: { email: "a@b.co", phone: "call me" }, messages: ask() }],
    ["too many turns", { contact, messages: Array.from({ length: 31 }, () => ({ role: "user", content: "x" })) }],
    ["message too long", { contact, messages: ask("x".repeat(2001)) }],
    ["last message from assistant", { contact, messages: [{ role: "assistant", content: "hello" }] }],
    ["not an object", "hello"],
  ];
  for (const [name, body] of cases) {
    it(`rejects ${name} with 400`, async () => {
      const res = await handleChat(body, { clientIp: "1.2.3.4" }, deps(brain, api));
      assert.equal(res.status, 400);
      assert.equal(typeof res.body.reply, "string");
    });
  }
});

describe("a booking conversation", () => {
  it("reads back a signed draft and never shows the model the guest's email or phone", async () => {
    const { brain, seen } = scriptedBrain(async (tools) => {
      await tools.proposeBooking({ ...draft, specialRequests: "Window seat" });
      return "ignored";
    });
    const { api, booked } = fakeApi();
    const res = await handleChat({ contact, messages: ask() }, { clientIp: "1.2.3.4" }, deps(brain, api));

    assert.equal(res.status, 200);
    assert.equal(res.body.reply, "Here's the booking: 4 guests at Branch 1, Main Dining Hall, on Thu 24 Dec from 19:30 to 22:00 (note: Window seat). Shall I book it?");
    assert.deepEqual(res.body.pendingBooking?.draft, { ...draft, specialRequests: "Window seat" });
    assert.ok(verifyDraft(res.body.pendingBooking!.token, res.body.pendingBooking!.draft, contact.email, SECRET, now()));
    assert.equal(booked.length, 0, "nothing is booked until the guest confirms");
    assert.deepEqual(seen[0].today, { date: "2026-12-20", time: "10:00", weekday: "Sun" });
    const sentToModel = JSON.stringify(seen[0].messages);
    assert.ok(!sentToModel.includes(contact.email) && !sentToModel.includes("811"), "no PII reaches the model");
  });

  it("lets the model check availability and answer in plain sentences", async () => {
    let toolResult: unknown;
    const { brain } = scriptedBrain(async (tools) => {
      toolResult = await tools.checkAvailability({ branch: "BRANCH_1", sector: "MAIN_HALL", date: "2026-12-24" });
      return "Yes — there are tables at 19:30.\n\n| Sitting | Free |";
    });
    const res = await handleChat({ contact, messages: ask("Any tables on the 24th?") }, { clientIp: "1.2.3.4" }, deps(brain, fakeApi({ free: 3 }).api));
    assert.deepEqual(toolResult, {
      date: "2026-12-24",
      sittings: [
        { startTime: "11:00", free: 10, unit: "tables", bookable: true },
        { startTime: "13:30", free: 10, unit: "tables", bookable: true },
        { startTime: "17:00", free: 10, unit: "tables", bookable: true },
        { startTime: "19:30", free: 3, unit: "tables", bookable: true },
      ],
    });
    assert.equal(res.body.reply, "Yes, there are tables at 19:30.\n\n| Sitting | Free |".replace("| Sitting | Free |", "| Sitting | Free |"));
    assert.ok(!res.body.reply.includes("—"), "no em dashes reach the guest");
  });

  it("tells the model when availability is asked for a date outside the rules", async () => {
    let toolResult: unknown;
    const { brain } = scriptedBrain(async (tools) => {
      toolResult = await tools.checkAvailability({ branch: "BRANCH_1", sector: "MAIN_HALL", date: "2026-12-01" });
      return "That date has passed.";
    });
    await handleChat({ contact, messages: ask() }, { clientIp: "1.2.3.4" }, deps(brain, fakeApi().api));
    assert.deepEqual(toolResult, { ok: false, error: "That date has passed. Bookings open from today up to 60 days ahead." });
  });

  it("sends a proposeBooking refusal to the guest verbatim, even when the model says nothing after it", async () => {
    let toolResult: unknown;
    const { brain } = scriptedBrain(async (tools) => {
      toolResult = await tools.proposeBooking({ ...draft, partySize: 51 });
      return "";
    });
    const res = await handleChat({ contact, messages: ask() }, { clientIp: "1.2.3.4" }, deps(brain, fakeApi().api));
    assert.deepEqual(toolResult, { ok: false, error: "A booking can be for 1 to 50 guests." });
    assert.deepEqual(res, { status: 200, body: { reply: "A booking can be for 1 to 50 guests." } });

    const limited = await handleChat({ contact, messages: ask() }, { clientIp: "1.2.3.4" }, deps(scriptedBrain(async (tools) => (await tools.proposeBooking(draft), "")).brain, fakeApi({ upcoming: 1, limit: 1 }).api));
    assert.equal(limited.body.reply, "This email already has a booking made with the assistant. To book a different time, sign up with this email in the app, cancel that booking there, then ask me again.");
  });

  it("gives up on a turn that takes too long and says the assistant is busy", async () => {
    let aborted = false;
    const slow: Brain = {
      run: (_m, _t, _d, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    };
    const res = await handleChat({ contact, messages: ask() }, { clientIp: "1.2.3.4" }, { ...deps(slow, fakeApi().api), turnTimeoutMs: 30 });
    assert.deepEqual(res, { status: 503, retryAfterSeconds: undefined, body: { reply: "The assistant is busy. Please try again in a moment." } });
    assert.ok(aborted, "the model call is aborted, not left running");
  });

  it("logs one line per turn with the tools used and the time taken, never the message", async () => {
    const logs: string[] = [];
    const { brain } = scriptedBrain(async (tools) => {
      await tools.checkAvailability({ branch: "BRANCH_1", sector: "MAIN_HALL", date: "2026-12-24" });
      await tools.proposeBooking(draft);
      return "";
    });
    await handleChat({ contact, messages: ask("Table for 4, secret plans") }, { clientIp: "1.2.3.4" }, deps(brain, fakeApi().api, logs));
    assert.ok(logs.some((l) => /^turn tools=checkAvailability,proposeBooking ms=\d+ status=200$/.test(l)), logs.join(" / "));
    assert.ok(!logs.some((l) => l.includes("secret")));
  });

  it("warns before drafting when an email that hasn't signed up already has its 1 assistant booking", async () => {
    let toolResult: unknown;
    const { brain } = scriptedBrain(async (tools) => {
      toolResult = await tools.proposeBooking(draft);
      return "ignored";
    });
    await handleChat({ contact, messages: ask() }, { clientIp: "1.2.3.4" }, deps(brain, fakeApi({ upcoming: 1, limit: 1 }).api));
    assert.deepEqual(toolResult, { ok: false, error: "This email already has a booking made with the assistant. To book a different time, sign up with this email in the app, cancel that booking there, then ask me again." });
  });

  it("warns before drafting when a signed-up email already has 3 assistant bookings, and allows the 3rd", async () => {
    const results: unknown[] = [];
    const { brain } = scriptedBrain(async (tools) => {
      results.push(await tools.proposeBooking(draft));
      return "ignored";
    });
    await handleChat({ contact, messages: ask() }, { clientIp: "1.2.3.4" }, deps(brain, fakeApi({ upcoming: 3, limit: 3 }).api));
    const third = await handleChat({ contact, messages: ask() }, { clientIp: "1.2.3.4" }, deps(brain, fakeApi({ upcoming: 2, limit: 3 }).api));
    assert.deepEqual(results[0], { ok: false, error: "This email already has 3 upcoming assistant bookings. Sign in to manage them." });
    assert.ok(third.body.pendingBooking);
  });

  it("offers signed alternatives when the sitting is full", async () => {
    const { brain } = scriptedBrain(async (tools) => {
      await tools.proposeBooking(draft);
      return "ignored";
    });
    const res = await handleChat({ contact, messages: ask() }, { clientIp: "1.2.3.4" }, deps(brain, fakeApi({ free: 1 }).api));
    assert.equal(res.body.pendingBooking, undefined);
    assert.deepEqual(res.body.alternatives?.map((a) => a.draft.startTime), ["17:00", "13:30", "11:00"]);
    assert.ok(res.body.alternatives!.every((a) => verifyDraft(a.token, a.draft, contact.email, SECRET, now())));
    assert.equal(
      res.body.reply,
      "There isn't room for 4 guests at 19:30 on Thu 24 Dec. These sittings have space:\n" +
        "1. 4 guests at Branch 1, Main Dining Hall, on Thu 24 Dec from 17:00 to 19:30\n" +
        "2. 4 guests at Branch 1, Main Dining Hall, on Thu 24 Dec from 13:30 to 16:00\n" +
        "3. 4 guests at Branch 1, Main Dining Hall, on Thu 24 Dec from 11:00 to 13:30\n" +
        "Pick one to book it.",
    );
  });

  it("says so when nothing nearby can seat the party", async () => {
    const empty: BookingApi = { ...fakeApi().api, availability: async (_b, _s, date) => (["11:00", "13:30", "17:00", "19:30"] as const).map((startTime) => ({ startTime, slotStart: date, slotEnd: "", totalUnits: 4, freeUnits: 0, bookable: true })) };
    const { brain } = scriptedBrain(async (tools) => {
      await tools.proposeBooking(draft);
      return "ignored";
    });
    const res = await handleChat({ contact, messages: ask() }, { clientIp: "1.2.3.4" }, deps(brain, empty));
    assert.equal(res.body.reply, "There isn't room for 4 guests at 19:30 on Thu 24 Dec, and nothing nearby has space either. Try another date or a smaller group.");
    assert.deepEqual(res.body.alternatives, []);
  });
});

describe("only booking topics", () => {
  it("answers anything else with the fixed refusal and logs the topic", async () => {
    const logs: string[] = [];
    const { brain } = scriptedBrain(async (tools) => {
      await tools.notSupportedYet({ topic: "poetry" });
      return "Here is a poem about the sea...";
    });
    const res = await handleChat({ contact, messages: ask("Write me a poem") }, { clientIp: "1.2.3.4" }, deps(brain, fakeApi().api, logs));
    assert.deepEqual(res, { status: 200, body: { reply: REFUSAL } });
    assert.ok(logs.some((l) => l.includes("not_supported") && l.includes("poetry")));
    assert.ok(!logs.some((l) => l.includes("Write me a poem")), "chat content is never logged");
  });

  it("falls back to a rephrase prompt when the model returns nothing", async () => {
    const { brain } = scriptedBrain(async () => "   ");
    const res = await handleChat({ contact, messages: ask() }, { clientIp: "1.2.3.4" }, deps(brain, fakeApi().api));
    assert.equal(res.body.reply, "Sorry, I didn't catch that. Could you tell me the branch, room, date, time and number of guests?");
  });
});

describe("confirming a booking", () => {
  const confirmBody = (d: BookingDraft = draft, token = signDraft(d, contact.email, SECRET, now())) => ({ contact, messages: ask("yes"), confirm: { draft: d, token } });
  const noBrain: Brain = { run: async () => assert.fail("the model must not run on confirm") };

  it("books exactly the signed draft once, with the token as Idempotency-Key, without calling the model", async () => {
    const { api, booked } = fakeApi();
    const body = confirmBody();
    const res = await handleChat(body, { clientIp: "203.0.113.9" }, deps(noBrain, api));
    assert.equal(res.status, 200);
    assert.deepEqual(booked, [{ draft, email: contact.email, phone: contact.phone, clientIp: "203.0.113.9", idempotencyKey: body.confirm.token }]);
    assert.deepEqual(res.body.booking, { code: "RSV-ABC234", slotStart: "2026-12-24T12:30:00.000Z", slotEnd: "2026-12-24T15:00:00.000Z", tableIds: ["B1-MH-01", "B1-MH-02"] });
    assert.equal(res.body.reply, "You're booked: 4 guests at Branch 1, Main Dining Hall, on Thu 24 Dec from 19:30 to 22:00. Your code is RSV-ABC234. Show it to the host when you arrive.");
  });

  it("refuses a tampered or expired draft without calling the API", async () => {
    const { api, booked } = fakeApi();
    const token = signDraft(draft, contact.email, SECRET, now());
    for (const body of [
      { ...confirmBody(), confirm: { draft: { ...draft, partySize: 40 }, token } },
      { ...confirmBody(), contact: { email: "someone-else@example.com" } },
      confirmBody(draft, signDraft(draft, contact.email, SECRET, new Date(now().getTime() - 16 * 60_000))),
    ]) {
      const res = await handleChat(body, { clientIp: "1.2.3.4" }, deps(noBrain, api));
      assert.equal(res.status, 400);
      assert.equal(res.body.reply, "Those booking details changed or expired. Please ask again.");
    }
    assert.equal(booked.length, 0);
  });

  it("re-checks the rules at confirm time", async () => {
    const today = { ...draft, date: "2026-12-20", startTime: "11:00" as const };
    const lateNow = () => new Date("2026-12-20T04:30:00Z");
    const token = signDraft(today, contact.email, SECRET, new Date("2026-12-20T04:20:00Z"));
    const { api, booked } = fakeApi();
    const res = await handleChat({ contact, messages: ask("yes"), confirm: { draft: today, token } }, { clientIp: "1.2.3.4" }, { ...deps(noBrain, api), now: lateNow });
    assert.equal(res.body.reply, "That sitting has already started. Please pick a later one.");
    assert.equal(booked.length, 0);
  });

  it("offers alternatives when the last tables went between read-back and confirm", async () => {
    const { api } = fakeApi({ free: 0, bookError: new BookingApiError(400, "Insufficient capacity for the selected slot") });
    const res = await handleChat(confirmBody(), { clientIp: "1.2.3.4" }, deps(noBrain, api));
    assert.equal(res.status, 200);
    assert.ok(res.body.reply.startsWith("Someone just took the last space at 19:30 on Thu 24 Dec. These sittings have space:"));
    assert.equal(res.body.alternatives?.length, 3);
    const overlap = fakeApi({ free: 0, bookError: new BookingApiError(400, "Table overlap conflict, please try again") });
    assert.ok((await handleChat(confirmBody(), { clientIp: "1.2.3.4" }, deps(noBrain, overlap.api))).body.reply.startsWith("Someone just took"));
  });

  it("passes both per-email limit messages to the guest", async () => {
    for (const message of ["This email already has a booking made with the assistant. To book a different time, sign up with this email in the app, cancel that booking there, then ask me again.", "This email already has 3 upcoming assistant bookings. Sign in to manage them."]) {
      const { api } = fakeApi({ bookError: new BookingApiError(400, message) });
      const res = await handleChat(confirmBody(), { clientIp: "1.2.3.4" }, deps(noBrain, api));
      assert.deepEqual(res, { status: 200, body: { reply: message } });
    }
  });

  it("gives one generic reply for any other API refusal, so replies can't reveal what kind of account an email has", async () => {
    for (const message of ["This email can't be booked through the assistant", "Idempotency-Key was already used for another booking", "Something unexpected"]) {
      const { api } = fakeApi({ bookError: new BookingApiError(400, message) });
      const res = await handleChat(confirmBody(), { clientIp: "1.2.3.4" }, deps(noBrain, api));
      assert.deepEqual(res, { status: 200, body: { reply: "That booking couldn't be made. Please try another time, or book in the app." } });
    }
  });
});

describe("failures", () => {
  it("says nothing was booked when the booking API is down", async () => {
    const down = new BookingApiError(0, "Booking API unreachable");
    const { api } = fakeApi({ bookError: down });
    const confirm = { draft, token: signDraft(draft, contact.email, SECRET, now()) };
    const res = await handleChat({ contact, messages: ask("yes"), confirm }, { clientIp: "1.2.3.4" }, deps({ run: async () => "" }, api));
    assert.deepEqual(res, { status: 502, body: { reply: "The booking system isn't responding. Nothing was booked; please try again in a minute." } });

    const { brain } = scriptedBrain(async (tools) => {
      await tools.checkAvailability({ branch: "BRANCH_1", sector: "MAIN_HALL", date: "2026-12-24" });
      return "";
    });
    const viaTool = await handleChat({ contact, messages: ask() }, { clientIp: "1.2.3.4" }, deps(brain, fakeApi({ availabilityError: new BookingApiError(503, "down") }).api));
    assert.equal(viaTool.status, 502);
  });

  it("maps model errors to busy (503 + Retry-After), unavailable (503) or a generic 502", async () => {
    const run = (err: Error) => handleChat({ contact, messages: ask() }, { clientIp: "1.2.3.4" }, deps({ run: async () => Promise.reject(err) }, fakeApi().api));
    assert.deepEqual(await run(new LlmError(429, "rate_limited", "slow down", 12)), { status: 503, retryAfterSeconds: 12, body: { reply: "The assistant is busy. Please try again in a moment." } });
    assert.deepEqual(await run(new LlmError(0, "timeout", "timed out")), { status: 503, retryAfterSeconds: undefined, body: { reply: "The assistant is busy. Please try again in a moment." } });
    assert.deepEqual(await run(new LlmError(429, "project_budget_exceeded", "budget")), { status: 503, body: { reply: "The assistant is unavailable right now. You can still book in the app." } });
    assert.deepEqual(await run(new LlmError(401, "invalid_api_key", "bad key")), { status: 502, body: { reply: "The assistant had a problem. Please try again." } });
    await assert.rejects(run(new TypeError("a bug")), TypeError);
  });
});
