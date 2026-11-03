// Live check of the Cent AI setup in .env (a few cents of usage). Run: npm run smoke
// 1. the model exists and is operational  2. a plain reply works  3. a tool call comes back. Never prints the key.
import { centAiConfigFromEnv, createCentAiProvider } from "../src/llm/cent_ai_api.ts";
import { LlmError } from "../src/types/llm.ts";

let config: ReturnType<typeof centAiConfigFromEnv>;
try {
  config = centAiConfigFromEnv();
} catch (err) {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
}
const llm = createCentAiProvider({ ...config, maxOutputTokens: 200 });
console.log(`Provider: ${llm.name}`);

try {
  const models = await llm.listModels();
  const chosen = models.find((m) => m.id === config.model);
  console.log(`\nModels on this key (${models.length}):`);
  for (const m of models) console.log(`  ${m.id === config.model ? "→" : " "} ${m.id}  [${m.capabilities.join(", ") || "no capabilities listed"}]  ${m.status ?? ""}`);
  if (!chosen) throw new Error(`LLM_MODEL "${config.model}" is not in the list above. Pick one of those IDs.`);
  if (!chosen.capabilities.includes("tools")) console.warn(`\n⚠ "${config.model}" does not list "tools"; the assistant needs tool calling.`);

  const plain = await llm.complete({ system: "Reply in five words or fewer.", messages: [{ role: "user", content: "Say hello to a restaurant guest." }] });
  console.log(`\nPlain reply: "${plain.text}"  (${plain.stopReason}, $${plain.usage.costUsd ?? "?"})`);

  const withTool = await llm.complete({
    system: "You help guests book tables. Always use the tool to check availability before answering.",
    messages: [{ role: "user", content: "Are there tables at Branch 1 Main Hall on 2026-12-24?" }],
    tools: [{
      name: "checkAvailability",
      description: "Free tables per sitting for a branch, room and date",
      parameters: {
        type: "object",
        properties: {
          branch: { type: "string", enum: ["BRANCH_1", "BRANCH_2"] },
          sector: { type: "string", enum: ["MAIN_HALL", "VIP_WING"] },
          date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["branch", "sector", "date"],
      },
    }],
  });
  const call = withTool.toolCalls[0];
  console.log(call ? `Tool call: ${call.name}(${JSON.stringify(call.input)})  ✓` : `✗ No tool call returned (stop: ${withTool.stopReason}, text: "${withTool.text}")`);
  console.log(`Tool request cost: $${withTool.usage.costUsd ?? "?"}`);
  process.exitCode = call ? 0 : 1;
} catch (err) {
  console.error(err instanceof LlmError ? `\n✗ Cent AI error ${err.status} ${err.code}: ${err.message}` : `\n✗ ${(err as Error).message}`);
  process.exitCode = 1;
}
