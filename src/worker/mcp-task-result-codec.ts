export function resultChunkKey(taskId: string, index: number): string {
  return "mcp-task-result-v1:" + taskId + ":" + index;
}

export async function encodeTaskResult(value: unknown): Promise<{ bytes: Uint8Array; sha256: string } | null> {
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch { return null; }
  if (typeof serialized !== "string") return null;
  const bytes = new TextEncoder().encode(serialized);
  return { bytes, sha256: await sha256(bytes) };
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch { return null; }
}

export function concatenate(chunks: Uint8Array[], expectedBytes: number): Uint8Array {
  const bytes = new Uint8Array(expectedBytes);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (offset !== expectedBytes) throw new Error("MCP task result byte length is invalid");
  return bytes;
}
