import assert from "node:assert/strict";
import { test } from "node:test";
import { toV1Model, toV1Models } from "../dist/model.js";
import { lookup } from "../dist/fallback.js";

test("unknown models use authoritative API metadata without a catalog entry", () => {
  const model = toV1Model({
    id: "vendor/new-model-preview-high-20990101",
    display_name: "New_Model-preview (EXACT) High",
    context_window: 7654321,
    max_input_tokens: 7000000,
    max_output_tokens: 45678,
    reasoning: true,
    supports_tools: true,
    input_modalities: ["text", "image", "pdf"],
    output_modalities: ["text", "audio"],
    supported_reasoning_levels: ["low", "xhigh"],
    pricing: {
      currency: "USD", unit: "per_token", input_price: 0.000002,
      output_price: 0.000008, cache_read_price: 0.0000005, cache_write_price: 0.000003,
    },
  });
  assert.equal(model.id, "vendor/new-model-preview-high-20990101");
  assert.equal(model.name, "New_Model-preview (EXACT) High");
  assert.deepEqual(model.limit, { context: 7654321, input: 7000000, output: 45678 });
  assert.deepEqual(model.cost, { input: 2, output: 8, cache_read: 0.5, cache_write: 3 });
  assert.equal(model.reasoning, true);
  assert.equal(model.tool_call, true);
  assert.equal(model.attachment, true);
  assert.deepEqual(model.modalities, { input: ["text", "image", "pdf"], output: ["text", "audio"] });
  assert.deepEqual(model.variants, {
    low: { reasoningEffort: "low" }, xhigh: { reasoningEffort: "xhigh" },
    medium: { disabled: true }, high: { disabled: true },
  });
});

test("merges partial metadata field by field with the existing fallback table", () => {
  const fallback = lookup("claude-opus-4-6");
  const model = toV1Model({
    id: "claude-opus-4-6", max_output_tokens: 32000, reasoning: false,
    pricing: { currency: "USD", unit: "per_token", input_price: 0.000007, output_price: null },
  });
  assert.equal(model.limit.context, fallback.context);
  assert.equal(model.limit.output, 32000);
  assert.equal("input" in model.limit, false);
  assert.deepEqual(model.cost, { input: 7, output: fallback.outputCost, cache_read: fallback.cacheRead, cache_write: 0 });
  assert.equal(model.reasoning, false);
  assert.equal(model.tool_call, true);
  assert.equal(model.attachment, true);
});

test("zero prices, false capabilities and empty modality/level arrays are explicit values", () => {
  const model = toV1Model({
    id: "gpt-6-thinking", reasoning: false, supports_tools: false,
    input_modalities: [], output_modalities: [], supported_reasoning_levels: [],
    pricing: { currency: "USD", unit: "per_token", input_price: 0, output_price: 0, cache_read_price: 0, cache_write_price: 0 },
  });
  assert.deepEqual(model.cost, { input: 0, output: 0, cache_read: 0, cache_write: 0 });
  assert.equal(model.reasoning, false);
  assert.equal(model.tool_call, false);
  assert.equal(model.attachment, false);
  assert.deepEqual(model.modalities, { input: [], output: [] });
  assert.deepEqual(model.variants, { low: { disabled: true }, medium: { disabled: true }, high: { disabled: true } });
});

test("invalid fields do not poison valid siblings or remove the model", () => {
  for (const invalid of [null, -1, "100", false, {}, [], NaN, Infinity]) {
    const model = toV1Model({
      id: "claude-opus-4-6", context_window: invalid, max_output_tokens: 12345,
      max_input_tokens: invalid, reasoning: "false", supports_tools: 0,
      input_modalities: ["text", 42], output_modalities: ["audio"],
      pricing: { currency: "USD", unit: "per_token", input_price: invalid, output_price: 0.000002 },
    });
    assert.equal(model.limit.context, 1000000);
    assert.equal(model.limit.output, 12345);
    assert.equal("input" in model.limit, false);
    assert.equal(model.cost.input, 5);
    assert.equal(model.cost.output, 2);
    assert.equal(model.tool_call, true);
    assert.deepEqual(model.modalities.input, ["text", "image"]);
    assert.deepEqual(model.modalities.output, ["audio"]);
  }
});

test("token limits require positive safe integers and clamp only inconsistent ceilings", () => {
  for (const invalid of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "5000", NaN, Infinity]) {
    const model = toV1Model({ id: "unknown", context_window: invalid, max_output_tokens: invalid, max_input_tokens: invalid });
    assert.deepEqual(model.limit, { context: 200000, output: 32000 });
  }
  assert.deepEqual(toV1Model({ id: "unknown", context_window: 7777, max_input_tokens: 9999, max_output_tokens: 8888 }).limit,
    { context: 7777, input: 7777, output: 7777 });
  assert.deepEqual(toV1Model({ id: "unknown", context_window: 9876543, max_output_tokens: 5555 }).limit,
    { context: 9876543, output: 5555 });
  assert.deepEqual(toV1Model({ id: "unknown", context_length: 99999, limit: { input: 80000, output: 1234 } }).limit,
    { context: 99999, input: 80000, output: 1234 });
  assert.equal(toV1Model({ id: "unknown", max_context_length: 44444 }).limit.context, 44444);
});

test("pricing must explicitly use the USD per_token contract", () => {
  for (const pricing of [null, [], "invalid", {},
    { input_price: 0 }, { currency: "USD", input_price: 0 },
    { currency: "EUR", unit: "per_token", input_price: 0 },
    { currency: "USD", unit: "per_million_tokens", input_price: 0 },
    { currency: "USD", unit: "unknown", input_price: 0 },
    { currency: "USD", unit: "per_token", input_price: Number.MAX_VALUE }]) {
    assert.equal(toV1Model({ id: "claude-opus-4-6", pricing }).cost.input, 5);
  }
});

test("server display_name then name are used verbatim; only absent names use existing labels", () => {
  assert.equal(toV1Model({ id: "gpt-6", display_name: " gpt-6-preview-high ", name: "other" }).name, " gpt-6-preview-high ");
  assert.equal(toV1Model({ id: "gpt-6", display_name: " ", name: "gpt-6-tiered" }).name, "gpt-6-tiered");
  assert.equal(toV1Model({ id: "gpt-6", display_name: 42, name: false }).name, "RuRout GPT 6");
});

test("inventory and API IDs come only from response entries, including arbitrary variants", () => {
  const ids = ["gpt-6-high", "gpt-6-low", "gpt-6-preview", "gpt-6-thinking", "gpt-6-tiered", "gpt-6-20261017", "vendor/odd:id@v3", "__proto__"];
  const models = toV1Models(ids.map((id) => ({ id })));
  assert.deepEqual(Object.keys(models), ids);
  assert.deepEqual(Object.values(models).map((model) => model.id), ids);
  assert.deepEqual(models.__proto__.limit, { context: 200000, output: 32000 });
  assert.deepEqual(toV1Models([]), {});
});

test("invalid reasoning levels fall back without enabling made-up variants", () => {
  for (const levels of [null, "high", ["high", 42], [""]]) {
    assert.equal(toV1Model({ id: "unknown", supported_reasoning_levels: levels }).variants, undefined);
  }
});
