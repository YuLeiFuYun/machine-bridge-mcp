export function boundedProcessErrorMessage(error, fallback = "process failed") {
  let message = "";
  try { message = error instanceof Error ? error.message : String(error); }
  catch { return fallback; }
  return message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 4096) || fallback;
}
