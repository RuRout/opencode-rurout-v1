import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readStoredApiKey, resolveApiKey } from "../dist/auth.js";

const content = (key) => JSON.stringify({ rurout: { type: "api", key } });

test("reads inline API auth without accessing the filesystem", async () => {
  const key = await readStoredApiKey({ OPENCODE_AUTH_CONTENT: content(" inline ") }, "/unused", async () => {
    throw new Error("must not read");
  });
  assert.equal(key, "inline");
});

test("uses XDG_DATA_HOME or the documented V1 home path", async () => {
  const paths = [];
  const read = async (path) => { paths.push(path); return content("stored"); };
  assert.equal(await readStoredApiKey({ XDG_DATA_HOME: "/data" }, "/home/test", read), "stored");
  assert.equal(await readStoredApiKey({}, "/home/test", read), "stored");
  assert.equal(await readStoredApiKey({ XDG_DATA_HOME: "relative" }, "/home/test", read), "stored");
  assert.deepEqual(paths, [join("/data", "opencode", "auth.json"),
    join("/home/test", ".local", "share", "opencode", "auth.json"),
    join("/home/test", ".local", "share", "opencode", "auth.json")]);
});

test("missing/malformed/other auth types are unauthenticated, not logged or written", async () => {
  for (const value of ["{", "null", "[]", "{}", JSON.stringify({ rurout: { type: "oauth", key: "wrong" } }),
    JSON.stringify({ rurout: { type: "api", key: 42 } })]) {
    assert.equal(await readStoredApiKey({ OPENCODE_AUTH_CONTENT: value }), "");
  }
  assert.equal(await readStoredApiKey({}, "/unused", async () => { throw new Error("unreadable"); }), "");
});

test("provider options beat stored auth, which beats RUROUT_API_KEY", async () => {
  const env = { RUROUT_API_KEY: " env " };
  assert.equal(await resolveApiKey({ options: { apiKey: " configured " } }, env, async () => {
    throw new Error("must not read");
  }), "configured");
  assert.equal(await resolveApiKey(undefined, env, async () => "stored"), "stored");
  assert.equal(await resolveApiKey(undefined, env, async () => ""), "env");
  assert.equal(await resolveApiKey({ options: { apiKey: " ", api_key: " alias " } }, env, async () => "stored"), "alias");
});
