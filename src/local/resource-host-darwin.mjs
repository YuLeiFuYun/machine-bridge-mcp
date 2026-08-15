import { runResourceProbeAsync, runResourceProbeSync } from "./resource-probe-command.mjs";

export function sampleDarwinHost(sample, options = {}) {
  const run = options.runCommand || ((command, args, timeoutMs) => runResourceProbeSync(command, args, { timeoutMs }));
  applyDarwinResults(sample, {
    pressure: run("/usr/bin/memory_pressure", ["-Q"]),
    vm: run("/usr/bin/vm_stat", []),
    io: options.quick === true ? null : run("/usr/sbin/iostat", ["-Id", "disk0", "1", "2"], 2_200),
    thermal: run("/usr/bin/pmset", ["-g", "therm"]),
  }, options.quick !== true);
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
