# resortos-booking-agent

Booking assistant for ResortOS Dining: answers table-booking questions and books on a guest's behalf after they confirm. No sign-in; guests give an email (required) and a phone number (optional).

What it can and can't do: **[AGENT_CAPABILITIES.md](AGENT_CAPABILITIES.md)**. Design: [`../requirements/agent_spec.md`](../requirements/agent_spec.md).

Mastra · Vercel AI SDK · TypeScript · Express · Zod. The AI model comes from Cent AI (`src/llm/cent_ai_api.ts` is the only provider-specific file).

## Run

1. Start the booking API (`../resortos-booking-api`), after `npm run db:migrate && npm run db:seed` there. The seed creates the assistant's account from the API's `AGENT_EMAIL` / `AGENT_PASSWORD`.
2. Here:
   ```bash
   cp .env.example .env   # add LLM_API_KEY, LLM_MODEL, AGENT_PASSWORD (same as the API's), AGENT_DRAFT_SECRET
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

## Layout

| Path | What lives there |
|---|---|
| `src/chat.ts` | One chat turn: validation, tools, read-back, confirm, alternatives, failure replies |
| `src/agent/` | Mastra agent (`mastra_brain.ts`) and system prompt |
| `src/booking/` | Booking API client, rules, signed drafts, alternatives |
| `src/llm/cent_ai_api.ts` | Cent AI model, models list, error mapping |
| `src/server.ts` | `POST /chat`, `GET /health`, rate limits |
| `src/types/` | This repo's own types |
