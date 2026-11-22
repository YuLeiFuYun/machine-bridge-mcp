import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Deployment facts are declared twice: `wrangler.jsonc` feeds `wrangler types` and legacy
// maintenance commands, while `cloudflare.config.ts` is what `cf` actually deploys. Editing
// one and forgetting the other makes generated runtime types disagree with the deployed
// Worker without any build error, so the two declarations are compared here.
//
// `wrangler.config.ts` is deliberately orthogonal: it only carries CLI execution overrides
// (minify, metrics, typegen) and must not start restating Worker facts.
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (file) => readFileSync(join(root, file), "utf8");

const wrangler = JSON.parse(stripJsonComments(read("wrangler.jsonc")));
const cloudflare = read("cloudflare.config.ts");
const cliOverrides = read("wrangler.config.ts");

assert.equal(wrangler.main, "src/worker/index.ts", "wrangler.jsonc entrypoint moved; update this parity check");

const cloudflareEntrypoint = matchOne(cloudflare, /entrypoint:\s*"([^"]+)"/, "entrypoint");
assert.equal(cloudflareEntrypoint, wrangler.main, "Worker entrypoint differs between wrangler.jsonc and cloudflare.config.ts");

const cloudflareName = matchOne(cloudflare, /process\.env\.MBM_WORKER_NAME\s*\|\|\s*"([^"]+)"/, "worker name default");
assert.equal(cloudflareName, wrangler.name, "Worker name differs between wrangler.jsonc and cloudflare.config.ts");

const cloudflareDate = matchOne(cloudflare, /compatibilityDate:\s*"([^"]+)"/, "compatibilityDate");
assert.equal(cloudflareDate, wrangler.compatibility_date, "compatibility_date differs between wrangler.jsonc and cloudflare.config.ts");

const cloudflareFlags = matchOne(cloudflare, /compatibilityFlags:\s*\[([^\]]*)\]/, "compatibilityFlags")
  .split(",").map((flag) => flag.trim().replace(/^"|"$/g, "")).filter(Boolean).sort();
assert.deepEqual(cloudflareFlags, [...wrangler.compatibility_flags].sort(),
  "compatibility flags differ between wrangler.jsonc and cloudflare.config.ts");

assert.equal(matchOne(cloudflare, /workersDev:\s*(true|false)\b/, "workersDev") === "true",
  wrangler.workers_dev, "the workers.dev setting differs between deployment configurations");
assert.equal(matchOne(cloudflare, /previewUrls:\s*(true|false)\b/, "previewUrls") === "true",
  wrangler.preview_urls, "the preview URL setting differs between deployment configurations");
assert.equal(wrangler.keep_vars, true,
  "wrangler.jsonc must enable keep_vars to match cloudflare.config.ts keep_bindings");
const cloudflareKeepBindings = matchOne(cloudflare, /keep_bindings:\s*\[([^\]]*)\]/, "keep_bindings")
  .split(",").map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean).sort();
assert.deepEqual(cloudflareKeepBindings, ["json", "plain_text", "secret_key", "secret_text"],
  "cloudflare.config.ts must preserve plain_text, json, secret_text, and secret_key bindings");

const durableBinding = /\b(\w+):\s*bindings\.durableObject\(\{\s*worker:\s*name,\s*exportName:\s*"([^"]+)"\s*\}\)/.exec(cloudflare);
assert.ok(durableBinding, "cf must declare the Durable Object as a self-binding");
const [, bindingName, className] = durableBinding;
assert.deepEqual(wrangler.durable_objects.bindings, [{ name: bindingName, class_name: className }],
  "Durable Object binding name or class differs between deployment configurations");
const sqliteClass = matchOne(cloudflare,
  /\b(\w+):\s*workerExports\.durableObject\(\{\s*storage:\s*"sqlite"\s*\}\)/, "SQLite Durable Object export");
assert.equal(sqliteClass, className, "cf must back the bound Durable Object with SQLite");
const wranglerSqliteClasses = new Set(wrangler.migrations.flatMap((entry) => entry.new_sqlite_classes ?? []));
assert.ok(wranglerSqliteClasses.has(className),
  "Wrangler must migrate the bound Durable Object to SQLite");

const wranglerLimits = new Map(wrangler.ratelimits.map((entry) => [entry.name, {
  namespace: String(entry.namespace_id),
  limit: entry.simple.limit,
  period: entry.simple.period,
}]));
assert.equal(wranglerLimits.size, wrangler.ratelimits.length, "duplicate Wrangler rate limiter binding");
const cloudflareLimits = new Map();
for (const [, name, namespace, limit, period] of cloudflare.matchAll(
  /(\w+):\s*bindings\.rateLimit\(\{\s*namespace:\s*"(\d+)",\s*simple:\s*\{\s*limit:\s*(\d+),\s*period:\s*(\d+)\s*\}\s*\}\)/g,
)) {
  assert.ok(!cloudflareLimits.has(name), `duplicate cf rate limiter binding ${name}`);
  cloudflareLimits.set(name, { namespace, limit: Number(limit), period: Number(period) });
}
assert.ok(cloudflareLimits.size > 0, "no rate limiter bindings found in cloudflare.config.ts; the binding syntax changed");
assert.deepEqual([...cloudflareLimits].sort(), [...wranglerLimits].sort(),
  "rate limiter bindings differ between wrangler.jsonc and cloudflare.config.ts");

const cloudflareSampling = Number(matchOne(cloudflare, /headSamplingRate:\s*([\d.]+)/, "headSamplingRate"));
assert.equal(wrangler.observability.enabled, true, "wrangler.jsonc observability is disabled");
assert.match(cloudflare, /observability:\s*\{\s*enabled:\s*true/, "cloudflare.config.ts observability is disabled");
assert.equal(cloudflareSampling, wrangler.observability.head_sampling_rate,
  "observability sampling rate differs between wrangler.jsonc and cloudflare.config.ts");

const cloudflareBodyBytes = matchOne(cloudflare, /MBM_WORKER_MAX_BODY_BYTES:\s*bindings\.text\("(\d+)"\)/, "MBM_WORKER_MAX_BODY_BYTES");
assert.equal(cloudflareBodyBytes, wrangler.vars.MBM_WORKER_MAX_BODY_BYTES,
  "MBM_WORKER_MAX_BODY_BYTES differs between wrangler.jsonc and cloudflare.config.ts");
const cloudflareAllowedOrigins = matchOne(cloudflare, /MBM_ALLOWED_ORIGINS:\s*bindings\.text\("([^"]*)"\)/, "MBM_ALLOWED_ORIGINS");
assert.equal(cloudflareAllowedOrigins, wrangler.vars.MBM_ALLOWED_ORIGINS,
  "MBM_ALLOWED_ORIGINS differs between deployment configurations");

// `wrangler.config.ts` must stay CLI-only. Pinning its exact key set is stronger than
// checking that a few deployment facts are absent: any new key forces a review.
const cliKeys = [...cliOverrides.matchAll(/^ {2}([A-Za-z_][\w]*):/gm)].map((match) => match[1]).sort();
assert.deepEqual(cliKeys, ["minify", "sendMetrics", "types"],
  "wrangler.config.ts must stay CLI-only (minify/sendMetrics/types); keep deployment facts in wrangler.jsonc and cloudflare.config.ts");

console.log(`deployment config parity ok (${wranglerLimits.size} rate limiters, ${cloudflareFlags.length} compatibility flags)`);

function matchOne(text, pattern, label) {
  const match = pattern.exec(text);
  assert.ok(match, `could not read ${label} from cloudflare.config.ts; the configuration syntax changed`);
  return match[1];
}

// JSONC support limited to the `//` comments this repository actually uses. A `//` inside a
// string literal is preserved, so URLs and file paths stay intact.
function stripJsonComments(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    result += character;
  }
  return result;
}
