export async function healthyResourceHost() {
  return {
    sampled_at_ms: Date.now(), cpu_cores: 8, total_memory_mb: 16 * 1024,
    cpu_busy_cores: 1, load1: 1, memory_free_percent: 50,
    pageouts_total: 0, swapouts_total: 0, pageouts_per_s: 0, swapouts_per_s: 0,
    disk_mb_per_s: 1, disk_iops: 10, disk_free_bytes: 125 * 1024 ** 3,
    disk_total_bytes: 460 * 1024 ** 3, thermal_warning: false,
  };
}
