import { bindings, defineConfig, exports as workerExports } from "cf/config";

const name = process.env.MBM_WORKER_NAME || "machine-bridge-mcp";
export default defineConfig({
  worker: {
    name,
    entrypoint: "src/worker/index.ts",
    compatibilityDate: "2026-07-11",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
    workersDev: true,
    previewUrls: false,
    unsafe: { metadata: { keep_bindings: ["plain_text", "json", "secret_text", "secret_key"] } },
    observability: { enabled: true, headSamplingRate: 0.1 },
    exports: { BridgeRoom: workerExports.durableObject({ storage: "sqlite" }) },
    env: {
      MBM_WORKER_MAX_BODY_BYTES: bindings.text("8388608"),
      MBM_ALLOWED_ORIGINS: bindings.text(""),
      BRIDGE: bindings.durableObject({ worker: name, exportName: "BridgeRoom" }),
      STATEFUL_GLOBAL_RATE_LIMITER: bindings.rateLimit({ namespace: "4301702", simple: { limit: 1200, period: 60 } }),
      STATEFUL_RATE_LIMITER: bindings.rateLimit({ namespace: "4301701", simple: { limit: 120, period: 60 } }),
    },
  },
});
