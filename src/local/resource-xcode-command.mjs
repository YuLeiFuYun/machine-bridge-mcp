const XCODE_LIGHT_FLAGS = new Set([
  "-usage", "-help", "-license", "-checkFirstLaunchStatus", "-showsdks", "-version", "-list",
]);

export function xcodeIsLightCommand(args) {
  return args.some((value) => XCODE_LIGHT_FLAGS.has(String(value)));
}
