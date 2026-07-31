import { parentPort, workerData } from "node:worker_threads";
import {
  auditErrorClass,
  auditSnapshotFromState,
  readVerifiedAuditState,
  recordAuditBatch,
  unhealthyAuditSnapshot,
} from "./security-audit-storage.mjs";

const root = String(workerData?.root || "");
const MAX_BATCH = 128;
const BATCH_DELAY_MS = 5;
const pending = [];
let timer = null;
let draining = false;
let closeRequested = false;

try {
  parentPort.postMessage({ type: "ready", snapshot: auditSnapshotFromState(readVerifiedAuditState(root)) });
} catch (error) {
  parentPort.postMessage({ type: "ready", snapshot: unhealthyAuditSnapshot(error) });
}

parentPort.on("message", (message) => {
  if (message?.type === "record") {
    pending.push(message);
    scheduleDrain();
    return;
  }
  if (message?.type === "flush") {
    pending.push({ type: "barrier", id: message.id });
    scheduleDrain(true);
    return;
  }
  if (message?.type === "close") {
    closeRequested = true;
    pending.push({ type: "barrier", id: message.id, close: true });
    scheduleDrain(true);
  }
});

function scheduleDrain(immediate = false) {
  if (draining || timer) return;
  timer = setTimeout(() => {
    timer = null;
    void drain();
  }, immediate ? 0 : BATCH_DELAY_MS);
  timer.unref?.();
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0) {
      const records = [];
      const barriers = [];
      while (pending.length > 0 && records.length < MAX_BATCH) {
        const item = pending.shift();
        if (item.type === "record") records.push(item);
        else barriers.push(item);
        if (barriers.length > 0 && records.length === 0) break;
      }
      if (records.length > 0) {
        try {
          const snapshot = await recordAuditBatch(root, records.map(({ input, nowMs }) => ({ input, nowMs })));
          parentPort.postMessage({
            type: "record_batch_result", ids: records.map((item) => item.id), recorded: true, snapshot,
          });
        } catch (error) {
          const errorClass = auditErrorClass(error);
          const snapshot = unhealthyAuditSnapshot(error);
          parentPort.postMessage({
            type: "record_batch_result", ids: records.map((item) => item.id), recorded: false,
            error_class: errorClass, snapshot,
          });
        }
      }
      for (const barrier of barriers) {
        parentPort.postMessage({ type: barrier.close ? "closed" : "flushed", id: barrier.id });
      }
    }
  } finally {
    draining = false;
    if (pending.length > 0) scheduleDrain(true);
    else if (closeRequested) parentPort.close();
  }
}
