import { readFileSync } from "node:fs";

export function sampleLinuxHost(sample, options = {}) {
  const read = options.readFile || readText;
  const meminfo = read("/proc/meminfo");
  const totalKb = meminfoKb(meminfo, "MemTotal");
  const availableKb = meminfoKb(meminfo, "MemAvailable");
  if (totalKb !== null && totalKb > 0) {
    sample.total_memory_mb = Math.max(1024, Math.round(totalKb / 1024));
    if (availableKb !== null) sample.memory_free_percent = Math.max(0, Math.min(100, availableKb * 100 / totalKb));
  }
  const cpu = read("/proc/pressure/cpu");
  const memory = read("/proc/pressure/memory");
  const io = read("/proc/pressure/io");
  sample.psi_cpu_some_avg10 = psiAvg10(cpu, "some");
  sample.psi_memory_some_avg10 = psiAvg10(memory, "some");
  sample.psi_memory_full_avg10 = psiAvg10(memory, "full");
  sample.psi_io_some_avg10 = psiAvg10(io, "some");
  sample.psi_io_full_avg10 = psiAvg10(io, "full");
  sample.io_sampled = sample.psi_io_some_avg10 !== null || sample.psi_io_full_avg10 !== null;
}

function meminfoKb(text, key) {
  const match = new RegExp(`^${key}:\\s*(\\d+)\\s+kB$`, "mi").exec(String(text || ""));
  return match ? Number(match[1]) : null;
}

function psiAvg10(text, kind) {
  const match = new RegExp(`^${kind}\\s+[^\\n]*?avg10=(\\d+(?:\\.\\d+)?)`, "mi").exec(String(text || ""));
  return match ? Number(match[1]) : null;
}

function readText(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}
