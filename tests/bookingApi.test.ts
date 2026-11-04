import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BookingApiError, createBookingApi } from "../src/booking/bookingApi.ts";

type Handler = (url: string, init: RequestInit) => { status: number; body: unknown };

function fakeServer(handler: Handler) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const config = { baseUrl: "http://api.test", apiKey: "test-agent-key-test-agent-key-0001" };
const draft = { branch: "BRANCH_1", sector: "MAIN_HALL", date: "2026-12-24", startTime: "19:30", partySize: 4 } as const;

describe("booking API client", () => {
  it("reads availability without the API key", async () => {
    const { fetchImpl, calls } = fakeServer(() => ({ status: 200, body: [] }));
    await createBookingApi({ ...config, fetch: fetchImpl }).availability("BRANCH_2", "VIP_WING", "2026-12-24");
    assert.equal(calls[0].url, "http://api.test/api/availability?branch=BRANCH_2&sector=VIP_WING&date=2026-12-24");
    assert.equal(calls[0].headers["x-agent-key"], undefined);
    assert.equal(calls[0].headers.authorization, undefined);
  });

  it("sends X-Agent-Key on the assistant's calls and books with the idempotency key", async () => {
    const { fetchImpl, calls } = fakeServer(() => ({ status: 201, body: { code: "RSV-AAAAAA" } }));
    const api = createBookingApi({ ...config, fetch: fetchImpl });
    await api.book({ draft, email: "g@x.co", phone: "+62 811 000 111", clientIp: "1.2.3.4", idempotencyKey: "key-12345678" });
    await api.lookupGuest("g@x.co");
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace("http://api.test/api", "")}`), ["POST /agent/reservations", "POST /agent/guests/lookup"]);
    for (const call of calls) {
      assert.equal(call.headers["x-agent-key"], config.apiKey);
      assert.equal(call.headers.authorization, undefined);
    }
    assert.equal(calls[0].headers["idempotency-key"], "key-12345678");
    assert.deepEqual(calls[0].body, { ...draft, email: "g@x.co", phone: "+62 811 000 111", clientIp: "1.2.3.4" });
    assert.deepEqual(calls[1].body, { email: "g@x.co" });
  });

  it("surfaces a 401 for a wrong key without retrying", async () => {
    const { fetchImpl, calls } = fakeServer(() => ({ status: 401, body: { message: "Invalid API key" } }));
    await assert.rejects(createBookingApi({ ...config, fetch: fetchImpl }).lookupGuest("g@x.co"), { status: 401, message: "Invalid API key" });
    assert.equal(calls.length, 1);
  });

  it("surfaces the API's message and status, and network failures as status 0", async () => {
    const rule = fakeServer(() => ({ status: 400, body: { message: "Insufficient capacity for the selected slot" } }));
    await assert.rejects(createBookingApi({ ...config, fetch: rule.fetchImpl }).book({ draft, email: "g@x.co", idempotencyKey: "key-12345678" }), (err: unknown) => {
      assert.ok(err instanceof BookingApiError);
      assert.deepEqual([err.status, err.message], [400, "Insufficient capacity for the selected slot"]);
      return true;
    });
    const noMessage = fakeServer(() => ({ status: 401, body: {} }));
    await assert.rejects(createBookingApi({ ...config, fetch: noMessage.fetchImpl }).lookupGuest("g@x.co"), { status: 401, message: "Booking API returned HTTP 401" });
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(createBookingApi({ ...config, fetch: offline }).availability("BRANCH_1", "MAIN_HALL", "2026-12-24"), { status: 0 });
    const down = fakeServer(() => ({ status: 503, body: { message: "Service unavailable" } }));
    await assert.rejects(createBookingApi({ ...config, fetch: down.fetchImpl }).availability("BRANCH_1", "MAIN_HALL", "2026-12-24"), { status: 503 });
  });
});
