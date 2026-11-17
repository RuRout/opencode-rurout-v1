import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { promises as fs } from "node:fs";
import ruroutPlugin from "../dist/index.js";

const realFetch = globalThis.fetch;
const oldEnv = { key: process.env.RUROUT_API_KEY, base: process.env.RUROUT_BASE_URL, auth: process.env.OPENCODE_AUTH_CONTENT };

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = realFetch;
  for (const [name, value] of [["RUROUT_API_KEY", oldEnv.key], ["RUROUT_BASE_URL", oldEnv.base], ["OPENCODE_AUTH_CONTENT", oldEnv.auth]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const refused = () => new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });

function host() {
  return {
    directory: "/unused",
    client: { app: { log: async () => {} }, config: { get: async () => ({}), update: async () => ({}) } },
  };
}

async function boot(handlers) {
  mock.method(fs, "readdir", async () => []);
  process.env.RUROUT_API_KEY = "k";
  delete process.env.OPENCODE_AUTH_CONTENT;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const handler = handlers[new URL(String(url)).origin];
    if (!handler) throw new Error(`unexpected ${url}`);
    return handler(String(url));
  };
  const hooks = await ruroutPlugin(host());
  const config = { provider: {} };
  await hooks.config(config);
  const provider = config.provider.rurout;
  const loaded = await hooks.auth.loader(async () => undefined, provider);
  return { hooks, provider, loaded, calls };
}

const models = (url) =>
  url.endsWith("/models") ? Response.json({ data: [{ id: "m" }] }) : new Response("{}", { status: 200 });

test("the provider gets a failover fetch that starts on the domain discovery found", async () => {
  delete process.env.RUROUT_BASE_URL;
  const t = await boot({
    "https://rurout.com": () => { throw refused(); },
    "https://rurout.ru": models,
  });
  assert.equal(t.provider.options.baseURL, "https://rurout.ru/v1");
  const before = t.calls.length;
  const res = await t.loaded.fetch("https://rurout.ru/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  assert.deepEqual(t.calls.slice(before), ["https://rurout.ru/v1/chat/completions"]);
});

test("a domain that drops mid-session moves the next request, not the sent one", async () => {
  delete process.env.RUROUT_BASE_URL;
  let comUp = true;
  const t = await boot({
    "https://rurout.com": (url) => {
      if (!comUp) throw refused();
      return models(url);
    },
    "https://rurout.ru": models,
  });
  assert.equal(t.provider.options.baseURL, "https://rurout.com/v1");
  const before = t.calls.length;
  comUp = false;
  const res = await t.loaded.fetch("https://rurout.com/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  assert.deepEqual(t.calls.slice(before), [
    "https://rurout.com/v1/chat/completions",
    "https://rurout.ru/v1/chat/completions",
  ]);
});

test("an explicit RUROUT_BASE_URL disables request failover", async () => {
  process.env.RUROUT_BASE_URL = "https://rurout.com/v1";
  const t = await boot({
    "https://rurout.com": (url) => (url.endsWith("/chat/completions") ? (() => { throw refused(); })() : models(url)),
    "https://rurout.ru": models,
  });
  const before = t.calls.length;
  await assert.rejects(t.loaded.fetch("https://rurout.com/v1/chat/completions", { method: "POST", body: "{}" }));
  assert.deepEqual(t.calls.slice(before), ["https://rurout.com/v1/chat/completions"]);
});
