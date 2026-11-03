// The agent's own copy of the booking API's shapes (requirements/api_spec.md). Not shared with other repos on purpose.

export type Branch = "BRANCH_1" | "BRANCH_2";
export type Sector = "MAIN_HALL" | "VIP_WING";
export type SlotStartTime = "11:00" | "13:30" | "17:00" | "19:30";

export const BRANCHES: Branch[] = ["BRANCH_1", "BRANCH_2"];
export const SECTORS: Sector[] = ["MAIN_HALL", "VIP_WING"];
export const SLOT_START_TIMES: SlotStartTime[] = ["11:00", "13:30", "17:00", "19:30"];

/** What the guest is about to book. Dates are restaurant-local YYYY-MM-DD. */
export interface BookingDraft {
  branch: Branch;
  sector: Sector;
  date: string;
  startTime: SlotStartTime;
  partySize: number;
  specialRequests?: string;
}

/** GET /api/availability item */
export interface Slot {
  startTime: SlotStartTime;
  slotStart: string;
  slotEnd: string;
  totalUnits: number;
  freeUnits: number;
  bookable: boolean;
}

/** The subset of the API's Reservation the agent uses. */
export interface Reservation {
  id: string;
  code: string;
  branch: Branch;
  sector: Sector;
  slotStart: string;
  slotEnd: string;
  partySize: number;
  tableIds: string[];
}
