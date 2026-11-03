import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { ChatResult } from "../src/chat.ts";
import { createServer, type ServerDeps } from "../src/server.ts";

async function withServer(deps: Partial<ServerDeps>, run: (url: string) => Promise<void>) {
  const app = createServer({ handleChat: async () => ({ status: 200, body: { reply: "ok" } }), log: () => {}, ...deps });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

const post = (url: string, body: unknown, raw = false) =>
  fetch(`${url}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: raw ? (body as string) : JSON.stringify(body) });

describe("agent HTTP server", () => {
  it("answers health checks and passes chat to the handler with the client IP", async () => {
    const seen: { body: unknown; ip?: string }[] = [];
    await withServer({ handleChat: async (body, req) => (seen.push({ body, ip: req.clientIp }), { status: 200, body: { reply: "hi" } }) }, async (url) => {
      assert.deepEqual(await (await fetch(`${url}/health`)).json(), { status: "ok" });
      const res = await post(url, { contact: { email: "a@b.co" }, messages: [] });
      assert.deepEqual([res.status, await res.json()], [200, { reply: "hi" }]);
      assert.equal(res.headers.get("x-powered-by"), null);
    });
    assert.deepEqual(seen[0].body, { contact: { email: "a@b.co" }, messages: [] });
    assert.match(seen[0].ip ?? "", /127\.0\.0\.1/);
  });

  it("sets Retry-After when the assistant is busy", async () => {
    const busy: ChatResult = { status: 503, retryAfterSeconds: 7, body: { reply: "busy" } };
    await withServer({ handleChat: async () => busy }, async (url) => {
      const res = await post(url, {});
      assert.deepEqual([res.status, res.headers.get("retry-after")], [503, "7"]);
    });
  });

  it("limits chat per minute and bookings per hour separately", async () => {
    await withServer({ limits: { chatPerMinute: 3, bookingsPerHour: 1, perSession: 100 } }, async (url) => {
      assert.equal((await post(url, { confirm: {} })).status, 200);
      const secondBooking = await post(url, { confirm: {} });
      assert.deepEqual([secondBooking.status, await secondBooking.json()], [429, { reply: "Too many bookings from this connection. Please try again later or book in the app." }]);
      assert.equal((await post(url, { messages: [] })).status, 200, "plain chat isn't counted as a booking");
      const tooMany = await post(url, { messages: [] });
      assert.deepEqual([tooMany.status, await tooMany.json()], [429, { reply: "Too many messages. Please wait a minute and try again." }]);
    });
  });

  it("limits one chat session (email) across connections", async () => {
    await withServer({ limits: { chatPerMinute: 100, bookingsPerHour: 100, perSession: 2 } }, async (url) => {
      const as = (email: string) => post(url, { contact: { email }, messages: [] });
      assert.equal((await as("Guest@Example.com")).status, 200);
      assert.equal((await as("guest@example.com")).status, 200);
      const third = await as("guest@example.com");
      assert.deepEqual([third.status, await third.json()], [429, { reply: "You've sent a lot of messages. Please wait a while and try again." }]);
      assert.equal((await as("someone-else@example.com")).status, 200, "other sessions aren't affected");
      assert.equal((await post(url, { messages: [] })).status, 200, "requests without an email are left to validation");
    });
  });

  it("rejects malformed JSON, unknown routes, and hides unexpected errors without logging chat content", async () => {
    const logs: string[] = [];
    await withServer({ log: (l) => logs.push(l), handleChat: async () => Promise.reject(new TypeError("boom")) }, async (url) => {
      assert.deepEqual(await (await post(url, "{oops", true)).json(), { reply: "Invalid request: the body must be JSON" });
      assert.equal((await fetch(`${url}/nope`)).status, 404);
      const res = await post(url, { messages: [{ role: "user", content: "my secret plans" }] });
      assert.deepEqual([res.status, await res.json()], [500, { reply: "Something went wrong. Nothing was booked; please try again." }]);
    });
    assert.deepEqual(logs, ["chat error=TypeError"]);
  });
});
