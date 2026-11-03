import { createMastraBrain } from "./agent/mastra_brain.ts";
import { createBookingApi } from "./booking/booking_api.ts";
import { handleChat } from "./chat.ts";
import { loadConfig } from "./config.ts";
import { createCentAiModel } from "./llm/cent_ai_api.ts";
import { createServer } from "./server.ts";

const config = loadConfig();
const deps = {
  brain: createMastraBrain(createCentAiModel(config.llm)),
  api: createBookingApi({ baseUrl: config.bookingApiUrl, email: config.agentEmail, password: config.agentPassword }),
  draftSecret: config.draftSecret,
  utcOffset: config.utcOffset,
  log: (line: string) => console.info(line),
};

createServer({ handleChat: (body, request) => handleChat(body, request, deps), trustProxy: config.trustProxy, limits: config.limits }).listen(config.port, () => {
  console.info(`ResortOS booking assistant listening on :${config.port} (model ${config.llm.model}, format ${config.llm.format})`);
});
