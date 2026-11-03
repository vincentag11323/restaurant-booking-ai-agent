import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signDraft, verifyDraft } from "../src/booking/draft_token.ts";
import type { BookingDraft } from "../src/types/booking.ts";

const secret = "test-secret-test-secret";
const draft: BookingDraft = { branch: "BRANCH_2", sector: "VIP_WING", date: "2026-12-24", startTime: "17:00", partySize: 9 };
const now = new Date("2026-12-20T03:00:00Z");

describe("draft token", () => {
  it("verifies the same draft for the same email within 15 minutes", () => {
    const token = signDraft(draft, "guest@example.com", secret, now);
    assert.equal(verifyDraft(token, { ...draft }, "GUEST@example.com", secret, new Date(now.getTime() + 14 * 60_000)), true);
  });

  it("rejects a changed draft, another email, another secret, an expired or malformed token", () => {
    const token = signDraft(draft, "guest@example.com", secret, now);
    assert.equal(verifyDraft(token, { ...draft, partySize: 10 }, "guest@example.com", secret, now), false);
    assert.equal(verifyDraft(token, { ...draft, specialRequests: "added" }, "guest@example.com", secret, now), false);
    assert.equal(verifyDraft(token, draft, "other@example.com", secret, now), false);
    assert.equal(verifyDraft(token, draft, "guest@example.com", "another-secret-value", now), false);
    assert.equal(verifyDraft(token, draft, "guest@example.com", secret, new Date(now.getTime() + 16 * 60_000)), false);
    assert.equal(verifyDraft("garbage", draft, "guest@example.com", secret, now), false);
    assert.equal(verifyDraft(`${token}x`, draft, "guest@example.com", secret, now), false);
  });

  it("is the same for key order and an empty note", () => {
    const token = signDraft({ ...draft, specialRequests: "" }, "guest@example.com", secret, now);
    const reordered = { partySize: 9, startTime: "17:00", date: "2026-12-24", sector: "VIP_WING", branch: "BRANCH_2" } as BookingDraft;
    assert.equal(verifyDraft(token, reordered, "guest@example.com", secret, now), true);
  });
});
