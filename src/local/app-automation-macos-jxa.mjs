// @ts-check

export const MACOS_UI_JXA = String.raw`
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'uint64', 'pointer', 'int']]);
const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_SIZE = 136;
const PROC_BSDINFO_START_BYTES = 16;
function readPayload() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  return JSON.parse(text);
}
function safe(fn, fallback) { try { const value = fn(); return value === undefined || value === null ? fallback : value; } catch (_) { return fallback; } }
function processStartSignature(processId) {
  // proc_bsdinfo is a stable macOS ABI: 136 bytes with pbi_start_tvsec/usec
  // occupying the final 16 bytes. Preserve those native bytes as base64 so
  // JXA and the native input helper derive one exact PID-generation token.
  const data = $.NSMutableData.dataWithLength(PROC_BSDINFO_SIZE);
  const copied = $.proc_pidinfo(processId, PROC_PIDTBSDINFO, 0, data.mutableBytes, PROC_BSDINFO_SIZE);
  if (typeof copied !== 'number' || copied !== PROC_BSDINFO_SIZE) throw new Error('application process generation is unavailable');
  const start = data.subdataWithRange($.NSMakeRange(PROC_BSDINFO_SIZE - PROC_BSDINFO_START_BYTES, PROC_BSDINFO_START_BYTES));
  const signature = ObjC.unwrap(start.base64EncodedStringWithOptions(0));
  if (typeof signature !== 'string' || !signature) throw new Error('application process generation is unavailable');
  return signature;
}
function expectedProcessGenerationForPayload(payload) {
  const value = payload.expectedProcessGeneration;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\r\n\0]/.test(value)) throw new Error('expected process generation is invalid');
  return value;
}
function processInstanceForPayload(payload, processId) {
  const expected = expectedProcessGenerationForPayload(payload);
  if (payload.includeProcessGeneration !== true && expected === null) return null;
  const running = safe(() => $.NSRunningApplication.runningApplicationWithProcessIdentifier(processId), null);
  if (!running || Boolean(safe(() => running.terminated, true))) throw new Error('application process generation is unavailable');
  return running;
}
function processGenerationToken(processId, running) {
  if (!running) throw new Error('application process generation is unavailable');
  return 'proc:' + processStartSignature(processId);
}
function processGenerationForPayload(payload, processId, running) {
  const expected = expectedProcessGenerationForPayload(payload);
  if (!running) return null;
  const actual = processGenerationToken(processId, running);
  if (expected !== null && actual !== expected) throw new Error('application process generation changed before operation');
  return actual;
}
function assertProcessInstance(running, processId, expectedGeneration) {
  if (!running) return;
  const current = safe(() => $.NSRunningApplication.runningApplicationWithProcessIdentifier(processId), null);
  if (!current || Boolean(safe(() => current.terminated, true)) || !Boolean(running.isEqual(current))
      || (expectedGeneration !== null && expectedGeneration !== undefined
        && processGenerationToken(processId, current) !== expectedGeneration)) {
    throw new Error('application process generation changed before operation');
  }
}
function scalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value).slice(0, 1000);
}
function booleanState(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 0 ? false : value === 1 ? true : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return null;
}
function screenBox(element) {
  const position = safe(() => element.position(), null);
  const size = safe(() => element.size(), null);
  if (!Array.isArray(position) || position.length < 2 || !Array.isArray(size) || size.length < 2) return null;
  const values = [position[0], position[1], size[0], size[1]];
  if (!values.every((item) => typeof item === 'number' && Number.isFinite(item))) return null;
  const box = { x: values[0], y: values[1], width: values[2], height: values[3] };
  if (box.width < 0 || box.height < 0) return null;
  return box;
}
function describe(element, index, includeValues, includeGeometry) {
  const item = {
    index,
    role: safe(() => element.role(), ''),
    subrole: safe(() => element.subrole(), ''),
    name: safe(() => element.name(), ''),
    title: safe(() => element.title(), ''),
    description: safe(() => element.description(), ''),
    identifier: safe(() => element.attributes.byName('AXIdentifier').value(), ''),
    enabled: safe(() => element.enabled(), null),
    focused: safe(() => element.focused(), null),
    selected: booleanState(safe(() => element.selected(), null)),
    expanded: booleanState(safe(() => element.expanded(), null))
  };
  if (item.role === 'AXCheckBox' || item.role === 'AXRadioButton') {
    item.checked = booleanState(safe(() => element.value(), null));
  } else {
    item.checked = null;
  }
  if (includeGeometry) item.screen_box = screenBox(element);
  const identity = [item.role, item.subrole, item.name, item.title, item.description, item.identifier].join(' ').toLowerCase();
  item.sensitive = item.role === 'AXSecureTextField' || /(?:password|passwd|secret|token|api[-_ ]?key|otp|one[-_ ]?time|verification|cvc|cvv|security[-_ ]?code|card[-_ ]?number)/.test(identity);
  if (includeValues && !item.sensitive) item.value = scalar(safe(() => element.value(), null));
  return item;
}
function dictValue(dict, key, fallback) { return safe(() => ObjC.unwrap(dict.objectForKey(key)), fallback); }
function systemEventsRead(operation) {
  try { return operation(); }
  catch (error) {
    if (Number(error && error.errorNumber) === -1743) {
      throw new Error('macOS Automation permission to control System Events is required');
    }
    throw error;
  }
}
function applicationProcessExists(process) {
  return Boolean(systemEventsRead(() => process.exists()));
}
function applicationProcessId(process) {
  const processId = systemEventsRead(() => process.unixId());
  if (typeof processId !== 'number' || !Number.isSafeInteger(processId) || processId < 1) throw new Error('application process pid is unavailable');
  return processId;
}
function frontWindowForProcess(process) {
  const windows = safe(() => process.windows(), []);
  const count = Math.min(32, Number(windows.length) || 0);
  for (let index = 0; index < count; index += 1) {
    const window = windows[index];
    const bounds = screenBox(window);
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      return { bounds, title: String(safe(() => window.title(), '') || '') };
    }
  }
  return null;
}
function cgWindowCandidate(info, pid) {
  const ownerPid = Number(dictValue(info, 'kCGWindowOwnerPID', 0));
  const layer = Number(dictValue(info, 'kCGWindowLayer', -1));
  const alpha = Number(dictValue(info, 'kCGWindowAlpha', 1));
  if (ownerPid !== pid || layer !== 0 || !(alpha > 0)) return null;
  const boundsDict = safe(() => info.objectForKey('kCGWindowBounds'), null);
  if (!boundsDict) return null;
  const bounds = {
    x: Number(dictValue(boundsDict, 'X', 0)),
    y: Number(dictValue(boundsDict, 'Y', 0)),
    width: Number(dictValue(boundsDict, 'Width', 0)),
    height: Number(dictValue(boundsDict, 'Height', 0))
  };
  const windowId = Number(dictValue(info, 'kCGWindowNumber', 0));
  if (!Number.isInteger(windowId) || windowId < 1 || !(bounds.width > 0) || !(bounds.height > 0)) return null;
  return { window_id: windowId, bounds, title: String(dictValue(info, 'kCGWindowName', '') || '') };
}
function cgWindowsForProcess(pid) {
  const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID);
  const count = Math.min(4096, Number($.CFArrayGetCount(raw)) || 0);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const info = ObjC.castRefToObject($.CFArrayGetValueAtIndex(raw, index));
    const candidate = cgWindowCandidate(info, pid);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}
function nearNumber(a, b, tolerance) {
  return typeof a === 'number' && Number.isFinite(a)
    && typeof b === 'number' && Number.isFinite(b)
    && Math.abs(a - b) <= tolerance;
}
function sameWindowBounds(left, right) {
  return left && right && nearNumber(left.x, right.x, 1) && nearNumber(left.y, right.y, 1) && nearNumber(left.width, right.width, 1) && nearNumber(left.height, right.height, 1);
}
function childrenOf(element) { return safe(() => element.uiElements(), []); }
function flatten(root, maxDepth, maxElements, includeValues, includeMenus, includeGeometry) {
  const output = [];
  const elements = [];
  const stack = [{ element: root, depth: 0, windowBox: null }];
  while (stack.length && output.length < maxElements) {
    const current = stack.pop();
    const children = childrenOf(current.element);
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      const item = describe(child, output.length, includeValues, includeGeometry);
      const ownerWindowBox = item.role === 'AXWindow' ? screenBox(child) : current.windowBox;
      if (includeGeometry) item.window_screen_box = ownerWindowBox;
      elements.push(child);
      output.push(item);
      if (output.length >= maxElements) break;
      const isMenuTree = typeof item.role === 'string' && item.role.startsWith('AXMenu');
      if (current.depth + 1 < maxDepth && (includeMenus || !isMenuTree)) {
        stack.push({ element: child, depth: current.depth + 1, windowBox: ownerWindowBox });
      }
    }
  }
  return { output, elements, truncated: stack.length > 0 || output.length >= maxElements };
}
function matches(item, selector) {
  for (const key of ['role','subrole','name','title','description','identifier']) {
    if (selector[key] === undefined) continue;
    if (typeof selector[key] !== 'string' || typeof item[key] !== 'string' || item[key].toLowerCase() !== selector[key].toLowerCase()) return false;
  }
  return true;
}
let mutationStarted = false;
function main() {
  const payload = readPayload();
  const se = Application('System Events');
  const process = se.applicationProcesses.byName(payload.application);
  if (!applicationProcessExists(process)) throw new Error('application process not found or Accessibility access denied');
  const processId = applicationProcessId(process);
  const expectedProcessId = payload.expectedProcessId;
  if (expectedProcessId !== null && expectedProcessId !== undefined) {
    if (typeof expectedProcessId !== 'number' || !Number.isInteger(expectedProcessId) || expectedProcessId < 1) throw new Error('expected process id is invalid');
    if (processId !== expectedProcessId) throw new Error('application process changed before operation');
  }
  const processInstance = processInstanceForPayload(payload, processId);
  const processGeneration = processGenerationForPayload(payload, processId, processInstance);
  if (payload.operation === 'window_candidates') {
    const front = frontWindowForProcess(process);
    const result = { process_id: processId, front_bounds: front ? front.bounds : null, front_title: front ? front.title : '', candidates: cgWindowsForProcess(processId).slice(0, 32) };
    assertProcessInstance(processInstance, processId, processGeneration);
    if (processGeneration) result.process_generation = processGeneration;
    return result;
  }
  if (payload.operation === 'inspect') {
    const flattened = flatten(process, payload.maxDepth, payload.maxElements, payload.includeValues === true, payload.includeMenus === true, payload.includeGeometry === true);
    const result = { process_id: processId, frontmost: safe(() => process.frontmost(), false), elements: flattened.output, truncated: flattened.truncated, menus_included: payload.includeMenus === true };
    if (payload.includeWindowState === true) {
      const front = frontWindowForProcess(process);
      result.window_state = {
        process_id: processId,
        front_bounds: front ? front.bounds : null,
        front_title: front ? front.title : '',
        candidates: cgWindowsForProcess(processId).slice(0, 32),
      };
      if (processGeneration) result.window_state.process_generation = processGeneration;
    }
    assertProcessInstance(processInstance, processId, processGeneration);
    if (processGeneration) result.process_generation = processGeneration;
    return result;
  }
  if (payload.operation === 'verify_value') {
    const requireGeometry = Boolean(payload.expectedWindowBounds || payload.expectedElementBounds);
    const flattened = flatten(process, payload.maxDepth, payload.maxElements, false, payload.includeMenus === true, requireGeometry);
    const matchesList = [];
    for (let i = 0; i < flattened.output.length; i++) if (matches(flattened.output[i], payload.selector)) matchesList.push(i);
    const chosen = payload.selector.index !== undefined ? matchesList[payload.selector.index] : matchesList[0];
    if (chosen === undefined || chosen < 0 || chosen >= flattened.elements.length) throw new Error('no UI element matched selector during value verification');
    const chosenItem = flattened.output[chosen];
    if (payload.expectedWindowBounds && !sameWindowBounds(chosenItem.window_screen_box, payload.expectedWindowBounds)) {
      throw new Error('application verification target window changed after post observation');
    }
    if (payload.expectedElementBounds && !sameWindowBounds(chosenItem.screen_box, payload.expectedElementBounds)) {
      throw new Error('application verification target geometry changed after post observation');
    }
    assertProcessInstance(processInstance, processId, processGeneration);
    if (chosenItem.sensitive === true) return { supported: false, matched: false, matched_count: matchesList.length, selected_index: chosen, reason: 'sensitive_target' };
    const actual = safe(() => flattened.elements[chosen].value(), null);
    assertProcessInstance(processInstance, processId, processGeneration);
    if (typeof actual !== 'string') return { supported: false, matched: false, matched_count: matchesList.length, selected_index: chosen, reason: 'value_type_unavailable' };
    if (typeof payload.value !== 'string') throw new Error('application verification value is invalid');
    return { supported: true, matched: actual === payload.value, matched_count: matchesList.length, selected_index: chosen, reason: 'compared' };
  }
  if (payload.action === 'activate') {
    assertProcessInstance(processInstance, processId, processGeneration);
    try { mutationStarted = true; process.frontmost = true; }
    catch (_) { throw new Error('application activation may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying.'); }
    assertProcessInstance(processInstance, processId, processGeneration);
    return { ok: true, matched: 1 };
  }
  const requireGeometry = Boolean(payload.expectedWindowBounds || payload.expectedElementBounds);
  const flattened = flatten(process, payload.maxDepth, payload.maxElements, false, payload.includeMenus === true, requireGeometry);
  const matchesList = [];
  for (let i = 0; i < flattened.output.length; i++) if (matches(flattened.output[i], payload.selector)) matchesList.push(i);
  const chosen = payload.selector.index !== undefined ? matchesList[payload.selector.index] : matchesList[0];
  if (chosen === undefined || chosen < 0 || chosen >= flattened.elements.length) throw new Error('no UI element matched selector');
  const chosenItem = flattened.output[chosen];
  if (payload.expectedWindowBounds && !sameWindowBounds(chosenItem.window_screen_box, payload.expectedWindowBounds)) {
    throw new Error('application target window changed before dispatch');
  }
  if (payload.expectedElementBounds && !sameWindowBounds(chosenItem.screen_box, payload.expectedElementBounds)) {
    throw new Error('application target geometry changed before dispatch');
  }
  const element = flattened.elements[chosen];
  assertProcessInstance(processInstance, processId, processGeneration);
  if (payload.action === 'check' || payload.action === 'uncheck') {
    const desired = payload.action === 'check';
    const role = typeof chosenItem.role === 'string' ? chosenItem.role : '';
    if (role !== 'AXCheckBox' && !(payload.action === 'check' && role === 'AXRadioButton')) {
      throw new Error(payload.action === 'check'
        ? 'application check target is not an Accessibility checkbox or radio button'
        : 'application uncheck target is not an Accessibility checkbox');
    }
    if (typeof chosenItem.checked !== 'boolean') throw new Error('application target checked state is unavailable before dispatch');
    const checkedBefore = chosenItem.checked;
    if (checkedBefore === desired) {
      assertProcessInstance(processInstance, processId, processGeneration);
      return { ok: true, matched: matchesList.length, selected_index: chosen, no_input_required: true, checked_before: checkedBefore, checked_after: checkedBefore, element: describe(element, chosen, false, false) };
    }
    const press = safe(() => element.actions.byName('AXPress'), null);
    if (!press || !safe(() => press.exists(), false)) throw new Error('application target does not expose AXPress before checked-state dispatch');
    assertProcessInstance(processInstance, processId, processGeneration);
    try { mutationStarted = true; press.perform(); }
    catch (_) { throw new Error('application checked-state input may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying.'); }
    const after = describe(element, chosen, false, false);
    assertProcessInstance(processInstance, processId, processGeneration);
    return { ok: true, matched: matchesList.length, selected_index: chosen, no_input_required: false, checked_before: checkedBefore, checked_after: after.checked, element: after };
  }
  if (payload.action === 'click' || payload.action === 'press') {
    const action = safe(() => element.actions.byName('AXPress'), null);
    assertProcessInstance(processInstance, processId, processGeneration);
    try {
      mutationStarted = true;
      if (action && safe(() => action.exists(), false)) action.perform();
      else element.click();
    } catch (_) {
      throw new Error('application Accessibility input may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying.');
    }
  } else if (payload.action === 'set_value') {
    if (payload.value === null) throw new Error('set_value requires value or value_resource');
    assertProcessInstance(processInstance, processId, processGeneration);
    try { mutationStarted = true; element.value = payload.value; }
    catch (_) { throw new Error('application value input may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying.'); }
  } else if (payload.action === 'focus') {
    assertProcessInstance(processInstance, processId, processGeneration);
    try { mutationStarted = true; element.focused = true; }
    catch (_) { throw new Error('application Accessibility input may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying.'); }
  } else {
    throw new Error('unsupported action');
  }
  const result = { ok: true, matched: matchesList.length, selected_index: chosen, element: describe(element, chosen, false, false) };
  if (payload.includeProcessGeneration === true) {
    result.process_id = processId;
    if (processGeneration) result.process_generation = processGeneration;
  }
  assertProcessInstance(processInstance, processId, processGeneration);
  return result;
}
(() => { try { return JSON.stringify(main()); } catch (error) {
  const message = String(error.message || error);
  const safeMessage = mutationStarted
    ? 'application Accessibility mutation may have been partially dispatched; the action outcome is unknown. Inspect the application before retrying.'
    : message;
  return JSON.stringify({ error: safeMessage });
} })()
`;
