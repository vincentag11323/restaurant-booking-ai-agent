import { createMastraBrain } from "./agent/mastraBrain.ts";
import { createBookingApi } from "./booking/bookingApi.ts";
import { handleChat } from "./chat.ts";
import { loadConfig } from "./config.ts";
import { createCentAiModel } from "./llm/centAiApi.ts";
import { createServer } from "./server.ts";

const config = loadConfig();
const deps = {
  brain: createMastraBrain(createCentAiModel(config.llm)),
  api: createBookingApi({ baseUrl: config.bookingApiUrl, apiKey: config.agentApiKey }),
  draftSecret: config.draftSecret,
  utcOffset: config.utcOffset,
  log: (line: string) => console.info(line),
};

createServer({ handleChat: (body, request) => handleChat(body, request, deps), trustProxy: config.trustProxy, limits: config.limits, apiDocs: config.apiDocs }).listen(config.port, () => {
  console.info(`ResortOS booking assistant listening on :${config.port} (model ${config.llm.model}, format ${config.llm.format})`);
});
