const GIB = 1024 ** 3;

export function resourceDiskHardFloorBytes(totalBytes) {
  const total = Number(totalBytes);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(50 * GIB, Math.max(5 * GIB, total * 0.10));
}

export function resourceDiskSoftFloorBytes(totalBytes) {
  const total = Number(totalBytes);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(80 * GIB, Math.max(8 * GIB, total * 0.15));
}
