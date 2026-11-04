# What the Booking Assistant Can and Cannot Do

The ResortOS Dining booking assistant is a chat API (`POST /agents/users/chats`) that books tables at Branch 1 and Branch 2.
Guests don't sign in. They give an **email (required)** and optionally a **phone number**.
Full design: [`../requirements/AGENT_SPEC.md`](../requirements/AGENT_SPEC.md).

## It can

| | What | How it stays safe |
|---|---|---|
| ✅ | **Answer booking questions**: sittings (11:00, 13:30, 17:00, 19:30, 2.5 hours each), the two rooms, party sizes (1 to 50), the 60-day booking window | Facts come from the system prompt, which mirrors the API's rules |
| ✅ | **Check live availability** for a branch, room and date | Reads the public availability API every time; nothing is cached or guessed |
| ✅ | **Understand dates like "tomorrow" or "next Friday"** | Today's restaurant date and time (UTC+7) is given to the model every turn |
| ✅ | **Ask for missing details** (branch, room, date, time, guests) | One short question at a time |
| ✅ | **Read a booking back before making it** | The read-back is written by code from the checked details, not by the model, and is signed for 15 minutes |
| ✅ | **Book on the guest's behalf** once they confirm | Only a signed confirmation books. The model has no booking tool |
| ✅ | **Take special requests** (e.g. "window seat", "birthday") | Up to 500 characters, passed to the booking |
| ✅ | **Suggest other times when a sitting is full**: other sittings the same day, the other room, the other branch, then the next 3 days | Up to 3 options picked by code from live availability, each ready to confirm |
| ✅ | **Recover when someone takes the last table** between read-back and confirm | Offers live alternatives; nothing half-booked |
| ✅ | **Create a guest account from the email** and attach the booking | Password-less. Signing up later with that email claims the account and shows the booking in "My bookings" |
| ✅ | **Reply with a reservation code** (e.g. `RSV-7K3Q9X`) | Code comes from the booking API |

## It cannot

| | What | What happens instead |
|---|---|---|
| ❌ | **Anything that isn't booking a table** (menu, allergies, prices, directions, weather, writing, coding, general chat) | Fixed reply: "I can only help with table bookings at ResortOS Dining." The topic is logged (not the message) so future versions can add support |
| ❌ | **Show, change or cancel existing bookings** | Refused. The email in a chat isn't verified, so anyone could type someone else's address. Guests sign in to the app to manage bookings |
| ❌ | **See or list other guests** ("who's booked tonight?") | Refused by the assistant and blocked by the API: its account can't list or search anyone |
| ❌ | **Book without the guest confirming** | Impossible by design: only `POST /agents/users/chats` with a valid signed `confirm` books |
| ❌ | **More than 1 upcoming assistant booking for an email that hasn't signed up** (3 once signed up) | "This email already has a booking made with the assistant. To book a different time, sign up with this email in the app, cancel that booking there, then ask me again." |
| ❌ | **Book outside the rules** (over 50 guests, past dates, more than 60 days ahead, other times) | Explains the rule and the valid options |
| ❌ | **Reveal its instructions or change its role** | Told to ignore such requests; its tools can't reach other data anyway |
| ❌ | **Reply in other languages** | English only for now |
| ❌ | **Handle allergies or menu advice** | Out of scope this iteration |
| ❌ | **Send emails or reminders** | Confirmation is logged by the API's notification stub for now |

## Its permissions in the booking API (role `AGENT`)

| Allowed | Not allowed (403) |
|---|---|
| `POST /api/agents/reservations`: book for one guest email | Every other signed-in route: guest bookings, profiles, menu recommendations, all admin routes |
| `POST /api/agents/guests/lookup`: one guest by exact email, answer is only `{ exists, upcomingAssistantBookings, assistantBookingLimit }` | Listing, searching, or reading names, phones or bookings of any guest |
| Public availability | |

Every assistant booking is audited with the assistant as the actor and the guest as "on behalf of", and admins see it labelled **Booked by AI assistant**.

## Limits

| Limit | Value |
|---|---|
| Chat requests | 10 per minute per IP, and 30 per 30 minutes per chat session (email) |
| Confirmed bookings | 3 per hour per IP |
| Upcoming assistant bookings | 1 per email until it signs up, then 3 |
| Conversation size | 30 messages, 2,000 characters each |
| Tool steps per message | 5 |

## What the guest sees when something fails

| Situation | Reply |
|---|---|
| Booking system down | "The booking system isn't responding. Nothing was booked; please try again in a minute." |
| AI busy or rate-limited | "The assistant is busy. Please try again in a moment." (503 with `Retry-After`) |
| AI budget used up | "The assistant is unavailable right now. You can still book in the app." |
| Confirmation edited or older than 15 minutes | "Those booking details changed or expired. Please ask again." |
| Confirmation retried after a timeout | Returns the same booking; never books twice |
| Booking refused for another reason | "That booking couldn't be made. Please try another time, or book in the app." (one wording, so replies don't reveal anything about an email's account) |

Guest email and phone are never sent to the AI model, and chat messages are never logged.
