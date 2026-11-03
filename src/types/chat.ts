import type { BookingDraft } from "./booking.ts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** A booking read back to the guest, signed so the confirmed booking is exactly what they saw. */
export interface PendingBooking {
  draft: BookingDraft;
  token: string;
}

export interface ChatRequest {
  contact: { email: string; phone?: string };
  messages: ChatMessage[];
  /** Sent only when the guest confirms a pendingBooking (or one of the alternatives). */
  confirm?: PendingBooking;
}

export interface ChatResponse {
  reply: string;
  pendingBooking?: PendingBooking;
  alternatives?: PendingBooking[];
  booking?: { code: string; slotStart: string; slotEnd: string; tableIds: string[] };
}
