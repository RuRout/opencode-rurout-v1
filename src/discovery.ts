import { DISCOVERY_TIMEOUT_MS } from "./constants.js";

const AUTH_ERROR_PREFIX = "gateway rejected the API key";

export interface GatewayModel {
  id: string;
  display_name?: string;
  created_at?: string;
}

export async function fetchGatewayModels(
  baseURL: string,
  apiKey: string,
  attempts = 3,
): Promise<GatewayModel[]> {
  const url = `${baseURL.replace(/\/$/, "")}/models`;
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(300 * (attempt + 1));
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${AUTH_ERROR_PREFIX} (invalid or disabled)`);
    }
    if (!response.ok) {
      lastError = `${response.status} ${response.statusText}`;
      await sleep(300 * (attempt + 1));
      continue;
    }
    const body = (await response.json()) as { data?: GatewayModel[] };
    const list = Array.isArray(body.data) ? body.data : [];
    const models = list.filter((m) => typeof m?.id === "string" && m.id.length > 0);
    return models;
  }
  throw new Error(`gateway discovery failed at ${url}: ${lastError}`);
}

export function isAuthError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(AUTH_ERROR_PREFIX);
}

/**
 * Discovers models from the first reachable gateway address. Candidates are
 * tried in order; only an unreachable address (network error / non-OK
 * status) moves on to the next one. A rejected key means the gateway
 * answered, so it is surfaced immediately instead of masked.
 */
export async function fetchGatewayModelsFrom(
  baseURLs: string[],
  apiKey: string,
): Promise<{ baseURL: string; models: GatewayModel[] }> {
  let lastError: unknown = new Error("no gateway address configured");
  for (let i = 0; i < baseURLs.length; i++) {
    const baseURL = baseURLs[i];
    const last = i === baseURLs.length - 1;
    try {
      // Fail over fast on all but the last address; the last one keeps the
      // full retry budget for a flaky-but-single gateway.
      const models = await fetchGatewayModels(baseURL, apiKey, last ? 3 : 1);
      return { baseURL, models };
    } catch (err) {
      if (isAuthError(err)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
