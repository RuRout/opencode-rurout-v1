import type { GatewayModel } from "./discovery.js";
import { displayName, familyOf, isImage, isReasoning, lookup, supportsVision } from "./fallback.js";

const MODALITIES = ["text", "audio", "image", "video", "pdf"] as const;
type Modality = (typeof MODALITIES)[number];

export interface V1Model {
  id: string;
  name: string;
  family: string;
  reasoning: boolean;
  tool_call: boolean;
  attachment: boolean;
  modalities: { input: Modality[]; output: Modality[] };
  cost: { input: number; output: number; cache_read: number; cache_write: number };
  limit: { context: number; output: number; input?: number };
  variants?: Record<string, { reasoningEffort?: string; disabled?: boolean }>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function modalities(value: unknown): Modality[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => MODALITIES.includes(item))) return undefined;
  return [...new Set(value)] as Modality[];
}

/** Only the explicit gateway USD/token contract is accepted; never infer units. */
function tokenPrice(pricing: Record<string, unknown>, field: string): number | undefined {
  if (pricing.currency !== "USD" || pricing.unit !== "per_token") return undefined;
  const value = pricing[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const perMillion = value * 1_000_000;
  return Number.isFinite(perMillion) ? perMillion : undefined;
}

/** Pure API-first, per-field adapter. The fallback catalog never supplies model IDs. */
export function toV1Model(entry: GatewayModel): V1Model {
  const fallback = lookup(entry.id);
  const legacyLimit = record(entry.limit);
  const context = positiveInteger(entry.context_window)
    ?? positiveInteger(entry.context_length)
    ?? positiveInteger(entry.max_context_length)
    ?? positiveInteger(legacyLimit.context)
    ?? fallback.context;
  const output = Math.min(context, positiveInteger(entry.max_output_tokens)
    ?? positiveInteger(legacyLimit.output) ?? fallback.output);
  const input = positiveInteger(entry.max_input_tokens) ?? positiveInteger(legacyLimit.input);
  const vision = supportsVision(entry.id);
  const inputModalities: Modality[] = modalities(entry.input_modalities) ?? (vision ? ["text", "image"] : ["text"]);
  const outputModalities: Modality[] = modalities(entry.output_modalities) ?? (isImage(entry.id) ? ["image"] : ["text"]);
  const reasoning = typeof entry.reasoning === "boolean" ? entry.reasoning : isReasoning(entry.id);
  const pricing = record(entry.pricing);
  const label = displayName(entry.id);
  const model: V1Model = {
    id: entry.id,
    // A server-supplied label is authoritative, including punctuation and suffixes.
    name: nonempty(entry.display_name) ?? nonempty(entry.name)
      ?? (label.startsWith("RuRout") ? label : `RuRout ${label}`),
    family: familyOf(entry.id),
    reasoning,
    tool_call: typeof entry.supports_tools === "boolean" ? entry.supports_tools : !isImage(entry.id),
    attachment: inputModalities.some((item) => item !== "text"),
    modalities: { input: inputModalities, output: outputModalities },
    cost: {
      input: tokenPrice(pricing, "input_price") ?? fallback.input,
      output: tokenPrice(pricing, "output_price") ?? fallback.outputCost,
      cache_read: tokenPrice(pricing, "cache_read_price") ?? fallback.cacheRead ?? 0,
      cache_write: tokenPrice(pricing, "cache_write_price") ?? 0,
    },
    // A smaller context clamps separate input/output ceilings, not vice versa.
    limit: { context, output, ...(input !== undefined ? { input: Math.min(input, context) } : {}) },
  };
  const levels = entry.supported_reasoning_levels;
  if (Array.isArray(levels) && levels.every((level) => nonempty(level) !== undefined)) {
    const enabled = reasoning ? new Set<string>(levels) : new Set<string>();
    // V1 auto-generates these defaults. Disable absent ones rather than inventing support.
    model.variants = Object.fromEntries([
      ...["low", "medium", "high"].filter((level) => !enabled.has(level))
        .map((level) => [level, { disabled: true }]),
      ...[...enabled].map((level) => [level, { reasoningEffort: level }]),
    ]);
  }
  return model;
}

export function toV1Models(entries: GatewayModel[]): Record<string, V1Model> {
  return Object.fromEntries(entries.map((entry) => [entry.id, toV1Model(entry)]));
}
