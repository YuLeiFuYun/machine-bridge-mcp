import { Buffer } from "node:buffer";
import { BridgeError } from "./errors.mjs";
import relayContract from "../shared/relay-contract.json" with { type: "json" };

const MAX_HOSTED_RESULT_BYTES = Number(relayContract.maximumHostedReadFileResultBytes);

export function hostedFileReadLimits(context) {
  if (context?.authority?.origin !== "relay") return null;
  return { defaultContentBytes: MAX_HOSTED_RESULT_BYTES, maximumContentBytes: MAX_HOSTED_RESULT_BYTES };
}

export function hostedFileReadResult({
  context, base, content, lineStarts, startLine, selectedEnd, totalLines, maxContentBytes, automatic,
}) {
  if (context?.authority?.origin !== "relay") return null;
  const candidate = (endLine, continuation) => {
    const startOffset = lineStarts[startLine - 1];
    const endOffset = endLine < totalLines ? lineStarts[endLine] : content.length;
    const selected = content.slice(startOffset, endOffset);
    const value = {
      ...base, content: selected, start_line: startLine, end_line: endLine, total_lines: totalLines,
      complete: startLine === 1 && endLine === totalLines,
      ...(continuation ? { next_start_line: endLine + 1 } : {}),
    };
    return { value, contentBytes: Buffer.byteLength(selected), resultBytes: Buffer.byteLength(JSON.stringify(value)) };
  };
  const fits = (entry) => entry.contentBytes <= maxContentBytes && entry.resultBytes <= MAX_HOSTED_RESULT_BYTES;
  const final = candidate(selectedEnd, false);
  if (fits(final)) return final.value;
  if (!automatic) throw hostedReadLimitError(final, maxContentBytes);
  const first = candidate(startLine, startLine < selectedEnd);
  if (!fits(first)) throw hostedReadLimitError(first, maxContentBytes);
  let low = startLine;
  let high = selectedEnd - 1;
  let best = first;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const current = candidate(middle, true);
    if (fits(current)) { best = current; low = middle + 1; }
    else high = middle - 1;
  }
  return best.value;
}

function hostedReadLimitError(entry, maximumContentBytes) {
  return new BridgeError("limit_exceeded", `hosted read_file result exceeds the ${MAX_HOSTED_RESULT_BYTES}-byte serialized result budget`, {
    retryable: false,
    details: {
      reason: "hosted_read_result_limit", maximum_result_bytes: MAX_HOSTED_RESULT_BYTES, actual_result_bytes: entry.resultBytes,
      maximum_content_bytes: maximumContentBytes, selected_content_bytes: entry.contentBytes,
    },
  });
}
