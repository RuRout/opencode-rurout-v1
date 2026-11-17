/**
 * Request-level domain failover for the RuRout gateway.
 *
 * All default domains are the same server, so a request may move between
 * them, but only when it provably never reached the server: the customer is
 * billed per request, and replaying a request that was already delivered would
 * charge it twice. The rules:
 *
 * - "Connection not established" errors (DNS failure, refused/unreachable
 *   connect, connect timeout, TLS handshake or certificate failure) mean no
 *   byte of the request was sent. The same request is replayed on the next
 *   domain.
 * - Any HTTP response (including 4xx/5xx), a user abort, and every other
 *   failure (reset or timeout after the request may have been sent) are
 *   surfaced as-is and never replayed.
 * - A domain that failed (safely or not) is tried last for `suspectMs`, so
 *   the next request already starts on another domain. A response clears the
 *   suspicion. There are no timers, sleeps or retry loops: one request makes
 *   at most one attempt per domain.
 *
 * State is a plain timestamp per domain, updated synchronously, so concurrent
 * requests cannot corrupt it.
 */

type FetchFn = (input: any, init?: any) => Promise<Response>;

export interface FailoverOptions {
  /** Base URLs in priority order, e.g. `https://rurout.com/v1`. */
  bases: string[];
  /** Underlying fetch; defaults to the global one, resolved on every call. */
  fetch?: FetchFn;
  /** When this returns false the wrapper is a plain pass-through. */
  enabled?: () => boolean;
  suspectMs: number;
  now?: () => number;
  onSwitch?: (from: string, to: string) => void;
}

export interface Failover {
  fetch: (input: any, init?: any) => Promise<Response>;
  /** Domains in the order the next request would try them. */
  order(): string[];
  /** Records the outcome of discovery: earlier domains failed, this one answered. */
  noteDiscovery(reachableBase: string): void;
}

// Errors that can only happen before the request is written to the wire.
const NOT_ESTABLISHED_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "EAI_NODATA",
  "EAI_FAIL",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  // Certificate verification and handshake-level TLS failures.
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
  "ERR_SSL_TLSV1_UNRECOGNIZED_NAME",
  // Bun's names for a failed connect.
  "ConnectionRefused",
  "FailedToOpenSocket",
]);
const TLS_HANDSHAKE_RESET = "before secure TLS connection was established";

/** True only when the error proves the request was never sent. */
export function isConnectionNotEstablished(err: unknown): boolean {
  let current: any = err;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const code = typeof current.code === "string" ? current.code : "";
    if (NOT_ESTABLISHED_CODES.has(code)) return true;
    // ETIMEDOUT is also what a stalled established socket reports; only the
    // connect syscall proves nothing was sent.
    if (code === "ETIMEDOUT" && current.syscall === "connect") return true;
    // A reset during the TLS handshake (typical of SNI blocking) carries this
    // exact text; a plain ECONNRESET may come after the request was written.
    if (
      code === "ECONNRESET" &&
      typeof current.message === "string" &&
      current.message.includes(TLS_HANDSHAKE_RESET)
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function isAbortLike(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

// A signal aborted by the caller (Esc, cancelled session) says nothing about
// the domain. An abort whose reason is a timeout means the server did not
// answer in time, which does.
function abortedByUser(signal: AbortSignal | null | undefined): boolean {
  if (!signal?.aborted) return false;
  const reason = signal.reason as { name?: unknown } | undefined;
  return !!reason && typeof reason === "object" && reason.name === "AbortError";
}

function isReplayableBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body === "string") return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  // Streams and iterables may already be partly consumed.
  return false;
}

export function createFailover(options: FailoverOptions): Failover {
  const bases = options.bases.map((base) => base.replace(/\/$/, ""));
  const now = options.now ?? Date.now;
  const enabled = options.enabled ?? (() => true);
  const suspectUntil = new Array<number>(bases.length).fill(0);
  const underlying: FetchFn =
    options.fetch ?? ((input, init) => (globalThis.fetch as FetchFn)(input, init));
  let current = bases[0];

  function order(): number[] {
    const t = now();
    const healthy: number[] = [];
    const suspect: number[] = [];
    for (let i = 0; i < bases.length; i++) (suspectUntil[i] > t ? suspect : healthy).push(i);
    return [...healthy, ...suspect];
  }

  function markSuspect(i: number): void {
    suspectUntil[i] = now() + options.suspectMs;
  }

  function markHealthy(i: number): void {
    suspectUntil[i] = 0;
    if (current !== bases[i]) {
      const from = current;
      current = bases[i];
      options.onSwitch?.(from, current);
    }
  }

  // Splits a request URL into the known base it starts with and the rest.
  function locate(url: string): { rest: string } | undefined {
    for (const base of bases) {
      if (url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`)) {
        return { rest: url.slice(base.length) };
      }
    }
    return undefined;
  }

  async function failoverFetch(input: any, init?: any): Promise<Response> {
    if (!enabled()) return underlying(input, init);
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const url = isRequest ? input.url : input instanceof URL ? input.href : String(input);
    const target = locate(url);
    if (!target) return underlying(input, init);

    const signal: AbortSignal | null | undefined = init?.signal ?? (isRequest ? input.signal : undefined);
    const replayable = isRequest
      ? input.body === null && isReplayableBody(init?.body)
      : isReplayableBody(init?.body);
    const candidates = order();
    let lastError: unknown;
    for (let n = 0; n < candidates.length; n++) {
      const i = candidates[n];
      // Never start another attempt for a request the caller already gave up on.
      if (n > 0 && signal?.aborted) throw signal.reason ?? lastError;
      const next = `${bases[i]}${target.rest}`;
      const attemptInput = isRequest ? new Request(next, input) : next;
      try {
        const response = await underlying(attemptInput, init);
        markHealthy(i);
        return response;
      } catch (err) {
        if (isAbortLike(err) && abortedByUser(signal)) throw err;
        if (!signal?.aborted && isAbortLike(err)) throw err;
        markSuspect(i);
        const safe = !signal?.aborted && isConnectionNotEstablished(err);
        if (!safe || !replayable || n === candidates.length - 1) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  return {
    fetch: failoverFetch,
    order: () => order().map((i) => bases[i]),
    noteDiscovery(reachableBase: string) {
      const reachable = bases.indexOf(reachableBase.replace(/\/$/, ""));
      if (reachable < 0) return;
      for (let i = 0; i < reachable; i++) markSuspect(i);
      markHealthy(reachable);
    },
  };
}
