// @ts-check

import process from "node:process";

/**
 * Install fail-fast handlers for failures outside an awaited request boundary.
 * The handler deliberately does not attempt asynchronous cleanup: once the event
 * loop's state is unknown, continuing would violate the daemon's fail-closed model.
 * @param {{ logger: { error: (message: string, fields?: Record<string, unknown>) => void }, terminate?: (code: number) => void }} options
 * @param {import('node:events').EventEmitter} [target]
 */
export function installFatalProcessHandlers(options, target = process) {
  let terminating = false;
  /** @type {(code: number) => void} */
  const defaultTerminate = (code) => process.exit(code);
  const terminate = typeof options.terminate === "function" ? options.terminate : defaultTerminate;
  /** @param {string} event */
  const handle = (event) => {
    if (terminating) return;
    terminating = true;
    try {
      options.logger.error("fatal process failure; terminating", {
        fatal_event: event,
        // Rejection values and even their code/prototype properties may execute user code.
        error_class: "execution_failed",
      });
    } catch {
      // The process is already in a fatal path; never let logging prevent termination.
    }
    terminate(1);
  };
  const onUncaughtException = () => handle("uncaught_exception");
  const onUnhandledRejection = () => handle("unhandled_rejection");
  target.on("uncaughtException", onUncaughtException);
  target.on("unhandledRejection", onUnhandledRejection);
  return () => {
    target.removeListener("uncaughtException", onUncaughtException);
    target.removeListener("unhandledRejection", onUnhandledRejection);
  };
}
