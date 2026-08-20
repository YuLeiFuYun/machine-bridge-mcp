import { availableParallelism, cpus, freemem, loadavg, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import { sampleDarwinHostAsync } from "./resource-host-darwin.mjs";
import { sampleLinuxHost } from "./resource-host-linux.mjs";
const CPU_BUSY_SAMPLE_MS = 50;
export async function sampleResourceHostAsync(options = {}) {
  const cwd = options.cwd || process.cwd();
  const platform = String(options.platform || process.platform);
  const cpuCores = cpuCount(options);
  const sample = baseSample(cpuCores, platform, options);
  const [cpu, filesystem, darwin] = await Promise.all([
    sampleCpuBusyCoresAsync(cpuCores, sample, options),
    diskStatsAsync(cwd),
    platform === "darwin" ? sampleDarwinHostAsync(options) : Promise.resolve(null),
  ]);
  sample.cpu_busy_cores = cpu.busy;
  sample.cpu_time_ms_total = cpu.total;
  sample.cpu_idle_ms_total = cpu.idle;
  Object.assign(sample, filesystem);
  if (darwin) Object.assign(sample, darwin);
  else if (platform === "linux") sampleLinuxHost(sample, options);
  sample.sampled_at_ms = Date.now();
  return sample;
}
function baseSample(cpuCores, platform, options) {
  const totalMemoryBytes = totalmem();
  const cpuTotals = cpuTimeTotals(options.cpuTimes);
  return {
    sampled_at_ms: 0, platform, cpu_cores: cpuCores,
    total_memory_mb: Math.round(totalMemoryBytes / (1024 * 1024)),
    cpu_busy_cores: null, load1: Number(loadavg()[0]) || 0,
    memory_free_percent: platform === "win32" && totalMemoryBytes > 0
      ? Math.max(0, Math.min(100, freemem() * 100 / totalMemoryBytes))
      : null,
    cpu_time_ms_total: cpuTotals?.total ?? null, cpu_idle_ms_total: cpuTotals?.idle ?? null,
    pageouts_total: null, swapouts_total: null,
    disk_mb_per_s: null, disk_iops: null, disk_free_bytes: null, disk_total_bytes: null,
    thermal_warning: false, io_sampled: false, io_sampled_at_ms: null,
    psi_cpu_some_avg10: null, psi_memory_some_avg10: null, psi_memory_full_avg10: null,
    psi_io_some_avg10: null, psi_io_full_avg10: null,
  };
}
function cpuCount(options) {
  return Math.max(1, Number(options.cpuCores ?? availableParallelism()) || 1);
}
function cpuTimeTotals(readCpus = cpus) {
  let total = 0;
  let idle = 0;
  for (const cpu of readCpus()) {
    const times = cpu?.times || {};
    const values = [times.user, times.nice, times.sys, times.idle, times.irq].map(Number);
    if (!values.every(Number.isFinite)) return null;
    total += values.reduce((sum, value) => sum + value, 0);
    idle += Number(times.idle);
  }
  return total > 0 && idle >= 0 && idle <= total ? { total, idle } : null;
}
async function sampleCpuBusyCoresAsync(cpuCores, startSample, options) {
  if (options.previous) {
    const immediate = cpuBusyWindow(cpuCores, options.previous, { total: startSample.cpu_time_ms_total, idle: startSample.cpu_idle_ms_total });
    if (immediate.busy !== null) return immediate;
  }
  const sleep = options.cpuSampleSleep || ((ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); }));
  await sleep(CPU_BUSY_SAMPLE_MS);
  const end = cpuTimeTotals(options.cpuTimes);
  return cpuBusyWindow(cpuCores, startSample, end);
}
function cpuBusyWindow(cpuCores, startSample, end) {
  const startTotal = Number(startSample?.cpu_time_ms_total); const startIdle = Number(startSample?.cpu_idle_ms_total);
  if (!end || !Number.isFinite(startTotal) || !Number.isFinite(startIdle)) return { busy: null, total: end?.total ?? null, idle: end?.idle ?? null };
  const totalDelta = Number(end.total) - startTotal; const idleDelta = Number(end.idle) - startIdle;
  const busy = totalDelta > 0 && idleDelta >= 0 && idleDelta <= totalDelta
    ? Math.max(0, Math.min(cpuCores, cpuCores * (1 - idleDelta / totalDelta))) : null;
  return { busy, total: Number(end.total), idle: Number(end.idle) };
}
async function diskStatsAsync(cwd) {
  try {
    const value = await statfs(cwd);
    return { disk_free_bytes: Number(value.bavail) * Number(value.bsize), disk_total_bytes: Number(value.blocks) * Number(value.bsize) };
  } catch { return { disk_free_bytes: null, disk_total_bytes: null }; }
}
