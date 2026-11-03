# resortos-booking-agent

Booking assistant for ResortOS Dining: answers table-booking questions and books on a guest's behalf after they confirm. No sign-in; guests give an email (required) and a phone number (optional).

**Status: planning. No code yet.** The spec is [`../requirements/agent_spec.md`](../requirements/agent_spec.md); open decisions are in its §9.

Decoupled from `resortos-booking-api` and `resortos-booking-web`: it talks to the API over HTTP only and keeps its own types in `src/types/`.

## What exists so far
* `src/types/llm.ts`: provider-neutral LLM types.
* `src/llm/cent_ai_api.ts`: Cent AI adapter (Messages and Responses formats). Swap providers by adding a file with the same `LlmProvider` factory.
* `npm test`: adapter tests, network mocked.
* `npm run smoke`: live check against Cent AI using `.env` (copy `.env.example`, add `LLM_API_KEY` and `LLM_MODEL`).
