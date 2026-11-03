import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BookingApiError, createBookingApi } from "../src/booking/booking_api.ts";

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

const config = { baseUrl: "http://api.test", email: "assistant@resortos.internal", password: "secret" };
const draft = { branch: "BRANCH_1", sector: "MAIN_HALL", date: "2026-12-24", startTime: "19:30", partySize: 4 } as const;

describe("booking API client", () => {
  it("reads availability without signing in", async () => {
    const { fetchImpl, calls } = fakeServer(() => ({ status: 200, body: [] }));
    await createBookingApi({ ...config, fetch: fetchImpl }).availability("BRANCH_2", "VIP_WING", "2026-12-24");
    assert.equal(calls[0].url, "http://api.test/api/availability?branch=BRANCH_2&sector=VIP_WING&date=2026-12-24");
    assert.equal(calls[0].headers.authorization, undefined);
  });

  it("signs in once as the assistant and books with the idempotency key", async () => {
    const { fetchImpl, calls } = fakeServer((url) =>
      url.endsWith("/auth/login") ? { status: 200, body: { accessToken: "t1" } } : { status: 201, body: { code: "RSV-AAAAAA" } },
    );
    const api = createBookingApi({ ...config, fetch: fetchImpl });
    await api.book({ draft, email: "g@x.co", phone: "+62 811 000 111", clientIp: "1.2.3.4", idempotencyKey: "key-12345678" });
    await api.lookupGuest("g@x.co");
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace("http://api.test/api", "")}`), ["POST /auth/login", "POST /agent/reservations", "POST /agent/guests/lookup"]);
    assert.deepEqual(calls[0].body, { email: config.email, password: config.password });
    assert.equal(calls[1].headers.authorization, "Bearer t1");
    assert.equal(calls[1].headers["idempotency-key"], "key-12345678");
    assert.deepEqual(calls[1].body, { ...draft, email: "g@x.co", phone: "+62 811 000 111", clientIp: "1.2.3.4" });
    assert.deepEqual(calls[2].body, { email: "g@x.co" });
  });

  it("signs in again when the token has expired", async () => {
    let logins = 0;
    let rejected = false;
    const { fetchImpl } = fakeServer((url) => {
      if (url.endsWith("/auth/login")) return { status: 200, body: { accessToken: `t${++logins}` } };
      if (!rejected) {
        rejected = true;
        return { status: 401, body: { message: "Invalid or expired token" } };
      }
      return { status: 200, body: { exists: false, upcomingAssistantBookings: 0 } };
    });
    assert.deepEqual(await createBookingApi({ ...config, fetch: fetchImpl }).lookupGuest("g@x.co"), { exists: false, upcomingAssistantBookings: 0 });
    assert.equal(logins, 2);
  });

  it("surfaces the API's message and status, and network failures as status 0", async () => {
    const rule = fakeServer((url) => (url.endsWith("/auth/login") ? { status: 200, body: { accessToken: "t" } } : { status: 400, body: { message: "Insufficient capacity for the selected slot" } }));
    await assert.rejects(createBookingApi({ ...config, fetch: rule.fetchImpl }).book({ draft, email: "g@x.co", idempotencyKey: "key-12345678" }), (err: unknown) => {
      assert.ok(err instanceof BookingApiError);
      assert.deepEqual([err.status, err.message], [400, "Insufficient capacity for the selected slot"]);
      return true;
    });
    const badLogin = fakeServer(() => ({ status: 401, body: {} }));
    await assert.rejects(createBookingApi({ ...config, fetch: badLogin.fetchImpl }).lookupGuest("g@x.co"), { status: 401, message: "Booking API returned HTTP 401" });
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(createBookingApi({ ...config, fetch: offline }).availability("BRANCH_1", "MAIN_HALL", "2026-12-24"), { status: 0 });
    const down = fakeServer(() => ({ status: 503, body: { message: "Service unavailable" } }));
    await assert.rejects(createBookingApi({ ...config, fetch: down.fetchImpl }).availability("BRANCH_1", "MAIN_HALL", "2026-12-24"), { status: 503 });
  });
});
