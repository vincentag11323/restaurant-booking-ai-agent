// Free check of the Cent AI setup in .env: lists the models this key can use (no model call, no cost).
// Run: npm run smoke
import { centAiConfigFromEnv, listCentAiModels, toLlmError } from "../src/llm/centAiApi.ts";

try {
  const config = centAiConfigFromEnv();
  const models = await listCentAiModels(config);
  console.log(`Format: ${config.format}  Model: ${config.model}\nModels on this key (${models.length}):`);
  for (const m of models) console.log(`  ${m.id === config.model ? "→" : " "} ${m.id}  [${m.capabilities.join(", ") || "no capabilities listed"}]  ${m.status ?? ""}`);
  if (!models.some((m) => m.id === config.model)) throw new Error(`LLM_MODEL "${config.model}" is not in the list above.`);
} catch (err) {
  const llm = toLlmError(err);
  console.error(llm ? `✗ Cent AI error ${llm.status} ${llm.code}: ${llm.message}` : `✗ ${(err as Error).message}`);
  process.exitCode = 1;
}
