import assert from "node:assert/strict";
import { test } from "node:test";
import { createFailover, isConnectionNotEstablished } from "../dist/failover.js";
import { DEFAULT_BASE_URLS, DOMAIN_SUSPECT_MS } from "../dist/constants.js";

const COM = "https://rurout.com/v1";
const RU = "https://rurout.ru/v1";
const ONLINE = "https://rurout.online/v1";
const CHAT = "/chat/completions";

function coded(code, extra = {}, message = code) {
  return Object.assign(new Error(message), { code, ...extra });
}
// What undici reports: a bare TypeError whose `cause` holds the system error.
function wrapped(cause) {
  return new TypeError("fetch failed", { cause });
}

// Builds a failover whose transport is scripted per origin. A handler is a
// function (url, init) returning a Response or throwing.
function setup(handlers, opts = {}) {
  const calls = [];
  const clock = { t: 1_000_000 };
  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    const origin = new URL(url).origin;
    const handler = handlers[origin];
    if (!handler) throw new Error(`unexpected ${url}`);
    return handler(url, init);
  };
  const switches = [];
  const failover = createFailover({
    bases: DEFAULT_BASE_URLS,
    fetch: fetchImpl,
    suspectMs: DOMAIN_SUSPECT_MS,
    now: () => clock.t,
    onSwitch: (from, to) => switches.push([from, to]),
    ...opts,
  });
  return { failover, calls, clock, switches, urls: () => calls.map((c) => c.url) };
}

const ok = () => new Response("ok", { status: 200 });
const fail = (err) => () => {
  throw err;
};
const post = { method: "POST", headers: { Authorization: "Bearer k" }, body: JSON.stringify({ n: 1 }) };

test("default domains are rurout.com, rurout.ru, rurout.online in that order", () => {
  assert.deepEqual(DEFAULT_BASE_URLS, [COM, RU, ONLINE]);
});

test("uses the primary domain and makes a single request when it answers", async () => {
  const t = setup({ "https://rurout.com": ok, "https://rurout.ru": ok });
  const res = await t.failover.fetch(`${RU}${CHAT}`, post);
  assert.equal(res.status, 200);
  // The URL was built for .ru, but the best domain is the primary one.
  assert.deepEqual(t.urls(), [`${COM}${CHAT}`]);
});

const SAFE = [
  ["DNS ENOTFOUND", coded("ENOTFOUND")],
  ["DNS EAI_AGAIN", coded("EAI_AGAIN")],
  ["ECONNREFUSED", coded("ECONNREFUSED")],
  ["ENETUNREACH", coded("ENETUNREACH")],
  ["EHOSTUNREACH", coded("EHOSTUNREACH")],
  ["connect timeout", coded("UND_ERR_CONNECT_TIMEOUT")],
  ["ETIMEDOUT while connecting", coded("ETIMEDOUT", { syscall: "connect" })],
  ["certificate altname mismatch", coded("ERR_TLS_CERT_ALTNAME_INVALID")],
  ["certificate chain", coded("UNABLE_TO_VERIFY_LEAF_SIGNATURE")],
  ["expired certificate", coded("CERT_HAS_EXPIRED")],
  ["TLS handshake failure", coded("ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE")],
  ["reset during TLS handshake", coded("ECONNRESET", {}, "Client network socket disconnected before secure TLS connection was established")],
  ["Bun connection refused", coded("ConnectionRefused")],
];

for (const [name, err] of SAFE) {
  test(`safe: ${name} replays the same request on the next domain and remembers it`, async () => {
    const t = setup({ "https://rurout.com": fail(wrapped(err)), "https://rurout.ru": ok });
    const res = await t.failover.fetch(`${COM}${CHAT}?x=1`, post);
    assert.equal(res.status, 200);
    assert.deepEqual(t.urls(), [`${COM}${CHAT}?x=1`, `${RU}${CHAT}?x=1`]);
    assert.equal(t.calls[1].init.body, post.body);
    assert.deepEqual(t.calls[1].init.headers, post.headers);
    assert.deepEqual(t.failover.order(), [RU, ONLINE, COM]);
    // The next request goes straight to the working domain.
    await t.failover.fetch(`${COM}${CHAT}`, post);
    assert.deepEqual(t.urls().slice(2), [`${RU}${CHAT}`]);
    assert.deepEqual(t.switches, [[COM, RU]]);
  });
}

const UNSAFE = [
  ["plain ECONNRESET (may be after send)", coded("ECONNRESET")],
  ["socket closed mid-request", coded("UND_ERR_SOCKET")],
  ["ETIMEDOUT on an established socket", coded("ETIMEDOUT", { syscall: "read" })],
  ["terminated", new TypeError("terminated")],
  ["headers timeout", coded("UND_ERR_HEADERS_TIMEOUT")],
  ["ECONNRESET with unrelated cause text", coded("ECONNRESET", {}, "read ECONNRESET")],
];

for (const [name, err] of UNSAFE) {
  test(`unsafe: ${name} is not replayed; domain becomes suspect for the next request`, async () => {
    const t = setup({ "https://rurout.com": fail(wrapped(err)), "https://rurout.ru": ok });
    await assert.rejects(t.failover.fetch(`${COM}${CHAT}`, post), (e) => e.cause === err);
    assert.deepEqual(t.urls(), [`${COM}${CHAT}`]);
    await t.failover.fetch(`${COM}${CHAT}`, post);
    assert.deepEqual(t.urls(), [`${COM}${CHAT}`, `${RU}${CHAT}`]);
  });
}

for (const status of [400, 401, 429, 500, 502, 503]) {
  test(`an HTTP ${status} answer is returned as-is, never replayed, and clears suspicion`, async () => {
    const t = setup({
      "https://rurout.com": () => new Response("x", { status }),
      "https://rurout.ru": ok,
    });
    const res = await t.failover.fetch(`${COM}${CHAT}`, post);
    assert.equal(res.status, status);
    assert.deepEqual(t.urls(), [`${COM}${CHAT}`]);
    await t.failover.fetch(`${COM}${CHAT}`, post);
    assert.deepEqual(t.urls().slice(1), [`${COM}${CHAT}`]);
    assert.deepEqual(t.switches, []);
  });
}

test("a user abort is rethrown, not replayed, and does not mark the domain", async () => {
  const ctrl = new AbortController();
  const t = setup({
    "https://rurout.com": (url, init) => {
      ctrl.abort();
      throw init.signal.reason;
    },
    "https://rurout.ru": ok,
  });
  await assert.rejects(t.failover.fetch(`${COM}${CHAT}`, { ...post, signal: ctrl.signal }), { name: "AbortError" });
  assert.deepEqual(t.urls(), [`${COM}${CHAT}`]);
  assert.deepEqual(t.failover.order(), [COM, RU, ONLINE]);
});

test("an abort that races with a connection error is still not replayed", async () => {
  const ctrl = new AbortController();
  const t = setup({
    "https://rurout.com": () => {
      ctrl.abort();
      throw wrapped(coded("ECONNREFUSED"));
    },
    "https://rurout.ru": ok,
  });
  await assert.rejects(t.failover.fetch(`${COM}${CHAT}`, { ...post, signal: ctrl.signal }));
  assert.deepEqual(t.urls(), [`${COM}${CHAT}`]);
});

test("a request timeout is not replayed but marks the domain suspect", async () => {
  const signal = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
  const t = setup({
    "https://rurout.com": () => {
      throw signal.reason;
    },
    "https://rurout.ru": ok,
  });
  await assert.rejects(t.failover.fetch(`${COM}${CHAT}`, { ...post, signal }), { name: "TimeoutError" });
  assert.deepEqual(t.urls(), [`${COM}${CHAT}`]);
  assert.deepEqual(t.failover.order(), [RU, ONLINE, COM]);
});

test("a stream body cannot be proven replayable: no replay, domain marked", async () => {
  const body = new ReadableStream({ start: (c) => c.close() });
  const t = setup({ "https://rurout.com": fail(wrapped(coded("ECONNREFUSED"))), "https://rurout.ru": ok });
  await assert.rejects(t.failover.fetch(`${COM}${CHAT}`, { method: "POST", body, duplex: "half" }));
  assert.deepEqual(t.urls(), [`${COM}${CHAT}`]);
  assert.deepEqual(t.failover.order(), [RU, ONLINE, COM]);
});

test("every domain unreachable: exactly one attempt per domain, then the last error", async () => {
  const last = wrapped(coded("ENOTFOUND"));
  const t = setup({
    "https://rurout.com": fail(wrapped(coded("ECONNREFUSED"))),
    "https://rurout.ru": fail(wrapped(coded("EAI_AGAIN"))),
    "https://rurout.online": fail(last),
  });
  await assert.rejects(t.failover.fetch(`${COM}${CHAT}`, post), (e) => e === last);
  assert.deepEqual(t.urls(), [`${COM}${CHAT}`, `${RU}${CHAT}`, `${ONLINE}${CHAT}`]);
  // Next request: all suspect, tried in priority order again, still bounded.
  await assert.rejects(t.failover.fetch(`${COM}${CHAT}`, post));
  assert.equal(t.calls.length, 6);
});

test("a domain that fails after a replayed request stops the chain when the next one answers over HTTP", async () => {
  const t = setup({
    "https://rurout.com": fail(wrapped(coded("ECONNREFUSED"))),
    "https://rurout.ru": () => new Response("bad", { status: 502 }),
    "https://rurout.online": ok,
  });
  const res = await t.failover.fetch(`${COM}${CHAT}`, post);
  assert.equal(res.status, 502);
  assert.deepEqual(t.urls(), [`${COM}${CHAT}`, `${RU}${CHAT}`]);
});

test("after the suspect window the primary domain is tried first again", async () => {
  let comUp = false;
  const t = setup({
    "https://rurout.com": () => {
      if (!comUp) throw wrapped(coded("ECONNREFUSED"));
      return ok();
    },
    "https://rurout.ru": ok,
  });
  await t.failover.fetch(`${COM}${CHAT}`, post);
  t.clock.t += DOMAIN_SUSPECT_MS - 1;
  await t.failover.fetch(`${COM}${CHAT}`, post);
  assert.deepEqual(t.urls(), [`${COM}${CHAT}`, `${RU}${CHAT}`, `${RU}${CHAT}`]);
  t.clock.t += 2;
  comUp = true;
  await t.failover.fetch(`${COM}${CHAT}`, post);
  assert.equal(t.urls().at(-1), `${COM}${CHAT}`);
  assert.deepEqual(t.switches, [[COM, RU], [RU, COM]]);
});

test("concurrent requests during an outage all succeed and leave consistent state", async () => {
  const t = setup({
    "https://rurout.com": async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw wrapped(coded("ECONNREFUSED"));
    },
    "https://rurout.ru": ok,
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => t.failover.fetch(`${COM}${CHAT}`, post)),
  );
  assert.ok(results.every((r) => r.status === 200));
  assert.deepEqual(t.failover.order(), [RU, ONLINE, COM]);
  assert.deepEqual(t.switches, [[COM, RU]]);
  await t.failover.fetch(`${COM}${CHAT}`, post);
  assert.equal(t.urls().at(-1), `${RU}${CHAT}`);
});

test("disabled failover (explicit address) and foreign URLs pass through untouched", async () => {
  const off = setup({ "https://rurout.com": ok }, { enabled: () => false });
  await off.failover.fetch(`${COM}${CHAT}`, post);
  assert.deepEqual(off.urls(), [`${COM}${CHAT}`]);

  const foreign = setup({ "https://example.org": ok });
  await foreign.failover.fetch("https://example.org/v1/x", post);
  await foreign.failover.fetch("https://rurout.com.evil.test/v1/x", post).catch(() => {});
  assert.deepEqual(foreign.urls(), ["https://example.org/v1/x", "https://rurout.com.evil.test/v1/x"]);
});

test("Request objects without a body are supported", async () => {
  const t = setup({ "https://rurout.com": fail(wrapped(coded("ECONNREFUSED"))), "https://rurout.ru": ok });
  const res = await t.failover.fetch(new Request(`${COM}/models`, { headers: { Authorization: "Bearer k" } }));
  assert.equal(res.status, 200);
  assert.deepEqual(t.urls(), [`${COM}/models`, `${RU}/models`]);
  assert.equal(t.calls[1].url, `${RU}/models`);
});

test("discovery outcome seeds the order: earlier domains failed, the answering one is preferred", async () => {
  const t = setup({ "https://rurout.ru": ok, "https://rurout.online": ok });
  t.failover.noteDiscovery(ONLINE);
  assert.deepEqual(t.failover.order(), [ONLINE, COM, RU]);
  await t.failover.fetch(`${COM}${CHAT}`, post);
  assert.deepEqual(t.urls(), [`${ONLINE}${CHAT}`]);
});

test("error classification inspects the cause chain only for provable pre-send failures", () => {
  assert.equal(isConnectionNotEstablished(wrapped(coded("ENOTFOUND"))), true);
  assert.equal(isConnectionNotEstablished(new Error("fetch failed")), false);
  assert.equal(isConnectionNotEstablished(coded("ECONNRESET")), false);
  assert.equal(isConnectionNotEstablished(undefined), false);
  assert.equal(isConnectionNotEstablished("ENOTFOUND"), false);
});
