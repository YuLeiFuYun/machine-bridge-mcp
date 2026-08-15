export async function runWithStableGeneration({ captureGeneration, run, label = "verification inputs" }) {
  if (typeof captureGeneration !== "function") throw new TypeError("captureGeneration must be a function");
  if (typeof run !== "function") throw new TypeError("run must be a function");
  const before = captureGeneration();
  let result;
  let runError;
  try { result = await run(); }
  catch (error) { runError = error; }
  const after = captureGeneration();
  if (after !== before) {
    throw new Error(`${label} changed during verification; discard this run (${before} -> ${after})`);
  }
  if (runError) throw runError;
  return result;
}
