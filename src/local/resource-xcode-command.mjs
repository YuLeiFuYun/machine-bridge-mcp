// @ts-check
const XCODE_LIGHT_FLAGS = new Set([
  "-usage", "-help", "-license", "-checkFirstLaunchStatus", "-showsdks", "-version", "-list",
]);

/**
 * @param {readonly unknown[]} args
 * @returns {boolean}
 */
export function xcodeIsLightCommand(args) {
  return args.some((value) => XCODE_LIGHT_FLAGS.has(String(value)));
}
