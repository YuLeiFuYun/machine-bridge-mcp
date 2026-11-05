// @ts-check
import * as vm from "node:vm";
import { BridgeError } from "./errors.mjs";

/**
 * Executes a controlled CodeAct batch script against the Machine Bridge runtime.
 * Each sdk.<tool_name>(args) call delegates directly to runtime.executeTool(),
 * preserving all existing policy gates, audit trails, and execution limits.
 *
 * Reference: Executable Code Actions Elicit Better LLM Agents (CodeAct, ICML 2024).
 */
export class CodeActExecutor {
  /**
   * @param {object} [options]
   * @param {any} [options.runtime]
   * @param {((tool: string, args?: Record<string, unknown>, context?: Record<string, unknown>) => Promise<unknown>)} [options.executeTool]
   * @param {number} [options.timeoutMs]
   */
  constructor(options = {}) {
    this.runtime = options.runtime || null;
    this.executeTool = options.executeTool || null;
    this.timeoutMs = options.timeoutMs || 30_000;
  }

  /**
   * @param {string} script
   * @param {Record<string, unknown>} [context]
   * @returns {Promise<{ ok: boolean, result: unknown, value: unknown, logs: string[] }>}
   */
  async execute(script, context = {}) {
    if (typeof script !== "string" || !script.trim()) {
      throw new BridgeError("invalid_request", "script must be a non-empty string");
    }

    /** @type {string[]} */
    const logs = [];
    const sdk = this._createSdkProxy(context);

    const sandbox = {
      sdk,
      mbm: sdk,
      console: {
        log: (/** @type {unknown[]} */ ...args) => logs.push(args.map(String).join(" ")),
        error: (/** @type {unknown[]} */ ...args) => logs.push("[error] " + args.map(String).join(" ")),
        warn: (/** @type {unknown[]} */ ...args) => logs.push("[warn] " + args.map(String).join(" ")),
      },
      Buffer,
      setTimeout,
      clearTimeout,
    };

    const vmContext = vm.createContext(sandbox);

    // Wrap the script in an async IIFE so agents can use await sdk.<tool>(...)
    const wrappedScript = `(async () => {\n${script}\n})()`;

    try {
      const compiled = new vm.Script(wrappedScript, {
        filename: "codeact-batch.js",
      });

      const promise = compiled.runInContext(vmContext, {
        timeout: this.timeoutMs,
        breakOnSigint: true,
      });

      const result = await promise;
      const finalResult = result === undefined ? null : result;
      return { ok: true, result: finalResult, value: finalResult, logs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BridgeError("operational_error", `CodeAct batch execution failed: ${message}`, {
        details: { error: message, logs },
      });
    }
  }

  /**
   * Creates a proxy that intercepts sdk.<tool_name>(args) calls
   * and routes them to runtime.executeTool(toolName, args, context).
   * @param {Record<string, unknown>} context
   * @private
   */
  _createSdkProxy(context) {
    const caller = this.runtime?.executeTool
      ? (/** @type {string} */ tool, /** @type {Record<string, unknown>} */ args, /** @type {Record<string, unknown>} */ ctx) => this.runtime.executeTool(tool, args, ctx)
      : typeof this.executeTool === "function"
        ? this.executeTool
        : null;

    return new Proxy({}, {
      get: (_target, prop) => {
        if (typeof prop !== "string") return undefined;
        if (prop === "callTool") {
          return async (/** @type {string} */ tool, /** @type {Record<string, unknown>} */ args = {}) => {
            if (!caller) throw new Error("No tool execution handler available in CodeAct executor");
            return caller(tool, args, context);
          };
        }
        return async (/** @type {Record<string, unknown>} */ args = {}) => {
          if (!caller) throw new Error("No tool execution handler available in CodeAct executor");
          return caller(prop, args, context);
        };
      },
    });
  }
}
