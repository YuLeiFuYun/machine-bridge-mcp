// @ts-check

/**
 * Project raw application backend capabilities through the effective tool set.
 * Discovery is independent from launch/UI authority, so callers can expose the
 * inventory without accidentally advertising unavailable mutations.
 * @param {Record<string, any>} capabilities
 * @param {(tool: string) => boolean} allows
 */
export function projectApplicationCapabilities(capabilities, allows) {
  const result = { ...capabilities };
  result.discovery = allows("list_local_applications");
  result.open = capabilities.open === true && allows("open_local_application");
  result.accessibility_inspection = capabilities.accessibility_inspection === true && allows("inspect_local_application");
  result.structured_accessibility_actions = capabilities.structured_accessibility_actions === true && allows("operate_local_application");
  result.window_screenshot = capabilities.window_screenshot === true && allows("computer_observe");
  if (capabilities.background_visual_point && typeof capabilities.background_visual_point === "object") {
    result.background_visual_point = {
      ...capabilities.background_visual_point,
      available: capabilities.background_visual_point.available === true && allows("computer_act"),
    };
  }
  return result;
}
