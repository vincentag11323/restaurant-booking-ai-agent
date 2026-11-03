// Signs a read-back booking so the guest confirms exactly what they were shown (agent_spec.md §13.3).
// The token also serves as the API's Idempotency-Key, so a retried confirmation can't book twice.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { BookingDraft } from "../types/booking.ts";

const TTL_MS = 15 * 60_000;

function canonical(draft: BookingDraft, email: string, expiresAt: number): string {
  // Fixed field order and an explicit empty note, so key order or an omitted field can't change the signature.
  return JSON.stringify([
    draft.branch, draft.sector, draft.date, draft.startTime, draft.partySize, draft.specialRequests ?? "",
    email.trim().toLowerCase(), expiresAt,
  ]);
}

function hmac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signDraft(draft: BookingDraft, email: string, secret: string, now: Date = new Date()): string {
  const expiresAt = now.getTime() + TTL_MS;
  return `${expiresAt}.${hmac(canonical(draft, email, expiresAt), secret)}`;
}

export function verifyDraft(token: string, draft: BookingDraft, email: string, secret: string, now: Date = new Date()): boolean {
  const [expires, signature] = token.split(".");
  const expiresAt = Number(expires);
  if (!signature || !Number.isFinite(expiresAt) || expiresAt < now.getTime()) return false;
  const expected = Buffer.from(hmac(canonical(draft, email, expiresAt), secret));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
