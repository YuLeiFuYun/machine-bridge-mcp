import { existsSync } from "node:fs";

const POSIX_NICE = "/usr/bin/nice";
const BACKGROUND_NICE_INCREMENT = 5;
const UNBOUNDED_NICE_INCREMENT = 2;

export function applyResourceProcessPriority(command, args, request, options = {}) {
  const values = args.map(String);
  if (process.platform === "win32" || request?.heavy !== true) return { command, args: values };
  const increment = request?.priority === "background" ? BACKGROUND_NICE_INCREMENT : request?.unbounded === true ? UNBOUNDED_NICE_INCREMENT : 0;
  if (!increment) return { command, args: values };
  const nice = String(options.niceExecutable || POSIX_NICE);
  if (!existsSync(nice)) return { command, args: values };
  return { command: nice, args: ["-n", String(increment), String(command), ...values] };
}
