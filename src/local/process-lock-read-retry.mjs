const PROCESS_LOCK_READ_ATTEMPTS = 4;
const PROCESS_LOCK_IDENTITY_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function retryProcessLockIdentityReadSync(callback) {
  if (typeof callback !== "function") throw new TypeError("process-lock identity retry requires a callback");
  for (let attempt = 1; attempt <= PROCESS_LOCK_READ_ATTEMPTS; attempt += 1) {
    try { return callback(); }
    catch (error) {
      const identityChanged = error?.code === "MBM_IDENTITY_CHANGED" || error?.cause?.code === "MBM_IDENTITY_CHANGED";
      if (!identityChanged || attempt === PROCESS_LOCK_READ_ATTEMPTS) throw error;
      Atomics.wait(PROCESS_LOCK_IDENTITY_RETRY_BUFFER, 0, 0, 1);
    }
  }
  throw new Error("process lock identity did not settle");
}
