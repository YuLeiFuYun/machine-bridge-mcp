import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism, cpus, freemem, loadavg, totalmem } from "node:os";
import { statfs } from "node:fs/promises";

const HOST_SAMPLE_FRESH_MS = 500;

const HOST_CPU_PREVIOUS_MAX_AGE_MS = 2_000;

const HOST_IO_SAMPLE_FRESH_MS = 5_000;

const HOST_IO_HINT_MAX_AGE_MS = HOST_IO_SAMPLE_FRESH_MS;

export function resourceHostNeedsFreshIo(request) {
  return request?.resource_class === "io" || request?.resource_class === "unbounded";
}

export async function freshResourceHostSnapshot({ cached, current, sampleHost, cwd, request = null, scope = "" }) {
  const scopedCached = cached?.sample_scope === scope ? cached : null;
  const sampleAge = scopedCached ? current - Number(scopedCached.sampled_at_ms) : Number.POSITIVE_INFINITY;
  const globalAge = cached ? current - Number(cached.sampled_at_ms) : Number.POSITIVE_INFINITY;
  const cpuPrevious = cached && globalAge >= 0 && globalAge <= HOST_CPU_PREVIOUS_MAX_AGE_MS ? cached : null;
  const needsIo = resourceHostNeedsFreshIo(request);
  if (scopedCached && sampleAge >= 0 && sampleAge <= HOST_SAMPLE_FRESH_MS && (!needsIo || scopedCached.io_sampled === true)) return scopedCached;
  const ioSampledAt = Number(scopedCached?.io_sampled_at_ms ?? scopedCached?.sampled_at_ms);
  const ioAge = current - ioSampledAt;
  if (!needsIo) {
    const quick = { ...await Promise.resolve(sampleHost({ cwd, quick: true, previous: cpuPrevious })), sample_scope: scope };
    if (scopedCached?.io_sampled !== true || !Number.isFinite(ioAge) || ioAge < 0 || ioAge > HOST_IO_HINT_MAX_AGE_MS) return quick;
    return withCachedIo(quick, scopedCached);
  }
  if (scopedCached?.io_sampled === true && Number.isFinite(ioAge) && ioAge >= 0 && ioAge <= HOST_IO_SAMPLE_FRESH_MS) {
    const quick = { ...await Promise.resolve(sampleHost({ cwd, quick: true, previous: cpuPrevious })), sample_scope: scope };
    return withCachedIo(quick, scopedCached);
  }
  return { ...await Promise.resolve(sampleHost({ cwd, quick: false, previous: cpuPrevious })), sample_scope: scope };
}

function withCachedIo(sample, cached) {
  return {
    ...sample,
    disk_mb_per_s: cached.disk_mb_per_s ?? null,
    disk_iops: cached.disk_iops ?? null,
    io_sampled: true,
    io_sampled_at_ms: Number.isFinite(Number(cached.io_sampled_at_ms)) ? Number(cached.io_sampled_at_ms) : Number(cached.sampled_at_ms),
  };
}
export function runResourceProbeAsync(command, args, options = {}) {
  const execute = typeof options.execFile === "function" ? options.execFile : execFile;
  return new Promise((resolvePromise) => {
    try {
      execute(command, args, {
      encoding: "utf8",
      timeout: positive(options.timeoutMs, 2_500),
      killSignal: "SIGKILL",
      maxBuffer: positive(options.maxOutputBytes, 256 * 1024),
      windowsHide: true,
      env: probeEnvironment(),
      }, (error, stdout) => resolvePromise({ ok: !error, stdout: String(stdout || "") }));
    } catch {
      resolvePromise({ ok: false, stdout: "" });
    }
  });
}

function probeEnvironment() {
  return process.platform === "win32" ? process.env : { ...process.env, LC_ALL: "C", LANG: "C" };
}

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
export async function sampleDarwinHostAsync(options = {}) {
  const run = options.runCommandAsync || ((command, args, timeoutMs) => runResourceProbeAsync(command, args, { timeoutMs }));
  const [pressure, vm, io, thermal] = await Promise.all([
    run("/usr/bin/memory_pressure", ["-Q"]),
    run("/usr/bin/vm_stat", []),
    options.quick === true ? Promise.resolve(null) : run("/usr/sbin/iostat", ["-Id", "disk0", "1", "2"], 2_200),
    run("/usr/bin/pmset", ["-g", "therm"]),
  ]);
  const sample = {};
  applyDarwinResults(sample, { pressure, vm, io, thermal }, options.quick !== true);
  return sample;
}

function applyDarwinResults(sample, results, sampledIo) {
  const { pressure, vm, io, thermal } = results;
  if (pressure?.ok) {
    const match = /System-wide memory free percentage:\s*(\d+)%/i.exec(pressure.stdout);
    if (match) sample.memory_free_percent = Number(match[1]);
  }
  if (vm?.ok) {
    sample.pageouts_total = vmCounter(vm.stdout, "Pageouts");
    sample.swapouts_total = vmCounter(vm.stdout, "Swapouts");
  }
  if (sampledIo) {
    if (io?.ok) {
      const rows = String(io.stdout || "").split("\n").map((line) => line.trim()).filter((line) => /^\d/.test(line));
      const fields = rows.at(-1)?.split(/\s+/).map(Number) || [];
      if (fields.length >= 3 && fields.every(Number.isFinite)) {
        sample.disk_iops = fields[1];
        sample.disk_mb_per_s = fields[2];
        sample.io_sampled = true;
        sample.io_sampled_at_ms = Date.now();
      }
    }
  }
  if (thermal?.ok) sample.thermal_warning = !(/No thermal warning level has been recorded/i.test(thermal.stdout) && /No performance warning level has been recorded/i.test(thermal.stdout));
}

function vmCounter(text, label) {
  const match = new RegExp(`^${label}:\\s*(\\d+)\\.?$`, "mi").exec(String(text || ""));
  return match ? Number(match[1]) : null;
}
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
const COMMAND_OPTIONS = { timeoutMs: 3_000, maxOutputBytes: 1024 * 1024 };

export async function sampleResourceProcessParentsAsync(options = {}) {
  const run = options.run || ((command, args) => runResourceProbeAsync(command, args, COMMAND_OPTIONS));
  const result = await processParentCommand(run);
  return result?.ok ? parseResourceProcessParents(result.stdout) : null;
}

export function parseResourceProcessParents(value) {
  const parents = {};
  for (const line of String(value || "").split(/\r?\n/)) {
    const match = /^\s*([1-9][0-9]*)\s+([0-9]+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]); const parent = Number(match[2]);
    if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(parent) && parent >= 0) parents[String(pid)] = parent;
  }
  return Object.keys(parents).length ? parents : null;
}

function processParentCommand(run) {
  return process.platform === "win32"
    ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"])
    : run("ps", ["-axo", "pid=,ppid="]);
}
const DEFAULT_CACHE_MS = 1_000;

export function cachedResourceProcessParentSamplerAsync(sample, now = Date.now, cacheMs = DEFAULT_CACHE_MS) {
  return cachedResourceProcessSnapshotSamplerAsync(sample, now, cacheMs);
}

export function cachedResourceProcessSnapshotSamplerAsync(sample, now = Date.now, cacheMs = DEFAULT_CACHE_MS) {
  const ttl = Math.max(0, Number(cacheMs) || 0);
  let sampledAt = null;
  let cached = null;
  let inFlight = null;
  return async () => {
    const current = Number(now());
    if (cacheFresh(sampledAt, current, ttl)) return cached;
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(() => sample()).then((value) => {
      cached = normalizeSnapshot(value);
      sampledAt = finishedAt(now, current);
      return cached;
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
}

function normalizeSnapshot(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function cacheFresh(sampledAt, current, ttl) {
  return sampledAt !== null && Number.isFinite(current) && current >= sampledAt && current - sampledAt <= ttl;
}

function finishedAt(now, fallback) {
  const finished = Number(now());
  return Number.isFinite(finished) ? finished : Number.isFinite(fallback) ? fallback : null;
}
