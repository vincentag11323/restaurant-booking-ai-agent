// HTTP client for resortos-booking-api. The agent authenticates with X-Agent-Key (AGENT_API_KEY) as the AGENT
// service account, which may only book on a guest's behalf and look up one guest by exact email (AGENT_SPEC.md §5.5).
import type { Branch, BookingDraft, Reservation, Sector, Slot } from "../types/booking.ts";

export class BookingApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BookingApiError";
    this.status = status;
  }
}

/** POST /api/agent/guests/lookup: the most the assistant may know about one guest. */
export interface GuestLookup {
  exists: boolean;
  upcomingAssistantBookings: number;
  /** 1 until the email signs up, then 3. */
  assistantBookingLimit: number;
}

export interface BookingApi {
  availability(branch: Branch, sector: Sector, date: string): Promise<Slot[]>;
  lookupGuest(email: string): Promise<GuestLookup>;
  book(input: { draft: BookingDraft; email: string; phone?: string; clientIp?: string; idempotencyKey: string }): Promise<Reservation>;
}

export interface BookingApiConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function createBookingApi(config: BookingApiConfig): BookingApi {
  const http = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;

  async function send(path: string, init: { method: "GET" | "POST"; body?: unknown; headers?: Record<string, string> }): Promise<Response> {
    try {
      return await http(`${config.baseUrl}/api${path}`, {
        method: init.method,
        headers: { "content-type": "application/json", ...init.headers },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new BookingApiError(0, "Booking API unreachable");
    }
  }

  async function fail(res: Response): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new BookingApiError(res.status, body.message ?? `Booking API returned HTTP ${res.status}`);
  }

  /** Assistant-only call: sends the API key; a 401 (wrong key) is surfaced, not retried. */
  async function authed(path: string, init: { method: "GET" | "POST"; body?: unknown; headers?: Record<string, string> }): Promise<Response> {
    const res = await send(path, { ...init, headers: { ...init.headers, "x-agent-key": config.apiKey } });
    if (!res.ok) await fail(res);
    return res;
  }

  return {
    async availability(branch, sector, date) {
      const res = await send(`/availability?branch=${branch}&sector=${sector}&date=${date}`, { method: "GET" });
      if (!res.ok) await fail(res);
      return (await res.json()) as Slot[];
    },

    async lookupGuest(email) {
      return (await (await authed("/agent/guests/lookup", { method: "POST", body: { email } })).json()) as GuestLookup;
    },

    async book({ draft, email, phone, clientIp, idempotencyKey }) {
      const res = await authed("/agent/reservations", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: { ...draft, email, phone, clientIp },
      });
      return (await res.json()) as Reservation;
    },
  };
}
