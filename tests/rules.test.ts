import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeDraft, localNow, unitsNeeded, validateDraft } from "../src/booking/rules.ts";
import type { BookingDraft } from "../src/types/booking.ts";

// 2026-12-20 10:00 in UTC+7
const now = new Date("2026-12-20T03:00:00Z");
const draft: BookingDraft = { branch: "BRANCH_1", sector: "MAIN_HALL", date: "2026-12-24", startTime: "19:30", partySize: 4 };

describe("booking rules", () => {
  it("knows the restaurant's local date and time", () => {
    assert.deepEqual(localNow("+07:00", now), { date: "2026-12-20", time: "10:00", weekday: "Sun" });
    assert.deepEqual(localNow("+07:00", new Date("2026-12-20T17:30:00Z")), { date: "2026-12-21", time: "00:30", weekday: "Mon" });
  });

  it("accepts a valid draft", () => {
    assert.equal(validateDraft(draft, "+07:00", now), null);
  });

  it("explains each broken rule in plain words", () => {
    assert.equal(validateDraft({ ...draft, partySize: 51 }, "+07:00", now), "A booking can be for 1 to 50 guests.");
    assert.equal(validateDraft({ ...draft, partySize: 2.5 }, "+07:00", now), "A booking can be for 1 to 50 guests.");
    assert.equal(validateDraft({ ...draft, startTime: "12:00" as never }, "+07:00", now), "Sittings start at 11:00, 13:30, 17:00 and 19:30.");
    assert.equal(validateDraft({ ...draft, date: "24/12" }, "+07:00", now), "I need the date as a calendar day.");
    assert.equal(validateDraft({ ...draft, date: "2026-12-19" }, "+07:00", now), "That date has passed. Bookings open from today up to 60 days ahead.");
    assert.equal(validateDraft({ ...draft, date: "2027-02-19" }, "+07:00", now), "Bookings open up to 60 days ahead, so the latest date is 2027-02-18.");
    assert.equal(validateDraft({ ...draft, date: "2026-12-20", startTime: "11:00" }, "+07:00", new Date("2026-12-20T04:30:00Z")), "That sitting has already started. Please pick a later one.");
  });

  it("allows a later sitting today", () => {
    assert.equal(validateDraft({ ...draft, date: "2026-12-20", startTime: "17:00" }, "+07:00", now), null);
  });

  it("counts tables and rooms like the API", () => {
    assert.deepEqual([unitsNeeded("MAIN_HALL", 5), unitsNeeded("VIP_WING", 14)], [3, 2]);
  });

  it("describes a draft as one plain sentence", () => {
    assert.equal(describeDraft(draft), "4 guests at Branch 1, Main Dining Hall, on Thu 24 Dec from 19:30 to 22:00");
    assert.equal(describeDraft({ ...draft, partySize: 1, sector: "VIP_WING", startTime: "11:00", specialRequests: "Birthday" }), "1 guest at Branch 1, VIP Private Dining, on Thu 24 Dec from 11:00 to 13:30 (note: Birthday)");
  });
});
