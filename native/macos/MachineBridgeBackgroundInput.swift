import AppKit
import CoreGraphics
import Darwin
import Foundation

private let skyLightPath = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
private let hiServicesPath = "/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices"

private typealias PostToPidFn = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Void
private typealias SetWindowLocationFn = @convention(c) (UnsafeMutableRawPointer?, Double, Double) -> Void
private typealias SetIntegerFieldFn = @convention(c) (UnsafeMutableRawPointer?, UInt32, Int64) -> Void
private typealias PostEventRecordFn = @convention(c) (UnsafeRawPointer?, UnsafeRawPointer?) -> Int32
private typealias GetFrontProcessFn = @convention(c) (UnsafeMutableRawPointer?) -> Int32
private typealias GetProcessForPidFn = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Int32

private struct Request: Decodable {
    let operation: String
    let pid: Int32?
    let process_generation: String?
    let window_id: UInt32?
    let screen_x: Double?
    let screen_y: Double?
    let local_x: Double?
    let local_y: Double?
    let destination_screen_x: Double?
    let destination_screen_y: Double?
    let destination_local_x: Double?
    let destination_local_y: Double?
    let delta_x: Double?
    let delta_y: Double?
    let click_count: Int?
    let text: String?
    let key: String?
    let window_x: Double?
    let window_y: Double?
    let window_width: Double?
    let window_height: Double?
}

private struct Response: Encodable {
    let ok: Bool
    let backend: String
    let focus_without_raise: Bool?
    let frontmost_restored: Bool?
    let front_window_validated: Bool?
    let cursor_preserved: Bool?
    let dispatch_started: Bool?
    let error: String?
    let input_transport: String?

    init(
        ok: Bool,
        backend: String,
        focus_without_raise: Bool?,
        frontmost_restored: Bool?,
        front_window_validated: Bool?,
        cursor_preserved: Bool?,
        dispatch_started: Bool?,
        error: String?,
        input_transport: String? = nil
    ) {
        self.ok = ok
        self.backend = backend
        self.focus_without_raise = focus_without_raise
        self.frontmost_restored = frontmost_restored
        self.front_window_validated = front_window_validated
        self.cursor_preserved = cursor_preserved
        self.dispatch_started = dispatch_started
        self.error = error
        self.input_transport = input_transport
    }
}

private final class SkyLightSymbols {
    let sky: UnsafeMutableRawPointer
    let hi: UnsafeMutableRawPointer
    let postToPid: PostToPidFn
    let setWindowLocation: SetWindowLocationFn
    let setIntegerField: SetIntegerFieldFn
    let postEventRecord: PostEventRecordFn
    let getFrontProcess: GetFrontProcessFn
    let getProcessForPid: GetProcessForPidFn

    init?() {
        guard let sky = dlopen(skyLightPath, RTLD_LAZY | RTLD_GLOBAL),
              let hi = dlopen(hiServicesPath, RTLD_LAZY | RTLD_GLOBAL) else { return nil }
        func load<T>(_ handle: UnsafeMutableRawPointer, _ name: String, _: T.Type) -> T? {
            guard let pointer = dlsym(handle, name) else { return nil }
            return unsafeBitCast(pointer, to: T.self)
        }
        guard let postToPid = load(sky, "SLEventPostToPid", PostToPidFn.self),
              let setWindowLocation = load(sky, "CGEventSetWindowLocation", SetWindowLocationFn.self),
              let setIntegerField = load(sky, "SLEventSetIntegerValueField", SetIntegerFieldFn.self),
              let postEventRecord = load(sky, "SLPSPostEventRecordTo", PostEventRecordFn.self),
              let getFrontProcess = load(sky, "_SLPSGetFrontProcess", GetFrontProcessFn.self),
              let getProcessForPid = load(hi, "GetProcessForPID", GetProcessForPidFn.self) else { return nil }
        self.sky = sky
        self.hi = hi
        self.postToPid = postToPid
        self.setWindowLocation = setWindowLocation
        self.setIntegerField = setIntegerField
        self.postEventRecord = postEventRecord
        self.getFrontProcess = getFrontProcess
        self.getProcessForPid = getProcessForPid
    }

    deinit {
        dlclose(hi)
        dlclose(sky)
    }
}

private func encode(_ response: Response) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(response), let text = String(data: data, encoding: .utf8) else {
        print("{\"ok\":false,\"backend\":\"skylight-experimental\",\"error\":\"encoding_failed\"}")
        return
    }
    print(text)
}

private struct FocusPreparationResult {
    let ok: Bool
    let dispatchStarted: Bool
}

private enum PointerTransport {
    case skyLight
    case publicCGEvent

    var label: String {
        switch self {
        case .skyLight: "skylight-pid"
        case .publicCGEvent: "public-cgevent-pid"
        }
    }
}

private func pointerTransport(application: NSRunningApplication) -> PointerTransport {
    let bundleId = String(application.bundleIdentifier ?? "").lowercased()
    let skyLightPrefixes = [
        "com.google.chrome", "org.chromium.chromium", "com.microsoft.edgemac",
        "company.thebrowser.browser", "com.brave.browser", "com.vivaldi.vivaldi",
    ]
    if skyLightPrefixes.contains(where: { bundleId.hasPrefix($0) }) { return .skyLight }
    if let bundleURL = application.bundleURL,
       let info = Bundle(url: bundleURL)?.infoDictionary {
        let principal = String(info["NSPrincipalClass"] as? String ?? "")
        if principal.contains("AtomApplication") || info["ElectronAsarIntegrity"] != nil { return .skyLight }
        if info["UIApplicationSceneManifest"] != nil || info["UIDeviceFamily"] != nil { return .skyLight }
    }
    return .publicCGEvent
}

private func postPointerEvent(_ event: CGEvent, symbols: SkyLightSymbols, pid: pid_t, transport: PointerTransport) {
    switch transport {
    case .skyLight:
        symbols.postToPid(pid, Unmanaged.passUnretained(event).toOpaque())
    case .publicCGEvent:
        event.postToPid(pid)
    }
}

private func frontmostInstanceStillMatches(_ expected: NSRunningApplication?) -> Bool {
    guard let expected else { return NSWorkspace.shared.frontmostApplication == nil }
    guard !expected.isTerminated, let current = NSWorkspace.shared.frontmostApplication else { return false }
    return current.isEqual(expected)
}

private func focusContinuationStillAuthorized(
    priorFront: NSRunningApplication,
    targetApplication: NSRunningApplication
) -> Bool {
    guard !priorFront.isTerminated, !targetApplication.isTerminated else { return false }
    guard let current = NSWorkspace.shared.frontmostApplication else { return true }
    return current.isEqual(priorFront) || current.isEqual(targetApplication)
}

private func skyLightInputStillAuthorized(
    frameworkTransport: PointerTransport,
    priorFront: NSRunningApplication?,
    targetApplication: NSRunningApplication,
    focusDispatched: Bool
) -> Bool {
    guard frameworkTransport == .skyLight else { return true }
    guard !targetApplication.isTerminated, let current = NSWorkspace.shared.frontmostApplication else { return false }
    if !focusDispatched { return current.isEqual(targetApplication) }
    guard let priorFront, !priorFront.isTerminated else { return current.isEqual(targetApplication) }
    return current.isEqual(priorFront) || current.isEqual(targetApplication)
}

private func inputBoundaryStillValid(
    pid: pid_t,
    application: NSRunningApplication,
    windowId: UInt32,
    expected: CGRect,
    frameworkTransport: PointerTransport,
    priorFront: NSRunningApplication?,
    focusDispatched: Bool
) -> Bool {
    frontWindowStillMatches(pid: pid, application: application, windowId: windowId, expected: expected)
        && skyLightInputStillAuthorized(
            frameworkTransport: frameworkTransport, priorFront: priorFront,
            targetApplication: application, focusDispatched: focusDispatched
        )
}

private func prepareFocusIfNeeded(
    _ symbols: SkyLightSymbols,
    pid: pid_t,
    windowId: UInt32,
    frameworkTransport: PointerTransport,
    priorFront: NSRunningApplication?,
    targetApplication: NSRunningApplication
) -> FocusPreparationResult {
    guard frameworkTransport == .skyLight else { return FocusPreparationResult(ok: true, dispatchStarted: false) }
    guard frontmostInstanceStillMatches(priorFront) else {
        return FocusPreparationResult(ok: false, dispatchStarted: false)
    }
    if let priorFront, priorFront.isEqual(targetApplication) {
        return FocusPreparationResult(ok: true, dispatchStarted: false)
    }
    guard let priorFront, !priorFront.isTerminated else {
        return FocusPreparationResult(ok: false, dispatchStarted: false)
    }
    return focusWithoutRaise(
        symbols, pid: pid, windowId: windowId, priorFront: priorFront, targetApplication: targetApplication
    )
}

private func focusWithoutRaise(
    _ symbols: SkyLightSymbols,
    pid: pid_t,
    windowId: UInt32,
    priorFront: NSRunningApplication,
    targetApplication: NSRunningApplication
) -> FocusPreparationResult {
    guard processInstanceStillMatches(pid: pid, application: targetApplication),
          frontmostInstanceStillMatches(priorFront), !priorFront.isTerminated else {
        return FocusPreparationResult(ok: false, dispatchStarted: false)
    }
    var previous = [UInt8](repeating: 0, count: 8)
    var expectedPrevious = [UInt8](repeating: 0, count: 8)
    var target = [UInt8](repeating: 0, count: 8)
    let previousResolved = previous.withUnsafeMutableBytes { symbols.getFrontProcess($0.baseAddress) == 0 }
    let expectedPreviousResolved = expectedPrevious.withUnsafeMutableBytes {
        symbols.getProcessForPid(priorFront.processIdentifier, $0.baseAddress) == 0
    }
    let targetResolved = target.withUnsafeMutableBytes { symbols.getProcessForPid(pid, $0.baseAddress) == 0 }
    guard previousResolved && expectedPreviousResolved && targetResolved,
          previous == expectedPrevious,
          processInstanceStillMatches(pid: pid, application: targetApplication),
          frontmostInstanceStillMatches(priorFront), !priorFront.isTerminated else {
        return FocusPreparationResult(ok: false, dispatchStarted: false)
    }

    var record = [UInt8](repeating: 0, count: 0xF8)
    record[0x04] = 0xF8
    record[0x08] = 0x0D
    let littleEndian = windowId.littleEndian
    withUnsafeBytes(of: littleEndian) { bytes in
        for index in 0..<4 { record[0x3C + index] = bytes[index] }
    }
    var lastHopPrevious = [UInt8](repeating: 0, count: 8)
    let lastHopPreviousResolved = lastHopPrevious.withUnsafeMutableBytes { symbols.getFrontProcess($0.baseAddress) == 0 }
    guard lastHopPreviousResolved, lastHopPrevious == expectedPrevious,
          processInstanceStillMatches(pid: pid, application: targetApplication),
          frontmostInstanceStillMatches(priorFront), !priorFront.isTerminated else {
        return FocusPreparationResult(ok: false, dispatchStarted: false)
    }
    record[0x8A] = 0x02
    let defocused = lastHopPrevious.withUnsafeBytes { psn in
        record.withUnsafeBytes { body in symbols.postEventRecord(psn.baseAddress, body.baseAddress) == 0 }
    }
    guard defocused else { return FocusPreparationResult(ok: false, dispatchStarted: true) }

    var lastHopTarget = [UInt8](repeating: 0, count: 8)
    let lastHopTargetResolved = lastHopTarget.withUnsafeMutableBytes { symbols.getProcessForPid(pid, $0.baseAddress) == 0 }
    guard lastHopTargetResolved, lastHopTarget == target,
          processInstanceStillMatches(pid: pid, application: targetApplication),
          focusContinuationStillAuthorized(priorFront: priorFront, targetApplication: targetApplication) else {
        return FocusPreparationResult(ok: false, dispatchStarted: true)
    }
    record[0x8A] = 0x01
    let focused = lastHopTarget.withUnsafeBytes { psn in
        record.withUnsafeBytes { body in symbols.postEventRecord(psn.baseAddress, body.baseAddress) == 0 }
    }
    return FocusPreparationResult(ok: focused, dispatchStarted: true)
}

private func stamp(
    _ event: CGEvent,
    symbols: SkyLightSymbols,
    pid: pid_t,
    windowId: UInt32,
    localX: Double,
    localY: Double,
    clickState: Int64,
    phase: Int64,
    clickGroup: Int64,
    subtype: Int64 = 3
) {
    let pointer = Unmanaged.passUnretained(event).toOpaque()
    symbols.setIntegerField(pointer, 0, phase)
    symbols.setIntegerField(pointer, 1, clickState)
    symbols.setIntegerField(pointer, 3, 0)
    symbols.setIntegerField(pointer, 7, subtype)
    symbols.setIntegerField(pointer, 40, Int64(pid))
    symbols.setIntegerField(pointer, 51, Int64(windowId))
    symbols.setIntegerField(pointer, 91, Int64(windowId))
    symbols.setIntegerField(pointer, 92, Int64(windowId))
    symbols.setIntegerField(pointer, 58, clickGroup)
    symbols.setWindowLocation(pointer, localX, localY)
}

private func sendMouseEvent(
    _ type: CGEventType,
    symbols: SkyLightSymbols,
    source: CGEventSource,
    pid: pid_t,
    windowId: UInt32,
    screenX: Double,
    screenY: Double,
    localX: Double,
    localY: Double,
    clickState: Int64,
    phase: Int64,
    clickGroup: Int64,
    transport: PointerTransport,
    subtype: Int64 = 3
) throws {
    guard let event = CGEvent(
        mouseEventSource: source,
        mouseType: type,
        mouseCursorPosition: CGPoint(x: screenX, y: screenY),
        mouseButton: .left
    ) else { throw NSError(domain: "MachineBridgeBackgroundInput", code: 1) }
    stamp(event, symbols: symbols, pid: pid, windowId: windowId, localX: localX, localY: localY,
          clickState: clickState, phase: phase, clickGroup: clickGroup, subtype: subtype)
    postPointerEvent(event, symbols: symbols, pid: pid, transport: transport)
}

private func sendScrollEvent(
    symbols: SkyLightSymbols,
    source: CGEventSource,
    pid: pid_t,
    windowId: UInt32,
    screenX: Double,
    screenY: Double,
    localX: Double,
    localY: Double,
    deltaX: Int32,
    deltaY: Int32,
    transport: PointerTransport
) throws {
    guard let event = CGEvent(
        scrollWheelEvent2Source: source,
        units: .pixel,
        wheelCount: 2,
        wheel1: deltaY,
        wheel2: deltaX,
        wheel3: 0
    ) else { throw NSError(domain: "MachineBridgeBackgroundInput", code: 6) }
    event.location = CGPoint(x: screenX, y: screenY)
    let pointer = Unmanaged.passUnretained(event).toOpaque()
    symbols.setIntegerField(pointer, 40, Int64(pid))
    symbols.setIntegerField(pointer, 51, Int64(windowId))
    symbols.setIntegerField(pointer, 91, Int64(windowId))
    symbols.setIntegerField(pointer, 92, Int64(windowId))
    symbols.setWindowLocation(pointer, localX, localY)
    postPointerEvent(event, symbols: symbols, pid: pid, transport: transport)
}

private func near(_ left: Double, _ right: Double, tolerance: Double = 1.0) -> Bool {
    left.isFinite && right.isFinite && abs(left - right) <= tolerance
}

private func processStartSignature(pid: pid_t) -> String? {
    var info = proc_bsdinfo()
    let size = MemoryLayout<proc_bsdinfo>.size
    let copied = withUnsafeMutablePointer(to: &info) { pointer in
        proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, pointer, Int32(size))
    }
    guard copied == size, info.pbi_pid == UInt32(pid) else { return nil }
    var start = Data()
    withUnsafeBytes(of: info.pbi_start_tvsec) { start.append(contentsOf: $0) }
    withUnsafeBytes(of: info.pbi_start_tvusec) { start.append(contentsOf: $0) }
    guard start.count == 16 else { return nil }
    return start.base64EncodedString()
}

private func processGenerationToken(pid: pid_t) -> String? {
    guard let signature = processStartSignature(pid: pid) else { return nil }
    return "proc:\(signature)"
}

private func processInstanceStillMatches(pid: pid_t, application: NSRunningApplication) -> Bool {
    guard !application.isTerminated,
          let current = NSRunningApplication(processIdentifier: pid), !current.isTerminated else { return false }
    return application.isEqual(current)
}

private func runningApplication(pid: pid_t, expectedGeneration: String) -> NSRunningApplication? {
    guard !expectedGeneration.isEmpty, expectedGeneration.count <= 2048,
          !expectedGeneration.contains("\n"), !expectedGeneration.contains("\r"), !expectedGeneration.contains("\0"),
          let application = NSRunningApplication(processIdentifier: pid), !application.isTerminated,
          processGenerationToken(pid: pid) == expectedGeneration,
          processInstanceStillMatches(pid: pid, application: application) else { return nil }
    return application
}

private func keyboardFailure(dispatchStarted: Bool, error: String) -> Response {
    Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
             frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
             dispatch_started: dispatchStarted,
             error: dispatchStarted ? "dispatch_outcome_unknown" : error,
             input_transport: "public-cgevent-pid")
}

private func unicodeKeystroke(_ request: Request) -> Response {
    guard let rawPid = request.pid, rawPid > 0,
          let processGeneration = request.process_generation,
          let text = request.text, !text.isEmpty, !text.contains("\0") else {
        return keyboardFailure(dispatchStarted: false, error: "invalid_request_before_dispatch")
    }
    let units = Array(text.utf16)
    guard units.count <= 4_000 else {
        return keyboardFailure(dispatchStarted: false, error: "invalid_request_before_dispatch")
    }
    let pid = pid_t(rawPid)
    guard let application = runningApplication(pid: pid, expectedGeneration: processGeneration) else {
        return keyboardFailure(dispatchStarted: false, error: "process_generation_changed_before_dispatch")
    }

    var start = 0
    var dispatchStarted = false
    while start < units.count {
        var end = min(start + 20, units.count)
        if end < units.count,
           units[end - 1] >= 0xD800, units[end - 1] <= 0xDBFF,
           units[end] >= 0xDC00, units[end] <= 0xDFFF {
            end -= 1
        }
        guard end > start, processInstanceStillMatches(pid: pid, application: application),
              let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            return keyboardFailure(dispatchStarted: dispatchStarted, error: "input_unavailable_before_dispatch")
        }
        let chunk = Array(units[start..<end])
        chunk.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
        }
        down.postToPid(pid)
        dispatchStarted = true
        usleep(5_000)
        guard processInstanceStillMatches(pid: pid, application: application) else {
            return keyboardFailure(dispatchStarted: true, error: "dispatch_outcome_unknown")
        }
        up.postToPid(pid)
        usleep(5_000)
        start = end
    }
    return Response(ok: true, backend: "skylight-experimental", focus_without_raise: nil,
                    frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
                    dispatch_started: true, error: nil, input_transport: "public-cgevent-pid")
}

private func specialKeySpec(_ value: String) -> (keyCode: CGKeyCode, shifted: Bool)? {
    let shifted = value.hasPrefix("Shift+")
    let key = shifted ? String(value.dropFirst(6)) : value
    let keyCodes: [String: CGKeyCode] = [
        "Enter": 0x24, "Tab": 0x30, "Space": 0x31, "Backspace": 0x33, "Escape": 0x35,
        "Home": 0x73, "PageUp": 0x74, "Delete": 0x75, "End": 0x77, "PageDown": 0x79,
        "ArrowLeft": 0x7B, "ArrowRight": 0x7C, "ArrowDown": 0x7D, "ArrowUp": 0x7E,
    ]
    guard let keyCode = keyCodes[key] else { return nil }
    return (keyCode, shifted)
}

private func specialKeyPress(_ request: Request) -> Response {
    guard let rawPid = request.pid, rawPid > 0,
          let processGeneration = request.process_generation,
          let key = request.key, let spec = specialKeySpec(key) else {
        return keyboardFailure(dispatchStarted: false, error: "invalid_request_before_dispatch")
    }
    let pid = pid_t(rawPid)
    guard let application = runningApplication(pid: pid, expectedGeneration: processGeneration) else {
        return keyboardFailure(dispatchStarted: false, error: "process_generation_changed_before_dispatch")
    }
    guard processInstanceStillMatches(pid: pid, application: application),
          let down = CGEvent(keyboardEventSource: nil, virtualKey: spec.keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: spec.keyCode, keyDown: false) else {
        return keyboardFailure(dispatchStarted: false, error: "input_unavailable_before_dispatch")
    }
    if spec.shifted {
        down.flags = .maskShift
        up.flags = .maskShift
    }
    down.postToPid(pid)
    usleep(5_000)
    guard processInstanceStillMatches(pid: pid, application: application) else {
        return keyboardFailure(dispatchStarted: true, error: "dispatch_outcome_unknown")
    }
    up.postToPid(pid)
    usleep(5_000)
    return Response(ok: true, backend: "skylight-experimental", focus_without_raise: nil,
                    frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
                    dispatch_started: true, error: nil, input_transport: "public-cgevent-pid")
}

private func frontWindowStillMatches(
    pid: pid_t,
    application: NSRunningApplication,
    windowId: UInt32,
    expected: CGRect
) -> Bool {
    guard processInstanceStillMatches(pid: pid, application: application),
          let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID),
          let windows = raw as? [[String: Any]] else { return false }
    for info in windows {
        let ownerPid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
        let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
        let alpha = (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
        guard ownerPid == pid, layer == 0, alpha > 0 else { continue }
        let candidateId = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0
        guard let boundsObject = info[kCGWindowBounds as String] as? NSDictionary,
              let candidateBounds = CGRect(dictionaryRepresentation: boundsObject) else { return false }
        return candidateId == windowId
            && near(candidateBounds.origin.x, expected.origin.x)
            && near(candidateBounds.origin.y, expected.origin.y)
            && near(candidateBounds.size.width, expected.size.width)
            && near(candidateBounds.size.height, expected.size.height)
    }
    return false
}

private func cursorLocation() -> CGPoint? {
    NSEvent.mouseLocation
}

private func restoreFrontmostIfNeeded(
    priorFront: NSRunningApplication?, targetApplication: NSRunningApplication, focusDispatched: Bool
) -> Bool {
    guard focusDispatched,
          let priorFront, !priorFront.isEqual(targetApplication), !priorFront.isTerminated,
          let current = NSWorkspace.shared.frontmostApplication, current.isEqual(targetApplication) else { return false }
    return priorFront.activate(options: [])
}

private func click(_ request: Request, symbols: SkyLightSymbols) -> Response {
    guard let rawPid = request.pid, rawPid > 0,
          let processGeneration = request.process_generation,
          let windowId = request.window_id, windowId > 0,
          let screenX = request.screen_x, screenX.isFinite,
          let screenY = request.screen_y, screenY.isFinite,
          let localX = request.local_x, localX.isFinite,
          let localY = request.local_y, localY.isFinite,
          let windowX = request.window_x, windowX.isFinite,
          let windowY = request.window_y, windowY.isFinite,
          let windowWidth = request.window_width, windowWidth > 0, windowWidth.isFinite,
          let windowHeight = request.window_height, windowHeight > 0, windowHeight.isFinite,
          localX >= 0, localY >= 0, localX < windowWidth, localY < windowHeight,
          (request.click_count ?? 1) >= 1, (request.click_count ?? 1) <= 2 else {
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
                        frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
                        dispatch_started: false, error: "invalid_request_before_dispatch")
    }
    let pid = pid_t(rawPid)
    guard let targetApplication = runningApplication(pid: pid, expectedGeneration: processGeneration) else {
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
                        frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
                        dispatch_started: false, error: "process_generation_changed_before_dispatch")
    }
    let clickCount = request.click_count ?? 1
    let transport = pointerTransport(application: targetApplication)
    let frameworkTransport = transport
    let clickSubtype: Int64 = switch transport {
    case .skyLight: 3
    case .publicCGEvent: 0
    }
    let expectedBounds = CGRect(x: windowX, y: windowY, width: windowWidth, height: windowHeight)
    guard frontWindowStillMatches(pid: pid, application: targetApplication, windowId: windowId, expected: expectedBounds) else {
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
                        frontmost_restored: nil, front_window_validated: false, cursor_preserved: nil,
                        dispatch_started: false, error: "front_window_changed_before_dispatch")
    }

    let cursorBefore = cursorLocation()
    let priorFront = NSWorkspace.shared.frontmostApplication
    let focusPreparation = prepareFocusIfNeeded(
        symbols, pid: pid, windowId: windowId, frameworkTransport: transport,
        priorFront: priorFront, targetApplication: targetApplication
    )
    guard focusPreparation.ok else {
        let restored = restoreFrontmostIfNeeded(
            priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted
        )
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                        frontmost_restored: restored, front_window_validated: true, cursor_preserved: nil,
                        dispatch_started: focusPreparation.dispatchStarted,
                        error: focusPreparation.dispatchStarted ? "dispatch_outcome_unknown" : "focus_without_raise_unavailable_before_dispatch")
    }
    if focusPreparation.dispatchStarted { usleep(50_000) }
    guard skyLightInputStillAuthorized(
        frameworkTransport: transport, priorFront: priorFront,
        targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted
    ) else {
        let restored = restoreFrontmostIfNeeded(
            priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted
        )
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                        frontmost_restored: restored, front_window_validated: true, cursor_preserved: nil,
                        dispatch_started: focusPreparation.dispatchStarted,
                        error: focusPreparation.dispatchStarted ? "dispatch_outcome_unknown" : "frontmost_changed_before_input")
    }
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        let restored = restoreFrontmostIfNeeded(
            priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted
        )
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                        frontmost_restored: restored, front_window_validated: true, cursor_preserved: nil,
                        dispatch_started: focusPreparation.dispatchStarted,
                        error: focusPreparation.dispatchStarted ? "dispatch_outcome_unknown" : "event_source_unavailable_before_dispatch")
    }

    let clickGroup = Int64(UInt32.random(in: 1...UInt32.max))
    var pointerDispatchStarted = false
    var downSent = false
    var upSent = true
    var activeClickState: Int64 = 0
    do {
        guard inputBoundaryStillValid(
            pid: pid, application: targetApplication, windowId: windowId, expected: expectedBounds,
            frameworkTransport: frameworkTransport, priorFront: priorFront,
            focusDispatched: focusPreparation.dispatchStarted
        ) else {
            throw NSError(domain: "MachineBridgeBackgroundInput", code: 11)
        }
        try sendMouseEvent(.mouseMoved, symbols: symbols, source: source, pid: pid, windowId: windowId,
                           screenX: screenX, screenY: screenY, localX: localX, localY: localY,
                           clickState: 0, phase: 2, clickGroup: clickGroup, transport: transport, subtype: clickSubtype)
        pointerDispatchStarted = true
        usleep(15_000)
        for clickState in 1...clickCount {
            activeClickState = Int64(clickState)
            guard inputBoundaryStillValid(
                pid: pid, application: targetApplication, windowId: windowId, expected: expectedBounds,
                frameworkTransport: frameworkTransport, priorFront: priorFront,
                focusDispatched: focusPreparation.dispatchStarted
            ) else {
                throw NSError(domain: "MachineBridgeBackgroundInput", code: 12)
            }
            try sendMouseEvent(.leftMouseDown, symbols: symbols, source: source, pid: pid, windowId: windowId,
                               screenX: screenX, screenY: screenY, localX: localX, localY: localY,
                               clickState: activeClickState, phase: 3, clickGroup: clickGroup, transport: transport, subtype: clickSubtype)
            pointerDispatchStarted = true
            downSent = true
            upSent = false
            usleep(28_000)
            guard inputBoundaryStillValid(
                pid: pid, application: targetApplication, windowId: windowId, expected: expectedBounds,
                frameworkTransport: frameworkTransport, priorFront: priorFront,
                focusDispatched: focusPreparation.dispatchStarted
            ) else {
                throw NSError(domain: "MachineBridgeBackgroundInput", code: 13)
            }
            try sendMouseEvent(.leftMouseUp, symbols: symbols, source: source, pid: pid, windowId: windowId,
                               screenX: screenX, screenY: screenY, localX: localX, localY: localY,
                               clickState: activeClickState, phase: 3, clickGroup: clickGroup, transport: transport, subtype: clickSubtype)
            pointerDispatchStarted = true
            upSent = true
            downSent = false
            if clickState < clickCount { usleep(55_000) }
        }
    } catch {
        if downSent && !upSent && processInstanceStillMatches(pid: pid, application: targetApplication) {
            try? sendMouseEvent(.leftMouseUp, symbols: symbols, source: source, pid: pid, windowId: windowId,
                                screenX: screenX, screenY: screenY, localX: localX, localY: localY,
                                clickState: activeClickState, phase: 3, clickGroup: clickGroup, transport: transport, subtype: clickSubtype)
        }
        let dispatchStarted = focusPreparation.dispatchStarted || pointerDispatchStarted
        let restored = restoreFrontmostIfNeeded(priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted)
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                        frontmost_restored: restored, front_window_validated: true, cursor_preserved: nil,
                        dispatch_started: dispatchStarted,
                        error: dispatchStarted ? "dispatch_outcome_unknown" : "input_unavailable_before_dispatch")
    }

    usleep(50_000)
    let restored = restoreFrontmostIfNeeded(priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted)
    let cursorAfter = cursorLocation()
    let cursorPreserved: Bool? = {
        guard let cursorBefore, let cursorAfter else { return nil }
        return hypot(cursorBefore.x - cursorAfter.x, cursorBefore.y - cursorAfter.y) <= 0.5
    }()
    return Response(ok: true, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                    frontmost_restored: restored, front_window_validated: true, cursor_preserved: cursorPreserved,
                    dispatch_started: true, error: nil, input_transport: transport.label)
}

private func drag(_ request: Request, symbols: SkyLightSymbols) -> Response {
    guard let rawPid = request.pid, rawPid > 0,
          let processGeneration = request.process_generation,
          let windowId = request.window_id, windowId > 0,
          let screenX = request.screen_x, screenX.isFinite,
          let screenY = request.screen_y, screenY.isFinite,
          let localX = request.local_x, localX.isFinite,
          let localY = request.local_y, localY.isFinite,
          let destinationScreenX = request.destination_screen_x, destinationScreenX.isFinite,
          let destinationScreenY = request.destination_screen_y, destinationScreenY.isFinite,
          let destinationLocalX = request.destination_local_x, destinationLocalX.isFinite,
          let destinationLocalY = request.destination_local_y, destinationLocalY.isFinite,
          let windowX = request.window_x, windowX.isFinite,
          let windowY = request.window_y, windowY.isFinite,
          let windowWidth = request.window_width, windowWidth > 0, windowWidth.isFinite,
          let windowHeight = request.window_height, windowHeight > 0, windowHeight.isFinite,
          localX >= 0, localY >= 0, destinationLocalX >= 0, destinationLocalY >= 0,
          localX < windowWidth, localY < windowHeight,
          destinationLocalX < windowWidth, destinationLocalY < windowHeight else {
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
                        frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
                        dispatch_started: false, error: "invalid_request_before_dispatch")
    }
    let pid = pid_t(rawPid)
    guard let targetApplication = runningApplication(pid: pid, expectedGeneration: processGeneration) else {
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
                        frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
                        dispatch_started: false, error: "process_generation_changed_before_dispatch")
    }
    let transport = pointerTransport(application: targetApplication)
    let frameworkTransport = transport
    let expectedBounds = CGRect(x: windowX, y: windowY, width: windowWidth, height: windowHeight)
    guard frontWindowStillMatches(pid: pid, application: targetApplication, windowId: windowId, expected: expectedBounds) else {
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
                        frontmost_restored: nil, front_window_validated: false, cursor_preserved: nil,
                        dispatch_started: false, error: "front_window_changed_before_dispatch")
    }

    let cursorBefore = cursorLocation()
    let priorFront = NSWorkspace.shared.frontmostApplication
    let focusPreparation = prepareFocusIfNeeded(
        symbols, pid: pid, windowId: windowId, frameworkTransport: transport,
        priorFront: priorFront, targetApplication: targetApplication
    )
    guard focusPreparation.ok else {
        let restored = restoreFrontmostIfNeeded(
            priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted
        )
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                        frontmost_restored: restored, front_window_validated: true, cursor_preserved: nil,
                        dispatch_started: focusPreparation.dispatchStarted,
                        error: focusPreparation.dispatchStarted ? "dispatch_outcome_unknown" : "focus_without_raise_unavailable_before_dispatch")
    }
    if focusPreparation.dispatchStarted { usleep(50_000) }
    guard skyLightInputStillAuthorized(
        frameworkTransport: transport, priorFront: priorFront,
        targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted
    ) else {
        let restored = restoreFrontmostIfNeeded(
            priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted
        )
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                        frontmost_restored: restored, front_window_validated: true, cursor_preserved: nil,
                        dispatch_started: focusPreparation.dispatchStarted,
                        error: focusPreparation.dispatchStarted ? "dispatch_outcome_unknown" : "frontmost_changed_before_input")
    }
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        let restored = restoreFrontmostIfNeeded(
            priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted
        )
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                        frontmost_restored: restored, front_window_validated: true, cursor_preserved: nil,
                        dispatch_started: focusPreparation.dispatchStarted,
                        error: focusPreparation.dispatchStarted ? "dispatch_outcome_unknown" : "event_source_unavailable_before_dispatch")
    }

    let clickGroup = Int64(UInt32.random(in: 1...UInt32.max))
    var pointerDispatchStarted = false
    var downSent = false
    var upSent = false
    var lastScreenX = screenX
    var lastScreenY = screenY
    var lastLocalX = localX
    var lastLocalY = localY
    do {
        guard inputBoundaryStillValid(
            pid: pid, application: targetApplication, windowId: windowId, expected: expectedBounds,
            frameworkTransport: frameworkTransport, priorFront: priorFront,
            focusDispatched: focusPreparation.dispatchStarted
        ) else {
            throw NSError(domain: "MachineBridgeBackgroundInput", code: 2)
        }
        try sendMouseEvent(.mouseMoved, symbols: symbols, source: source, pid: pid, windowId: windowId,
                           screenX: screenX, screenY: screenY, localX: localX, localY: localY,
                           clickState: 0, phase: 2, clickGroup: clickGroup, transport: transport, subtype: 0)
        pointerDispatchStarted = true
        usleep(15_000)
        guard inputBoundaryStillValid(
            pid: pid, application: targetApplication, windowId: windowId, expected: expectedBounds,
            frameworkTransport: frameworkTransport, priorFront: priorFront,
            focusDispatched: focusPreparation.dispatchStarted
        ) else {
            throw NSError(domain: "MachineBridgeBackgroundInput", code: 3)
        }
        try sendMouseEvent(.leftMouseDown, symbols: symbols, source: source, pid: pid, windowId: windowId,
                           screenX: screenX, screenY: screenY, localX: localX, localY: localY,
                           clickState: 1, phase: 3, clickGroup: clickGroup, transport: transport, subtype: 0)
        pointerDispatchStarted = true
        downSent = true
        usleep(16_000)

        let steps = 8
        for step in 1...steps {
            guard inputBoundaryStillValid(
                pid: pid, application: targetApplication, windowId: windowId, expected: expectedBounds,
                frameworkTransport: frameworkTransport, priorFront: priorFront,
                focusDispatched: focusPreparation.dispatchStarted
            ) else {
                throw NSError(domain: "MachineBridgeBackgroundInput", code: 4)
            }
            let ratio = Double(step) / Double(steps)
            lastScreenX = screenX + (destinationScreenX - screenX) * ratio
            lastScreenY = screenY + (destinationScreenY - screenY) * ratio
            lastLocalX = localX + (destinationLocalX - localX) * ratio
            lastLocalY = localY + (destinationLocalY - localY) * ratio
            try sendMouseEvent(.leftMouseDragged, symbols: symbols, source: source, pid: pid, windowId: windowId,
                               screenX: lastScreenX, screenY: lastScreenY, localX: lastLocalX, localY: lastLocalY,
                               clickState: 1, phase: 3, clickGroup: clickGroup, transport: transport, subtype: 0)
            pointerDispatchStarted = true
            usleep(16_000)
        }
        guard inputBoundaryStillValid(
            pid: pid, application: targetApplication, windowId: windowId, expected: expectedBounds,
            frameworkTransport: frameworkTransport, priorFront: priorFront,
            focusDispatched: focusPreparation.dispatchStarted
        ) else {
            throw NSError(domain: "MachineBridgeBackgroundInput", code: 5)
        }
        usleep(30_000)
        try sendMouseEvent(.leftMouseUp, symbols: symbols, source: source, pid: pid, windowId: windowId,
                           screenX: destinationScreenX, screenY: destinationScreenY,
                           localX: destinationLocalX, localY: destinationLocalY,
                           clickState: 1, phase: 3, clickGroup: clickGroup, transport: transport, subtype: 0)
        pointerDispatchStarted = true
        upSent = true
    } catch {
        if downSent && !upSent && processInstanceStillMatches(pid: pid, application: targetApplication) {
            try? sendMouseEvent(.leftMouseUp, symbols: symbols, source: source, pid: pid, windowId: windowId,
                                screenX: lastScreenX, screenY: lastScreenY, localX: lastLocalX, localY: lastLocalY,
                                clickState: 1, phase: 3, clickGroup: clickGroup, transport: transport, subtype: 0)
        }
        let dispatchStarted = focusPreparation.dispatchStarted || pointerDispatchStarted
        let restored = restoreFrontmostIfNeeded(priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted)
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                        frontmost_restored: restored, front_window_validated: true, cursor_preserved: nil,
                        dispatch_started: dispatchStarted,
                        error: dispatchStarted ? "dispatch_outcome_unknown" : "input_unavailable_before_dispatch")
    }

    usleep(50_000)
    let restored = restoreFrontmostIfNeeded(priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted)
    let cursorAfter = cursorLocation()
    let cursorPreserved: Bool? = {
        guard let cursorBefore, let cursorAfter else { return nil }
        return hypot(cursorBefore.x - cursorAfter.x, cursorBefore.y - cursorAfter.y) <= 0.5
    }()
    return Response(ok: true, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                    frontmost_restored: restored, front_window_validated: true, cursor_preserved: cursorPreserved,
                    dispatch_started: true, error: nil, input_transport: transport.label)
}

private func scroll(_ request: Request, symbols: SkyLightSymbols) -> Response {
    guard let rawPid = request.pid, rawPid > 0,
          let processGeneration = request.process_generation,
          let windowId = request.window_id, windowId > 0,
          let screenX = request.screen_x, screenX.isFinite,
          let screenY = request.screen_y, screenY.isFinite,
          let localX = request.local_x, localX.isFinite,
          let localY = request.local_y, localY.isFinite,
          let requestedDeltaX = request.delta_x, requestedDeltaX.isFinite, abs(requestedDeltaX) <= 10_000,
          let requestedDeltaY = request.delta_y, requestedDeltaY.isFinite, abs(requestedDeltaY) <= 10_000,
          let windowX = request.window_x, windowX.isFinite,
          let windowY = request.window_y, windowY.isFinite,
          let windowWidth = request.window_width, windowWidth > 0, windowWidth.isFinite,
          let windowHeight = request.window_height, windowHeight > 0, windowHeight.isFinite,
          localX >= 0, localY >= 0, localX < windowWidth, localY < windowHeight else {
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
                        frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
                        dispatch_started: false, error: "invalid_request_before_dispatch")
    }
    let wheelX = Int32((-requestedDeltaX).rounded())
    let wheelY = Int32((-requestedDeltaY).rounded())
    guard wheelX != 0 || wheelY != 0 else {
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
                        frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
                        dispatch_started: false, error: "invalid_request_before_dispatch")
    }
    let pid = pid_t(rawPid)
    guard let targetApplication = runningApplication(pid: pid, expectedGeneration: processGeneration) else {
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
                        frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
                        dispatch_started: false, error: "process_generation_changed_before_dispatch")
    }
    let frameworkTransport = pointerTransport(application: targetApplication)
    let transport: PointerTransport = .skyLight
    let expectedBounds = CGRect(x: windowX, y: windowY, width: windowWidth, height: windowHeight)
    guard frontWindowStillMatches(pid: pid, application: targetApplication, windowId: windowId, expected: expectedBounds) else {
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
                        frontmost_restored: nil, front_window_validated: false, cursor_preserved: nil,
                        dispatch_started: false, error: "front_window_changed_before_dispatch")
    }

    let cursorBefore = cursorLocation()
    let priorFront = NSWorkspace.shared.frontmostApplication
    let focusPreparation = prepareFocusIfNeeded(
        symbols, pid: pid, windowId: windowId, frameworkTransport: frameworkTransport,
        priorFront: priorFront, targetApplication: targetApplication
    )
    guard focusPreparation.ok else {
        let restored = restoreFrontmostIfNeeded(
            priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted
        )
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                        frontmost_restored: restored, front_window_validated: true, cursor_preserved: nil,
                        dispatch_started: focusPreparation.dispatchStarted,
                        error: focusPreparation.dispatchStarted ? "dispatch_outcome_unknown" : "focus_without_raise_unavailable_before_dispatch")
    }
    if focusPreparation.dispatchStarted { usleep(50_000) }
    guard skyLightInputStillAuthorized(
        frameworkTransport: frameworkTransport, priorFront: priorFront,
        targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted
    ) else {
        let restored = restoreFrontmostIfNeeded(
            priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted
        )
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                        frontmost_restored: restored, front_window_validated: true, cursor_preserved: nil,
                        dispatch_started: focusPreparation.dispatchStarted,
                        error: focusPreparation.dispatchStarted ? "dispatch_outcome_unknown" : "frontmost_changed_before_input")
    }
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        let restored = restoreFrontmostIfNeeded(
            priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted
        )
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                        frontmost_restored: restored, front_window_validated: true, cursor_preserved: nil,
                        dispatch_started: focusPreparation.dispatchStarted,
                        error: focusPreparation.dispatchStarted ? "dispatch_outcome_unknown" : "event_source_unavailable_before_dispatch")
    }

    var pointerDispatchStarted = false
    do {
        let clickGroup = Int64(UInt32.random(in: 1...UInt32.max))
        guard inputBoundaryStillValid(
            pid: pid, application: targetApplication, windowId: windowId, expected: expectedBounds,
            frameworkTransport: frameworkTransport, priorFront: priorFront,
            focusDispatched: focusPreparation.dispatchStarted
        ) else {
            throw NSError(domain: "MachineBridgeBackgroundInput", code: 7)
        }
        try sendMouseEvent(.mouseMoved, symbols: symbols, source: source, pid: pid, windowId: windowId,
                           screenX: screenX, screenY: screenY, localX: localX, localY: localY,
                           clickState: 0, phase: 2, clickGroup: clickGroup, transport: transport, subtype: 0)
        pointerDispatchStarted = true
        usleep(12_000)
        guard inputBoundaryStillValid(
            pid: pid, application: targetApplication, windowId: windowId, expected: expectedBounds,
            frameworkTransport: frameworkTransport, priorFront: priorFront,
            focusDispatched: focusPreparation.dispatchStarted
        ) else {
            throw NSError(domain: "MachineBridgeBackgroundInput", code: 8)
        }
        try sendScrollEvent(symbols: symbols, source: source, pid: pid, windowId: windowId,
                            screenX: screenX, screenY: screenY, localX: localX, localY: localY,
                            deltaX: wheelX, deltaY: wheelY, transport: transport)
        pointerDispatchStarted = true
    } catch {
        let dispatchStarted = focusPreparation.dispatchStarted || pointerDispatchStarted
        let restored = restoreFrontmostIfNeeded(priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted)
        return Response(ok: false, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                        frontmost_restored: restored, front_window_validated: true, cursor_preserved: nil,
                        dispatch_started: dispatchStarted,
                        error: dispatchStarted ? "dispatch_outcome_unknown" : "input_unavailable_before_dispatch")
    }

    usleep(50_000)
    let restored = restoreFrontmostIfNeeded(priorFront: priorFront, targetApplication: targetApplication, focusDispatched: focusPreparation.dispatchStarted)
    let cursorAfter = cursorLocation()
    let cursorPreserved: Bool? = {
        guard let cursorBefore, let cursorAfter else { return nil }
        return hypot(cursorBefore.x - cursorAfter.x, cursorBefore.y - cursorAfter.y) <= 0.5
    }()
    return Response(ok: true, backend: "skylight-experimental", focus_without_raise: focusPreparation.dispatchStarted,
                    frontmost_restored: restored, front_window_validated: true, cursor_preserved: cursorPreserved,
                    dispatch_started: true, error: nil, input_transport: transport.label)
}

guard let line = readLine(), let data = line.data(using: .utf8), let request = try? JSONDecoder().decode(Request.self, from: data) else {
    encode(Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
                    frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
                    dispatch_started: false, error: "invalid_json_before_dispatch"))
    exit(2)
}

switch request.operation {
case "unicode_keystroke":
    let response = unicodeKeystroke(request)
    encode(response)
    exit(response.ok ? 0 : 4)
case "key_press":
    let response = specialKeyPress(request)
    encode(response)
    exit(response.ok ? 0 : 4)
case "probe", "click", "drag", "scroll":
    guard let symbols = SkyLightSymbols() else {
        encode(Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
                        frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
                        dispatch_started: false, error: "private_symbols_unavailable_before_dispatch"))
        exit(3)
    }
    switch request.operation {
    case "probe":
        encode(Response(ok: true, backend: "skylight-experimental", focus_without_raise: nil,
                        frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
                        dispatch_started: false, error: nil))
    case "click":
        let response = click(request, symbols: symbols)
        encode(response)
        exit(response.ok ? 0 : 4)
    case "drag":
        let response = drag(request, symbols: symbols)
        encode(response)
        exit(response.ok ? 0 : 4)
    case "scroll":
        let response = scroll(request, symbols: symbols)
        encode(response)
        exit(response.ok ? 0 : 4)
    default:
        encode(Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
                        frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
                        dispatch_started: false, error: "unsupported_operation_before_dispatch"))
        exit(2)
    }
default:
    encode(Response(ok: false, backend: "skylight-experimental", focus_without_raise: nil,
                    frontmost_restored: nil, front_window_validated: nil, cursor_preserved: nil,
                    dispatch_started: false, error: "unsupported_operation_before_dispatch"))
    exit(2)
}
