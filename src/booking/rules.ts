// The booking rules from requirements/TECHNICAL_DECISIONS.md §2, mirrored so the assistant can explain them
// before calling the API. The API stays the authority and re-checks everything.
import { type BookingDraft, type Sector, SLOT_START_TIMES } from "../types/booking.ts";

export const MAX_PARTY_SIZE = 50;
export const MAX_DAYS_AHEAD = 60;
const SEATS_PER_UNIT: Record<Sector, number> = { MAIN_HALL: 2, VIP_WING: 13 };
const SLOT_END: Record<string, string> = { "11:00": "13:30", "13:30": "16:00", "17:00": "19:30", "19:30": "22:00" };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const BRANCH_LABEL = { BRANCH_1: "Branch 1", BRANCH_2: "Branch 2" } as const;
const SECTOR_LABEL = { MAIN_HALL: "Main Dining Hall", VIP_WING: "VIP Private Dining" } as const;

function offsetMs(utcOffset: string): number {
  const [, sign, h, m] = /^([+-])(\d{2}):(\d{2})$/.exec(utcOffset) ?? [];
  if (!sign) throw new Error(`Invalid UTC offset: ${utcOffset}`);
  return (sign === "-" ? -1 : 1) * (Number(h) * 60 + Number(m)) * 60_000;
}

/** The restaurant's current local date ("YYYY-MM-DD"), time ("HH:MM") and weekday. */
export function localNow(utcOffset: string, now: Date = new Date()) {
  const local = new Date(now.getTime() + offsetMs(utcOffset));
  const iso = local.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), weekday: WEEKDAYS[local.getUTCDay()] };
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function unitsNeeded(sector: Sector, partySize: number): number {
  return Math.ceil(partySize / SEATS_PER_UNIT[sector]);
}

/** Returns a plain-language reason the draft can't be booked, or null if it follows the rules. */
export function validateDraft(draft: BookingDraft, utcOffset: string, now: Date = new Date()): string | null {
  if (!Number.isInteger(draft.partySize) || draft.partySize < 1 || draft.partySize > MAX_PARTY_SIZE) {
    return `A booking can be for 1 to ${MAX_PARTY_SIZE} guests.`;
  }
  if (!SLOT_START_TIMES.includes(draft.startTime)) return "Sittings start at 11:00, 13:30, 17:00 and 19:30.";
  const dateProblem = validateDate(draft.date, utcOffset, now);
  if (dateProblem) return dateProblem;
  const today = localNow(utcOffset, now);
  if (draft.date === today.date && draft.startTime <= today.time) return "That sitting has already started. Please pick a later one.";
  return null;
}

/** Date-only checks (format, not past, within the booking window). */
export function validateDate(date: string, utcOffset: string, now: Date = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return "I need the date as a calendar day.";
  const today = localNow(utcOffset, now).date;
  const latest = addDays(today, MAX_DAYS_AHEAD);
  if (date < today) return `That date has passed. Bookings open from today up to ${MAX_DAYS_AHEAD} days ahead.`;
  if (date > latest) return `Bookings open up to ${MAX_DAYS_AHEAD} days ahead, so the latest date is ${latest}.`;
  return null;
}

/** "Thu 24 Dec" */
export function formatDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

export function guests(partySize: number): string {
  return `${partySize} ${partySize === 1 ? "guest" : "guests"}`;
}

/** "4 guests at Branch 1, Main Dining Hall, on Thu 24 Dec from 19:30 to 22:00" */
export function describeDraft(draft: BookingDraft): string {
  const note = draft.specialRequests ? ` (note: ${draft.specialRequests})` : "";
  return `${guests(draft.partySize)} at ${BRANCH_LABEL[draft.branch]}, ${SECTOR_LABEL[draft.sector]}, on ${formatDay(draft.date)} from ${draft.startTime} to ${SLOT_END[draft.startTime]}${note}`;
}
