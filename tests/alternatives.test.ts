import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findAlternatives } from "../src/booking/alternatives.ts";
import type { Branch, BookingDraft, Sector, Slot } from "../src/types/booking.ts";

const now = new Date("2026-12-20T03:00:00Z"); // 10:00 local
const wanted: BookingDraft = { branch: "BRANCH_1", sector: "MAIN_HALL", date: "2026-12-24", startTime: "19:30", partySize: 6 };

/** Availability where every sitting has `free` units unless overridden as "BRANCH|SECTOR|date|time". */
function availability(free: number, overrides: Record<string, number> = {}) {
  const calls: string[] = [];
  const fn = async (branch: Branch, sector: Sector, date: string): Promise<Slot[]> => {
    calls.push(`${branch}|${sector}|${date}`);
    return (["11:00", "13:30", "17:00", "19:30"] as const).map((startTime) => ({
      startTime,
      slotStart: "",
      slotEnd: "",
      totalUnits: 50,
      freeUnits: overrides[`${branch}|${sector}|${date}|${startTime}`] ?? free,
      bookable: true,
    }));
  };
  return { fn, calls };
}

describe("alternatives", () => {
  it("prefers other sittings the same day, closest time first", async () => {
    const { fn } = availability(10, { "BRANCH_1|MAIN_HALL|2026-12-24|19:30": 0 });
    const alts = await findAlternatives(fn, wanted, "+07:00", now);
    assert.deepEqual(alts.map((d) => d.startTime), ["17:00", "13:30", "11:00"]);
    assert.ok(alts.every((d) => d.date === "2026-12-24" && d.sector === "MAIN_HALL" && d.partySize === 6));
  });

  it("then the other room, then the other branch, then the next days", async () => {
    const full = Object.fromEntries((["11:00", "13:30", "17:00", "19:30"] as const).map((t) => [`BRANCH_1|MAIN_HALL|2026-12-24|${t}`, 0]));
    const { fn } = availability(5, { ...full, "BRANCH_1|VIP_WING|2026-12-24|19:30": 0, "BRANCH_1|VIP_WING|2026-12-24|17:00": 0, "BRANCH_1|VIP_WING|2026-12-24|13:30": 0, "BRANCH_1|VIP_WING|2026-12-24|11:00": 0 });
    const alts = await findAlternatives(fn, wanted, "+07:00", now);
    assert.deepEqual(alts.map((d) => `${d.branch} ${d.sector} ${d.date} ${d.startTime}`), [
      "BRANCH_2 MAIN_HALL 2026-12-24 19:30",
      "BRANCH_1 MAIN_HALL 2026-12-25 19:30",
      "BRANCH_1 MAIN_HALL 2026-12-26 19:30",
    ]);
  });

  it("only suggests sittings with enough tables for the whole party", async () => {
    // 6 guests need 3 Main Hall tables: 2 free is not enough, 3 is. Everything else is full.
    const { fn } = availability(0, { "BRANCH_1|MAIN_HALL|2026-12-24|11:00": 3, "BRANCH_1|MAIN_HALL|2026-12-24|13:30": 2, "BRANCH_1|MAIN_HALL|2026-12-24|17:00": 2 });
    const alts = await findAlternatives(fn, wanted, "+07:00", now);
    assert.deepEqual(alts.map((d) => `${d.sector} ${d.date} ${d.startTime}`), ["MAIN_HALL 2026-12-24 11:00"]);
  });

  it("skips sittings that aren't bookable and dates past the 60-day window", async () => {
    const { fn, calls } = availability(0);
    const late = { ...wanted, date: "2027-02-17" };
    assert.deepEqual(await findAlternatives(fn, late, "+07:00", now), []);
    assert.ok(!calls.some((c) => c.endsWith("2027-02-19")));
  });

  it("returns nothing when no sitting can seat the party", async () => {
    const { fn, calls } = availability(0);
    assert.deepEqual(await findAlternatives(fn, wanted, "+07:00", now), []);
    assert.ok(calls.length <= 6);
  });
});
