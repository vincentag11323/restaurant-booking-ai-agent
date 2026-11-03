// Production Brain: a Mastra agent with three tools. Built per turn because the tools close over that turn.
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Brain } from "../chat.ts";
import { toLlmError } from "../llm/cent_ai_api.ts";
import { BRANCHES, SECTORS, SLOT_START_TIMES } from "../types/booking.ts";
import { bookingInstructions } from "./prompt.ts";

/** Bounds a turn's tool loop (agent_spec.md §13.2 F9). */
const MAX_STEPS = 5;
/** Once one of these runs, the server writes the reply from a template, so another model call would be wasted. */
const FINAL_TOOLS = new Set(["proposeBooking", "notSupportedYet"]);

type AgentModel = ConstructorParameters<typeof Agent>[0]["model"];
/** Tool-call entries in a step; Mastra versions expose the name directly or under payload. */
type ToolCallLike = { toolName?: string; payload?: { toolName?: string } };

export function createMastraBrain(model: AgentModel): Brain {
  return {
    async run(messages, tools, today, signal) {
      const agent = new Agent({
        id: "booking-assistant",
        name: "ResortOS booking assistant",
        instructions: bookingInstructions(today),
        model,
        tools: {
          checkAvailability: createTool({
            id: "checkAvailability",
            description: "Free tables or rooms per sitting for one branch, room and date.",
            inputSchema: z.object({ branch: z.enum(BRANCHES), sector: z.enum(SECTORS), date: z.string().describe("YYYY-MM-DD") }),
            execute: async (input) => tools.checkAvailability(input),
          }),
          proposeBooking: createTool({
            id: "proposeBooking",
            description: "Check and draft a booking once branch, room, date, sitting and party size are known. The guest confirms it afterwards.",
            inputSchema: z.object({
              branch: z.enum(BRANCHES),
              sector: z.enum(SECTORS),
              date: z.string().describe("YYYY-MM-DD"),
              startTime: z.enum(SLOT_START_TIMES),
              partySize: z.number().int(),
              specialRequests: z.string().optional(),
            }),
            execute: async (input) => tools.proposeBooking(input),
          }),
          notSupportedYet: createTool({
            id: "notSupportedYet",
            description: "Use for any request that is not about booking a table.",
            inputSchema: z.object({ topic: z.string().describe("Two or three words, e.g. 'menu question'") }),
            execute: async (input) => tools.notSupportedYet(input),
          }),
        },
      });

      try {
        const history = messages.map((m) => (m.role === "user" ? { role: "user" as const, content: m.content } : { role: "assistant" as const, content: m.content }));
        const result = await agent.generate(history, {
          maxSteps: MAX_STEPS,
          abortSignal: signal,
          stopWhen: ({ steps }: { steps: { toolCalls?: ToolCallLike[] }[] }) =>
            steps.at(-1)?.toolCalls?.some((call) => FINAL_TOOLS.has(call.toolName ?? call.payload?.toolName ?? "")) ?? false,
        });
        return result.text ?? "";
      } catch (err) {
        throw toLlmError(err) ?? err;
      }
    },
  };
}
