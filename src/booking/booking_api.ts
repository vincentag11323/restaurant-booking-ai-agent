// HTTP client for resortos-booking-api. The agent signs in as the AGENT service account, which may only
// book on a guest's behalf and look up one guest by exact email (agent_spec.md §5.5).
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
  email: string;
  password: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function createBookingApi(config: BookingApiConfig): BookingApi {
  const http = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;
  let token: string | null = null;

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

  async function signIn(): Promise<string> {
    const res = await send("/auth/login", { method: "POST", body: { email: config.email, password: config.password } });
    if (!res.ok) await fail(res);
    token = ((await res.json()) as { accessToken: string }).accessToken;
    return token;
  }

  /** Authenticated call; signs in on first use and once more if the 15-minute token has expired. */
  async function authed(path: string, init: { method: "GET" | "POST"; body?: unknown; headers?: Record<string, string> }): Promise<Response> {
    const call = async (t: string) => send(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${t}` } });
    let res = await call(token ?? (await signIn()));
    if (res.status === 401) res = await call(await signIn());
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
