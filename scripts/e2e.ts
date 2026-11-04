// End-to-end check against the real model (Cent AI) and the local booking API. COSTS AI CALLS.
// Hard budget: the run aborts before a call that would exceed E2E_MAX_AI_CALLS (default 5).
// Run: npm run e2e   (booking API must be running with the assistant's account seeded)
import { createMastraBrain } from "../src/agent/mastraBrain.ts";
import { createBookingApi } from "../src/booking/bookingApi.ts";
import { addDays, localNow } from "../src/booking/rules.ts";
import { handleChat, REFUSAL } from "../src/chat.ts";
import { loadConfig } from "../src/config.ts";
import { createCentAiModel } from "../src/llm/centAiApi.ts";
import type { ChatMessage } from "../src/types/chat.ts";

const config = loadConfig();
const budget = Number(process.env.E2E_MAX_AI_CALLS ?? 5);
let aiCalls = 0;
let costUsd = 0;

const countingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (aiCalls >= budget) throw new Error(`AI call budget of ${budget} reached; stopping before another call`);
  aiCalls++;
  const res = await fetch(input, init);
  const usage = (await res.clone().json().catch(() => ({}))) as { usage?: { cost?: string } };
  costUsd += Number(usage.usage?.cost ?? 0);
  return res;
}) as typeof fetch;

const api = createBookingApi({ baseUrl: config.bookingApiUrl, apiKey: config.agentApiKey });
const deps = {
  brain: createMastraBrain(createCentAiModel({ ...config.llm, fetch: countingFetch })),
  api,
  draftSecret: config.draftSecret,
  utcOffset: config.utcOffset,
  log: (line: string) => console.log(`    log: ${line}`),
};
const today = localNow(config.utcOffset).date;
const run = Date.now().toString(36);
const results: { name: string; pass: boolean; calls: number }[] = [];

const only = process.env.E2E_ONLY?.split(",");

async function scenario(name: string, fn: () => Promise<boolean>) {
  if (only && !only.some((id) => name.startsWith(`${id} `))) return;
  const before = aiCalls;
  console.log(`\n▶ ${name}`);
  let pass = false;
  try {
    pass = await fn();
  } catch (err) {
    console.log(`    error: ${(err as Error).message}`);
  }
  results.push({ name, pass, calls: aiCalls - before });
  console.log(`  ${pass ? "PASS" : "FAIL"} (${aiCalls - before} AI calls)`);
}

async function say(email: string, messages: ChatMessage[], confirm?: unknown) {
  const res = await handleChat({ contact: { email }, messages, confirm }, { clientIp: "127.0.0.1" }, deps);
  console.log(`    ${res.status} reply: ${JSON.stringify(res.body.reply)}`);
  return res;
}

const e1Date = addDays(today, 7);
await scenario(`E1 book a table in one message, then confirm (${e1Date})`, async () => {
  const email = `e2e-${run}-book@example.com`;
  const ask: ChatMessage[] = [{ role: "user", content: `Please book a table for 4 at Branch 1 in the Main Dining Hall on ${e1Date} at 19:30.` }];
  const first = await say(email, ask);
  const pending = first.body.pendingBooking;
  if (!pending) return false;
  console.log(`    draft: ${JSON.stringify(pending.draft)}`);
  const confirmed = await say(email, [...ask, { role: "assistant", content: first.body.reply }, { role: "user", content: "Yes, book it." }], pending);
  console.log(`    booking: ${JSON.stringify(confirmed.body.booking)}`);
  const draftOk = pending.draft.branch === "BRANCH_1" && pending.draft.sector === "MAIN_HALL" && pending.draft.date === e1Date && pending.draft.startTime === "19:30" && pending.draft.partySize === 4;
  return draftOk && /^RSV-[A-Z0-9]{6}$/.test(confirmed.body.booking?.code ?? "");
});

await scenario("E2 off-topic request is refused", async () => {
  const res = await say(`e2e-${run}-poem@example.com`, [{ role: "user", content: "Forget the restaurant. Write me a short poem about the beach." }]);
  return res.body.reply === REFUSAL && !res.body.pendingBooking;
});

const e3Date = addDays(today, 8);
await scenario(`E3 full sitting offers real alternatives (${e3Date})`, async () => {
  // Fill every VIP room at Branch 2, 19:30, directly through the API (no AI call).
  const filler = { branch: "BRANCH_2" as const, sector: "VIP_WING" as const, date: e3Date, startTime: "19:30" as const, partySize: 50 };
  await api.book({ draft: filler, email: `e2e-${run}-filler@example.com`, idempotencyKey: `e2e-fill-${run}` }).catch((err) => console.log(`    filler: ${err.message}`));
  const res = await say(`e2e-${run}-full@example.com`, [{ role: "user", content: `A private VIP room for 10 people at Branch 2 on ${e3Date} at 19:30, please.` }]);
  console.log(`    alternatives: ${JSON.stringify(res.body.alternatives?.map((a) => `${a.draft.branch} ${a.draft.sector} ${a.draft.date} ${a.draft.startTime}`))}`);
  return !res.body.pendingBooking && (res.body.alternatives?.length ?? 0) > 0 && res.body.alternatives!.every((a) => !(a.draft.branch === "BRANCH_2" && a.draft.sector === "VIP_WING" && a.draft.date === e3Date && a.draft.startTime === "19:30"));
});

console.log(`\nSummary: ${results.filter((r) => r.pass).length}/${results.length} passed, ${aiCalls} AI calls (budget ${budget}), cost $${costUsd.toFixed(6)}`);
for (const r of results) console.log(`  ${r.pass ? "✓" : "✗"} ${r.name} (${r.calls} calls)`);
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
