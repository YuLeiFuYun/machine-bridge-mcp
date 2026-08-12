export function mergeFunctionExecutions(executions = []) {
  const normalized = executions.map(normalizeExecution).filter((ranges) => ranges.length);
  const functionCovered = normalized.some((ranges) => ranges[0].count > 0);
  const candidates = new Map();
  for (const ranges of normalized) {
    for (const range of ranges.slice(1)) candidates.set(rangeKey(range), range);
  }
  return {
    functionCovered,
    blocks: new Map([...candidates].map(([key, range]) => [
      key,
      rangeCoveredAcrossExecutions(normalized, range.startOffset, range.endOffset),
    ])),
  };
}

export function rangeCoveredAcrossExecutions(executions, startOffset, endOffset) {
  if (!(Number.isInteger(startOffset) && Number.isInteger(endOffset) && startOffset < endOffset)) return false;
  return (executions || []).some((ranges) => effectiveRangeCount(ranges, startOffset, endOffset) > 0);
}

function effectiveRangeCount(ranges, startOffset, endOffset) {
  let selected = null;
  for (const range of ranges || []) {
    if (range.startOffset > startOffset || range.endOffset < endOffset) continue;
    if (!selected || range.endOffset - range.startOffset <= selected.endOffset - selected.startOffset) selected = range;
  }
  return selected ? selected.count : 0;
}

function normalizeExecution(ranges) {
  return (ranges || []).map((range) => ({
    startOffset: Number(range.startOffset),
    endOffset: Number(range.endOffset),
    count: Math.max(0, Number(range.count) || 0),
  })).filter((range) => Number.isInteger(range.startOffset) && Number.isInteger(range.endOffset) && range.startOffset < range.endOffset);
}

function rangeKey(range) {
  return `${range.startOffset}:${range.endOffset}`;
}
