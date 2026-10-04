import type { AuthHook, Config, Hooks, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import {
  DEFAULT_BASE_URLS,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "./constants.js";
import { fetchGatewayModelsFrom } from "./discovery.js";
import { keyFingerprint, purgeLegacyFileCache } from "./cache.js";
import {
  displayName,
  familyOf,
  isImage,
  isReasoning,
  lookup,
  supportsVision,
} from "./fallback.js";

interface RuroutOptions {
  baseURL?: string;
}

type AnyRecord = Record<string, any>;

/**
 * An explicit address (plugin option or RUROUT_BASE_URL) is used as-is, with
 * no failover. Without one, the default domains are tried in order.
 */
function baseURLsFrom(opts: RuroutOptions): string[] {
  const explicit = opts.baseURL ?? process.env.RUROUT_BASE_URL;
  if (explicit) return [explicit.replace(/\/$/, "")];
  return DEFAULT_BASE_URLS;
}

/** Keys pasted into /connect or a shell often carry trailing whitespace. */
function normalizeKey(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function providerApiKey(provider: AnyRecord | undefined): string {
  const options = (provider?.options ?? {}) as Record<string, unknown>;
  for (const field of ["apiKey", "api_key", "key", "token"] as const) {
    const key = normalizeKey(options[field]);
    if (key) return key;
  }
  return normalizeKey(process.env.RUROUT_API_KEY);
}

function resolveApiKey(provider: AnyRecord | undefined): string {
  return providerApiKey(provider);
}

async function buildModelsForKey(
  input: PluginInput,
  baseURLs: string[],
  apiKey: string,
): Promise<{ models: Record<string, AnyRecord>; keyLabel: string; baseURL: string } | null> {
  let live;
  let baseURL: string;
  try {
    ({ baseURL, models: live } = await fetchGatewayModelsFrom(baseURLs, apiKey));
  } catch (err) {
    await log(
      input,
      "warn",
      `[rurout] model discovery failed for key ${keyFingerprint(apiKey)}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const keyLabel = await fetchKeyLabel(baseURL, apiKey);
  const models: Record<string, AnyRecord> = {};
  for (const entry of live) {
    // Preserve the exact ID returned for this key. Alias collapsing can select
    // an ID unavailable to the active key.
    const model = toV1Model(entry.id, entry.id, entry.display_name) as AnyRecord;
    const modelName = typeof model.name === "string" ? model.name : entry.id;
    if (keyLabel) {
      model.name = `RuRout ${keyLabel} ${displayName(entry.id, entry.display_name)}`;
    } else {
      model.name = modelName;
    }
    models[entry.id] = model;
  }
  return { models, keyLabel, baseURL };
}

async function log(
  input: PluginInput,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  try {
    await input.client.app.log({ body: { service: "rurout", level, message } });
  } catch {
    // Logging is best-effort.
  }
}

function toV1Model(canonical: string, apiId: string, display: string | undefined): AnyRecord {
  const fallback = lookup(canonical);
  const image = isImage(canonical);
  const text = !canonical.startsWith("gpt-image-") && !canonical.startsWith("dall-e-");
  const vision = supportsVision(canonical);
  const label = displayName(apiId, display);
  return {
    name: label.startsWith("RuRout") ? label : `RuRout ${label}`,
    family: familyOf(canonical),
    reasoning: isReasoning(apiId),
    tool_call: !image && text,
    attachment: vision,
    cost: {
      input: fallback.input > 0 ? fallback.input : 1,
      output: fallback.outputCost > 0 ? fallback.outputCost : 5,
      cache_read: fallback.cacheRead ?? 0,
    },
    limit: { context: fallback.context, output: fallback.output },
  };
}

async function fetchKeyLabel(baseURL: string, apiKey: string): Promise<string> {
  try {
    const response = await fetch(`${baseURL.replace(/\/$/, "")}/sub2api/billing`, {
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return "";
    const body = (await response.json()) as { key_name?: unknown; group_name?: unknown };
    const keyName = typeof body.key_name === "string" ? body.key_name.trim() : "";
    const groupName = typeof body.group_name === "string" ? body.group_name.trim() : "";
    return sanitizeLabel(keyName || groupName);
  } catch {
    return "";
  }
}

function sanitizeLabel(raw: string): string {
  const cleaned = raw
    .replace(/[^\p{L}\p{N} _-]+/gu, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  if (!cleaned) return "";
  return cleaned
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

async function ruroutPlugin(input: PluginInput, rawOpts?: RuroutOptions): Promise<Hooks> {
  const baseURLs = baseURLsFrom(rawOpts ?? {});
  // Follows the address that answered discovery, so the image tool uses the
  // same reachable domain as the provider.
  let baseURL = baseURLs[0];
  // Last key seen by the auth loader (/connect) and by model discovery, so
  // tools authenticate exactly like the provider does.
  let connectedKey = "";
  let discoveryKey = "";
  const activeApiKey = () => connectedKey || discoveryKey || normalizeKey(process.env.RUROUT_API_KEY);
  const refreshTimer = setInterval(() => {
    void (async () => {
      try {
        // Reapply the running configuration so the config hook resolves the
        // current auth key and replaces the model inventory without a restart.
        const response = await (input.client.config.get as any)({
          query: { directory: input.directory },
        });
        const config = (response as AnyRecord)?.data ?? response;
        if (!config || typeof config !== "object") return;
        await (input.client.config.update as any)({
          query: { directory: input.directory },
          body: config,
        });
      } catch {
        // The next hourly tick retries; keep the last successful inventory.
      }
    })();
  }, 60 * 60 * 1000);
  if (typeof (refreshTimer as unknown as { unref?: () => void }).unref === "function") {
    (refreshTimer as unknown as { unref: () => void }).unref();
  }
  return {
    async config(config: Config) {
      const root = config as AnyRecord;
      root.provider = root.provider ?? {};
      const existing = (root.provider[PROVIDER_ID] ?? {}) as AnyRecord;
      const options = { ...((existing.options ?? {}) as Record<string, unknown>) };
      // A provider baseURL from the user's config is an explicit address and
      // disables failover. The default domains are not: OpenCode hands the
      // address we set on a previous run back to us, and it must stay free to
      // move to the other default domain.
      const configured =
        typeof options.baseURL === "string" ? options.baseURL.replace(/\/$/, "") : "";
      const candidates =
        configured && !DEFAULT_BASE_URLS.includes(configured) ? [configured] : baseURLs;
      options.baseURL = candidates[0];
      baseURL = candidates[0];
      const provider: AnyRecord = {
        ...existing,
        npm: "@ai-sdk/openai-compatible",
        name: existing.name ?? PROVIDER_NAME,
        options,
        models: {},
      };
      root.provider[PROVIDER_ID] = provider;

      await purgeLegacyFileCache((message) => void log(input, "info", message));

       const apiKey = resolveApiKey(provider);
       discoveryKey = apiKey;
       if (!apiKey) {
         await log(input, "warn", "[rurout] no API key yet — run /connect rurout, then restart");
         return;
       }
       const built = await buildModelsForKey(input, candidates, apiKey);
       if (!built) return;
       if (built.baseURL !== options.baseURL) {
         await log(input, "info", `[rurout] gateway address switched to ${built.baseURL}`);
       }
       options.baseURL = built.baseURL;
       baseURL = built.baseURL;
       provider.name = built.keyLabel ? `RuRout ${built.keyLabel}` : PROVIDER_NAME;
       provider.models = built.models;
       await log(input, "info", `[rurout] discovered ${Object.keys(built.models).length} models for active key ${keyFingerprint(apiKey)}`);
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "API Key",
          prompts: [
            {
              type: "text",
              key: "api_key",
              message: "Enter your rurout API key:",
              placeholder: "sk-...",
            },
          ],
          async authorize(inputs) {
            const key = normalizeKey(inputs?.api_key);
            if (!key) return { type: "failed" };
            return { type: "success", key };
          },
        },
      ],
      loader: async (getAuth) => {
        try {
          const auth = await getAuth();
          if (!auth) return {};
          const key = auth.type === "api" ? normalizeKey(auth.key) : "";
          if (key) {
            connectedKey = key;
            return { apiKey: key };
          }
          return {};
        } catch {
          return {};
        }
      },
    } satisfies AuthHook,
    dispose: async () => {
      clearInterval(refreshTimer);
    },
    tool: {
      generate_image: tool({
        description: "Generate an image with a RuRout image model available for your key and save it locally.",
        args: {
          prompt: tool.schema.string().describe("Text description of the image to generate."),
          model: tool.schema.string().optional().describe("Image generation model (e.g. 'gpt-image-2', 'gemini-3.1-flash-image'; must be listed for your key). Default: 'gpt-image-2'."),
          size: tool.schema.string().optional().describe("Size, e.g. '1024x1024'."),
          output_path: tool.schema.string().optional().describe("Local path to save the generated image file."),
        },
        async execute(args) {
          const authKey = activeApiKey();
          if (!authKey) return "No RuRout API key: run /connect rurout first.";
          const model = args.model || "gpt-image-2";
          const size = args.size || "1024x1024";
          const prompt = args.prompt;
          const { mkdir, writeFile } = await import("node:fs/promises");
          const { dirname, resolve } = await import("node:path");
          // Relative paths are resolved against the project, not the server's cwd.
          const outputPath = resolve(input.directory, args.output_path || `image_${Date.now()}.png`);

          const endpoint = baseURL.endsWith("/v1")
            ? `${baseURL}/images/generations`
            : `${baseURL}/v1/images/generations`;
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authKey}`,
            },
            body: JSON.stringify({
              model,
              prompt,
              size,
              response_format: "b64_json",
            }),
          });
          if (!res.ok) {
            return `Image generation failed (${res.status}): ${await res.text()}`;
          }
          const data = (await res.json()) as any;
          const imgItem = data?.data?.[0];
          if (imgItem?.b64_json) {
            await mkdir(dirname(outputPath), { recursive: true });
            await writeFile(outputPath, Buffer.from(imgItem.b64_json, "base64"));
            return `Image generated and saved to ${outputPath}`;
          }
          return `Image generation result: ${JSON.stringify(imgItem)}`;
        },
      }),
    },
  };
}

export default ruroutPlugin;
