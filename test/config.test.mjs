import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { promises as fs } from "node:fs";
import ruroutPlugin from "../dist/index.js";

const realFetch = globalThis.fetch;
const oldInlineAuth = process.env.OPENCODE_AUTH_CONTENT;
const oldEnvKey = process.env.RUROUT_API_KEY;

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = realFetch;
  if (oldInlineAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT;
  else process.env.OPENCODE_AUTH_CONTENT = oldInlineAuth;
  if (oldEnvKey === undefined) delete process.env.RUROUT_API_KEY;
  else process.env.RUROUT_API_KEY = oldEnvKey;
});

test("config-time stored auth discovers before the auth loader and refreshes without config writes", async () => {
  mock.method(fs, "readdir", async () => []);
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ rurout: { type: "api", key: "stored" } });
  process.env.RUROUT_API_KEY = "env";
  let entries = [{ id: "vendor/new-high", display_name: "Unchanged-preview-High", context_window: 765432,
    supports_tools: false, pricing: { currency: "USD", unit: "per_token", input_price: 0 } }];
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), auth: options.headers.Authorization });
    if (String(url).endsWith("/models")) return Response.json({ data: entries });
    if (String(url).endsWith("/sub2api/billing")) return Response.json({ key_name: "Key Label" });
    throw new Error("unexpected request");
  };
  const hooks = await ruroutPlugin({
    directory: "/unused",
    client: {
      app: { log: async () => {} },
      config: {
        get: async () => { throw new Error("must not read config through SDK"); },
        update: async () => { throw new Error("must not write config through SDK"); },
      },
    },
  });
  const config = { provider: { rurout: { models: { stale: {} } } }, compaction: { auto: false } };
  await hooks.config(config);
  assert.equal(config.provider.rurout.options.apiKey, "stored");
  assert.equal(config.provider.rurout.name, "RuRout Key Label");
  assert.deepEqual(Object.keys(config.provider.rurout.models), ["vendor/new-high"]);
  const model = config.provider.rurout.models["vendor/new-high"];
  assert.equal(model.name, "Unchanged-preview-High");
  assert.equal(model.limit.context, 765432);
  assert.equal(model.cost.input, 0);
  assert.equal(model.tool_call, false);
  assert.deepEqual(config.compaction, { auto: false });

  // Model fields are fetched again on every config hook invocation, not cached by the plugin.
  entries = [{ id: "vendor/new-low", name: "New Low", context_window: 987654 }];
  await hooks.config(config);
  assert.deepEqual(Object.keys(config.provider.rurout.models), ["vendor/new-low"]);
  assert.equal(config.provider.rurout.models["vendor/new-low"].limit.context, 987654);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.auth === "Bearer stored"));
  assert.deepEqual(await hooks.auth.loader(async () => ({ type: "api", key: "different" }), config.provider.rurout),
    { apiKey: "stored" });
});
