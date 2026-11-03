# resortos-booking-agent

Booking assistant for ResortOS Dining: answers table-booking questions and books on a guest's behalf after they confirm. No sign-in; guests give an email (required) and a phone number (optional).

What it can and can't do: **[AGENT_CAPABILITIES.md](AGENT_CAPABILITIES.md)**. Design: [`../requirements/agent_spec.md`](../requirements/agent_spec.md).

Mastra · Vercel AI SDK · TypeScript · Express · Zod. The AI model comes from Cent AI (`src/llm/cent_ai_api.ts` is the only provider-specific file).

Guests use it from the PWA's **Ask** tab (`resortos-booking-web`, `src/agent-api/`), or any client that can POST JSON.

## Run

1. Start the booking API (`../resortos-booking-api`), after `npm run db:migrate && npm run db:seed` there. The seed creates the assistant's account and stores only the SHA-256 of the API's `AGENT_API_KEY`.
2. Here:
   ```bash
   cp .env.example .env   # add LLM_API_KEY, LLM_MODEL, AGENT_API_KEY (same as the API's, at least 32 characters), AGENT_DRAFT_SECRET
   npm install
   npm run smoke          # free: lists the models your key can use
   npm run dev            # http://localhost:4300
   ```

## Use

```bash
curl -s localhost:4300/chat -H 'content-type: application/json' -d '{
  "contact": { "email": "guest@example.com" },
  "messages": [{ "role": "user", "content": "Table for 4 at Branch 1 Main Hall next Friday at 19:30" }]
}'
```
The reply includes `pendingBooking: { draft, token }`. To book, send the same conversation plus `"confirm": <that pendingBooking>`. When a sitting is full, `alternatives` lists up to 3 ready-to-confirm options.

## Test

```bash
npm test           # no AI calls: the model is a scripted fake, the booking API a fake
npm run typecheck
```
`npm run e2e` runs real conversations against Cent AI and the local API. It costs AI calls and stops at a hard budget.

## Deploying

* Set `TRUST_PROXY=true` only if **exactly one** proxy (your host's load balancer) sits in front of the server. With no proxy or several, a client could forge `X-Forwarded-For` and get around the per-IP limits.
* The per-email cap (2 upcoming assistant bookings) is enforced by the booking API inside the booking transaction, so it holds even if IP limits are bypassed.

## Layout

| Path | What lives there |
|---|---|
| `src/chat.ts` | One chat turn: validation, tools, read-back, confirm, alternatives, failure replies |
| `src/agent/` | Mastra agent (`mastra_brain.ts`) and system prompt |
| `src/booking/` | Booking API client, rules, signed drafts, alternatives |
| `src/llm/cent_ai_api.ts` | Cent AI model, models list, error mapping |
| `src/server.ts` | `POST /chat`, `GET /health`, rate limits |
| `src/types/` | This repo's own types |
