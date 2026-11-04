// Interactive API docs (AGENT_SPEC.md §4.1: GET /agents/public/docs, GET /agents/public/docs/openapi.json).
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import {
  API_DOWN,
  BUSY,
  EXPIRED,
  LAST_MESSAGE_MUST_BE_USER,
  LLM_PROBLEM,
  UNAVAILABLE,
} from "../src/chat.ts";
import {
  BOOKING_LIMIT_REPLY,
  CHAT_LIMIT_REPLY,
  chatResponseSchema,
  GENERIC_ERROR_REPLY,
  healthSchema,
  MALFORMED_JSON_REPLY,
  NOT_FOUND_REPLY,
  SESSION_LIMIT_REPLY,
} from "../src/openApi.ts";
import { createServer, type ServerDeps } from "../src/server.ts";

async function withServer(deps: Partial<ServerDeps>, run: (url: string, app: ReturnType<typeof createServer>) => Promise<void>) {
  const app = createServer({ handleChat: async () => ({ status: 200, body: { reply: "ok" } }), log: () => {}, ...deps });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, app);
  } finally {
    server.close();
  }
}

interface Layer {
  route?: { methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
}

/** Every route-method pair the app answers, found by walking the whole router tree (Express 5 keeps no mount-path strings on an un-dispatched layer, so this doesn't try to read paths, only count them). */
function countRoutes(stack: Layer[]): number {
  return stack.reduce((sum, layer) => sum + Object.keys(layer.route?.methods ?? {}).filter((m) => m !== "_all").length + (layer.handle?.stack ? countRoutes(layer.handle.stack) : 0), 0);
}

/** What server.ts + openApi.ts's docsRouter mount. Kept by hand; countRoutes() below catches anything mounted that isn't here. */
const EXPECTED_OPERATIONS = ["GET /agents/public/health", "GET /agents/public/docs", "GET /agents/public/docs/openapi.json", "POST /agents/users/chats"];

interface Example {
  summary?: string;
  value: unknown;
}
interface Operation {
  summary?: string;
  description?: string;
  tags?: string[];
  security?: unknown[];
  responses: Record<string, { content?: Record<string, { example?: unknown; examples?: Record<string, Example> }> }>;
}
interface Document {
  openapi: string;
  info: { title: string; description: string };
  tags: { name: string }[];
  paths: Record<string, Record<string, Operation>>;
}

function operations(doc: Document) {
  return Object.entries(doc.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, op })));
}

describe("the agent's OpenAPI document", () => {
  it("is OpenAPI 3.1 with a plain-language introduction and the two groups", async () => {
    await withServer({}, async (url) => {
      const res = await fetch(`${url}/agents/public/docs/openapi.json`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      const doc = (await res.json()) as Document;
      assert.equal(doc.openapi, "3.1.0");
      assert.equal(doc.info.title, "ResortOS booking assistant");
      for (const words of ["/agents/public", "/agents/users", "reply"]) assert.ok(doc.info.description.includes(words), `description should mention "${words}"`);
      assert.deepEqual(doc.tags.map((t) => t.name), ["Public", "Users"]);
    });
  });

  it("drift guard: documents exactly the routes the app mounts, each with a summary, description and no security scheme", async () => {
    await withServer({}, async (url, app) => {
      const doc = (await (await fetch(`${url}/agents/public/docs/openapi.json`)).json()) as Document;
      const ops = operations(doc);
      assert.deepEqual(ops.map((o) => o.key).sort(), [...EXPECTED_OPERATIONS].sort());
      assert.equal(countRoutes((app as unknown as { router: { stack: Layer[] } }).router.stack), EXPECTED_OPERATIONS.length);
      for (const { key, op } of ops) {
        assert.ok((op.summary?.length ?? 0) > 0, `${key}: summary`);
        assert.ok((op.description?.length ?? 0) > 0, `${key}: description`);
        assert.equal(op.security, undefined, `${key}: no security scheme`);
      }

      // Every documented path is really mounted (a stray entry here would 404 and fail the test).
      assert.equal((await fetch(`${url}/agents/public/health`)).status, 200);
      assert.equal((await fetch(`${url}/agents/public/docs/`)).status, 200);
      assert.equal((await fetch(`${url}/agents/public/docs/openapi.json`)).status, 200);
      assert.equal((await fetch(`${url}/agents/users/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
    });
  });

  it("gives the chat endpoint a request example and 200 examples for every reply kind", async () => {
    await withServer({}, async (url) => {
      const doc = (await (await fetch(`${url}/agents/public/docs/openapi.json`)).json()) as Document;
      const chats = operations(doc).find((o) => o.key === "POST /agents/users/chats")!.op;
      const examples = chats.responses["200"].content?.["application/json"]?.examples ?? {};
      assert.deepEqual(Object.keys(examples).sort(), ["alternatives", "booked", "normalReply", "readBack"]);
      for (const example of Object.values(examples)) {
        const result = chatResponseSchema.safeParse(example.value);
        assert.deepEqual(result.error?.issues ?? [], [], JSON.stringify(example.value));
      }
    });
  });

  it("lists every error this route can send, with the exact reply text from chat.ts and server.ts", async () => {
    await withServer({}, async (url) => {
      const doc = (await (await fetch(`${url}/agents/public/docs/openapi.json`)).json()) as Document;
      const chats = operations(doc).find((o) => o.key === "POST /agents/users/chats")!.op;
      const messages = (status: number) => Object.values(chats.responses[String(status)]?.content?.["application/json"]?.examples ?? {}).map((e) => (e.value as { reply: string }).reply);
      assert.deepEqual(messages(400).sort(), [EXPIRED, LAST_MESSAGE_MUST_BE_USER].sort());
      assert.deepEqual(messages(404), [NOT_FOUND_REPLY]);
      assert.deepEqual(messages(429).sort(), [BOOKING_LIMIT_REPLY, CHAT_LIMIT_REPLY, SESSION_LIMIT_REPLY].sort());
      assert.deepEqual(messages(500), [GENERIC_ERROR_REPLY]);
      assert.deepEqual(messages(502).sort(), [API_DOWN, LLM_PROBLEM].sort());
      assert.deepEqual(messages(503).sort(), [BUSY, UNAVAILABLE].sort());
    });
  });

  it("documents the real health response", async () => {
    await withServer({}, async (url) => {
      const body = await (await fetch(`${url}/agents/public/health`)).json();
      assert.deepEqual(healthSchema.safeParse(body).error?.issues ?? [], []);
    });
  });
});

describe("the Swagger UI page", () => {
  it("redirects /agents/public/docs to the folder URL so the page's relative assets load", async () => {
    await withServer({}, async (url) => {
      const res = await fetch(`${url}/agents/public/docs`, { redirect: "manual" });
      assert.deepEqual([res.status, res.headers.get("location")], [301, "/agents/public/docs/"]);
    });
  });

  it("serves the page", async () => {
    await withServer({}, async (url) => {
      const res = await fetch(`${url}/agents/public/docs/`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
      assert.match(await res.text(), /swagger-ui/);
    });
  });
});

describe("API_DOCS off", () => {
  it("hides the docs behind the 404 handler when apiDocs is false", async () => {
    await withServer({ apiDocs: false }, async (url) => {
      const page = await fetch(`${url}/agents/public/docs/`);
      assert.deepEqual([page.status, await page.json()], [404, { reply: NOT_FOUND_REPLY }]);
      const json = await fetch(`${url}/agents/public/docs/openapi.json`);
      assert.deepEqual([json.status, await json.json()], [404, { reply: NOT_FOUND_REPLY }]);
      // The rest of the app is unaffected.
      assert.equal((await fetch(`${url}/agents/public/health`)).status, 200);
    });
  });
});

// Sanity: the constants imported above are the exact strings server.ts sends, not independent copies.
describe("hoisted reply constants", () => {
  it("match the documented malformed-JSON and generic-error replies", async () => {
    await withServer({ handleChat: async () => Promise.reject(new TypeError("boom")) }, async (url) => {
      const malformed = await fetch(`${url}/agents/users/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
      assert.deepEqual(await malformed.json(), { reply: MALFORMED_JSON_REPLY });
      const generic = await fetch(`${url}/agents/users/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.deepEqual(await generic.json(), { reply: GENERIC_ERROR_REPLY });
    });
  });
});
