#!/bin/sh
# Checks that scripts/pack.sh is reproducible and that the archive has the
# layout the installer expects. Run after `npm ci && npm run build`.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The bundle must include the tool helper and Zod, leaving only Node builtins
# external. Inspect esbuild's graph rather than matching package names in
# comments (bundled sources legitimately retain their original paths).
node --input-type=module - "$root/dist/bundle-meta.json" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";

const meta = JSON.parse(readFileSync(process.argv[2], "utf8"));
const inputs = Object.keys(meta.inputs);
assert(inputs.some((path) => path.includes("node_modules/@opencode-ai/plugin/") && /\/tool\.[cm]?js$/.test(path)), "tool helper must be bundled");
assert(inputs.some((path) => path.includes("node_modules/zod/")), "Zod must be bundled");
const outputs = Object.values(meta.outputs);
assert.equal(outputs.length, 1, "release must be a single JavaScript bundle");
for (const entry of outputs[0].imports) {
  assert(entry.external && isBuiltin(entry.path), `Unexpected runtime import: ${entry.path}`);
}
assert.deepEqual(outputs[0].exports, ["default"], "V1 loader must see only the plugin function");
NODE

first=$(sh "$root/scripts/pack.sh" "$work/a" | tail -n 1)
second=$(sh "$root/scripts/pack.sh" "$work/b" | tail -n 1)
if [ "$first" != "$second" ]; then
  printf 'Archive is not reproducible:\n  %s\n  %s\n' "$first" "$second" >&2
  exit 1
fi

archive=$(ls "$work"/a/rurout-opencode-*.tar.gz)
version=$(node -p "require('$root/package.json').version")
case "$archive" in
  *"-$version.tar.gz") ;;
  *) printf 'Archive name does not carry version %s: %s\n' "$version" "$archive" >&2; exit 1 ;;
esac

listing=$(tar -tzf "$archive")
for f in index.js package.json; do
  printf '%s\n' "$listing" | grep -qx "$f" || { printf 'Archive is missing %s\n' "$f" >&2; exit 1; }
done
if printf '%s\n' "$listing" | grep -Eq '^/|\.\.|/|\.d\.ts$'; then
  printf '%s\n' 'Archive must hold only flat runtime files.' >&2
  exit 1
fi
if [ "$(printf '%s\n' "$listing" | wc -l | tr -d ' ')" != 2 ]; then
  printf '%s\n' 'Archive must contain only index.js and package.json.' >&2
  exit 1
fi

tar -xzOf "$archive" package.json | node -e '
const pkg = JSON.parse(require("fs").readFileSync(0, "utf8"));
const expected = process.argv[1];
if (pkg.name !== "rurout-connect" || pkg.version !== expected || pkg.type !== "module" || pkg.main !== "index.js") {
  console.error("Unexpected runtime package.json: " + JSON.stringify(pkg));
  process.exit(1);
}
if (Object.keys(pkg).sort().join(",") !== "main,name,type,version") {
  console.error("Runtime package.json must not declare dependencies or install hooks");
  process.exit(1);
}
' "$version"

# Match the V1 auto-loader layout: only the top-level wrapper matches
# plugins/*.{js,ts}; the bundle is nested to avoid loading it twice.
mkdir -p "$work/standalone/plugins/rurout-connect"
tar -xzf "$archive" -C "$work/standalone/plugins/rurout-connect"
printf '%s\n' '{"type":"module"}' > "$work/standalone/package.json"
printf '%s\n' "export { default } from './rurout-connect/index.js';" > "$work/standalone/plugins/rurout-connect.js"
# Deny package resolution explicitly, even if an ancestor of the temporary
# directory happens to contain node_modules. Only builtins and local files
# within this otherwise empty installation may be imported.
cat > "$work/standalone/isolated-loader.mjs" <<'NODE'
import { isBuiltin } from "node:module";
const root = new URL("./", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (isBuiltin(specifier)) return nextResolve(specifier, context);
  const url = new URL(specifier, context.parentURL ?? root);
  if (!/^(file:|\.\.?\/)/.test(specifier) || !url.href.startsWith(root)) {
    throw new Error(`Standalone plugin attempted external resolution: ${specifier}`);
  }
  return nextResolve(specifier, context);
}
NODE
(
  cd "$work/standalone"
  NODE_PATH= NODE_OPTIONS= node --experimental-loader ./isolated-loader.mjs --input-type=module - "$root" <<'NODE'
import assert from "node:assert/strict";
import { realpathSync, readdirSync } from "node:fs";
import { relative, isAbsolute } from "node:path";

const relativePath = relative(realpathSync(process.argv[2]), realpathSync("."));
assert(isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith("../"), "standalone import must run outside the source repository");
assert.deepEqual(readdirSync("plugins").filter((name) => /\.(js|ts)$/.test(name)), ["rurout-connect.js"]);
const plugin = await import("./plugins/rurout-connect.js");
assert.deepEqual(Object.keys(plugin), ["default"]);
assert.equal(typeof plugin.default, "function");
const hooks = await plugin.default({ directory: process.cwd(), client: {} });
try {
  assert.equal(typeof hooks.config, "function");
  assert.equal(hooks.auth.provider, "rurout");
  assert.equal(typeof hooks.tool.generate_image.execute, "function");
  assert.equal(hooks.tool.generate_image.args.prompt.parse("offline smoke"), "offline smoke");
} finally {
  // V1 no longer owns an hourly timer or writes config to refresh discovery.
  if (hooks.dispose) await hooks.dispose();
}
NODE
)

printf 'ok  %s\n' "$first"
