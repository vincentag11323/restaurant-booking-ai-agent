// Finds real, bookable alternatives when the requested sitting can't seat the party (AGENT_SPEC.md §13.1).
// Code, not the model, picks them, so every suggestion comes from live availability.
import { type Branch, type BookingDraft, type Sector, type Slot, SLOT_START_TIMES, type SlotStartTime } from "../types/booking.ts";
import { MAX_DAYS_AHEAD, addDays, localNow, unitsNeeded } from "./rules.ts";

export type AvailabilityFn = (branch: Branch, sector: Sector, date: string) => Promise<Slot[]>;

const MAX_ALTERNATIVES = 3;
const NEXT_DAYS = 3;

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Sittings ordered by closeness to the wanted time (earlier wins a tie). */
function byCloseness(wanted: SlotStartTime): SlotStartTime[] {
  return [...SLOT_START_TIMES].sort((a, b) => Math.abs(minutes(a) - minutes(wanted)) - Math.abs(minutes(b) - minutes(wanted)) || minutes(b) - minutes(a));
}

export async function findAlternatives(availability: AvailabilityFn, wanted: BookingDraft, utcOffset: string, now: Date = new Date()): Promise<BookingDraft[]> {
  const latest = addDays(localNow(utcOffset, now).date, MAX_DAYS_AHEAD);
  const otherSector: Sector = wanted.sector === "MAIN_HALL" ? "VIP_WING" : "MAIN_HALL";
  const otherBranch: Branch = wanted.branch === "BRANCH_1" ? "BRANCH_2" : "BRANCH_1";
  const notWanted = (t: SlotStartTime) => t !== wanted.startTime;

  // Search order from the spec: same day other sittings, other room, other branch, then the next days.
  const plan: { branch: Branch; sector: Sector; date: string; times: SlotStartTime[] }[] = [
    { branch: wanted.branch, sector: wanted.sector, date: wanted.date, times: byCloseness(wanted.startTime).filter(notWanted) },
    { branch: wanted.branch, sector: otherSector, date: wanted.date, times: byCloseness(wanted.startTime) },
    { branch: otherBranch, sector: wanted.sector, date: wanted.date, times: [wanted.startTime] },
    ...Array.from({ length: NEXT_DAYS }, (_, i) => ({ branch: wanted.branch, sector: wanted.sector, date: addDays(wanted.date, i + 1), times: [wanted.startTime] })),
  ];

  const found: BookingDraft[] = [];
  for (const step of plan) {
    if (found.length >= MAX_ALTERNATIVES) break;
    if (step.date > latest) continue;
    const slots = await availability(step.branch, step.sector, step.date);
    const needed = unitsNeeded(step.sector, wanted.partySize);
    for (const startTime of step.times) {
      const slot = slots.find((s) => s.startTime === startTime);
      if (slot?.bookable && slot.freeUnits >= needed && found.length < MAX_ALTERNATIVES) {
        found.push({ ...wanted, branch: step.branch, sector: step.sector, date: step.date, startTime });
      }
    }
  }
  return found;
}
