import AppKit
import CoreGraphics
import Foundation

private final class SmokeWindow: NSWindow {
    let hitURL: URL
    private var keyboardDownCount = 0
    private var keyboardChunks: [String] = []

    init(contentRect: NSRect, hitURL: URL) {
        self.hitURL = hitURL
        super.init(contentRect: contentRect, styleMask: [.titled, .closable], backing: .buffered, defer: false)
    }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown {
            keyboardDownCount += 1
            keyboardChunks.append(event.characters ?? "")
            let payload: [String: Any] = [
                "type": "keyDown",
                "handledBy": "SmokeWindow",
                "windowNumber": event.windowNumber,
                "keyboardDownCount": keyboardDownCount,
                "keyboardChunks": keyboardChunks,
                "keyboardText": keyboardChunks.joined(),
                "keyboardKeyCode": Int(event.keyCode),
                "keyboardModifierFlags": event.modifierFlags.rawValue,
            ]
            if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
                try? data.write(to: hitURL, options: [.atomic])
            }
        }
        if event.type == .leftMouseDown {
            let point = event.locationInWindow
            let hitView = contentView?.hitTest(point)
            let payload: [String: Any] = [
                "type": "mouseDown",
                "handledBy": "SmokeWindow",
                "windowNumber": event.windowNumber,
                "x": point.x,
                "y": point.y,
                "hitView": hitView.map { String(describing: type(of: $0)) } ?? "",
                "timestamp": event.timestamp,
            ]
            if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
                try? data.write(to: hitURL, options: [.atomic])
            }
        }
        super.sendEvent(event)
    }
}

private var targetDownCount = 0
private var targetClickCounts: [Int] = []

private final class TargetView: NSView {
    let hitURL: URL
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    init(frame: NSRect, hitURL: URL) {
        self.hitURL = hitURL
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    }

    required init?(coder: NSCoder) { nil }

    override func mouseDown(with event: NSEvent) {
        targetDownCount += 1
        targetClickCounts.append(event.clickCount)
        let point = event.locationInWindow
        let payload: [String: Any] = [
            "type": "mouseDown",
            "handledBy": "TargetView",
            "windowNumber": event.windowNumber,
            "x": point.x,
            "y": point.y,
            "timestamp": event.timestamp,
            "downCount": targetDownCount,
            "clickCounts": targetClickCounts,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
            try? data.write(to: hitURL, options: [.atomic])
        }
    }
}

private final class DragProbeView: NSView {
    let evidenceURL: URL
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    private var downCount = 0
    private var draggedCount = 0
    private var upCount = 0
    private var lastPoint = NSPoint.zero

    init(frame: NSRect, evidenceURL: URL) {
        self.evidenceURL = evidenceURL
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
    }

    required init?(coder: NSCoder) { nil }

    override func mouseDown(with event: NSEvent) {
        downCount += 1
        lastPoint = event.locationInWindow
        writeEvidence(lastType: "mouseDown", windowNumber: event.windowNumber)
    }

    override func mouseDragged(with event: NSEvent) {
        draggedCount += 1
        lastPoint = event.locationInWindow
        writeEvidence(lastType: "mouseDragged", windowNumber: event.windowNumber)
    }

    override func mouseUp(with event: NSEvent) {
        upCount += 1
        lastPoint = event.locationInWindow
        writeEvidence(lastType: "mouseUp", windowNumber: event.windowNumber)
    }

    private func writeEvidence(lastType: String, windowNumber: Int) {
        let payload: [String: Any] = [
            "lastType": lastType,
            "windowNumber": windowNumber,
            "downCount": downCount,
            "draggedCount": draggedCount,
            "upCount": upCount,
            "x": lastPoint.x,
            "y": lastPoint.y,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
            try? data.write(to: evidenceURL, options: [.atomic])
        }
    }
}

private final class FlippedDocumentView: NSView {
    override var isFlipped: Bool { true }
}

private final class ScrollProbeView: NSScrollView {
    let evidenceURL: URL
    private var eventCount = 0

    init(frame: NSRect, evidenceURL: URL) {
        self.evidenceURL = evidenceURL
        super.init(frame: frame)
    }

    required init?(coder: NSCoder) { nil }

    override func scrollWheel(with event: NSEvent) {
        let before = contentView.bounds.origin.y
        let point = event.locationInWindow
        let deltaX = event.scrollingDeltaX
        let deltaY = event.scrollingDeltaY
        let precise = event.hasPreciseScrollingDeltas
        let windowNumber = event.windowNumber
        eventCount += 1
        super.scrollWheel(with: event)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
            guard let self else { return }
            let payload: [String: Any] = [
                "eventCount": self.eventCount,
                "windowNumber": windowNumber,
                "x": point.x,
                "y": point.y,
                "deltaX": deltaX,
                "deltaY": deltaY,
                "precise": precise,
                "beforeOffsetY": before,
                "afterOffsetY": self.contentView.bounds.origin.y,
            ]
            if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
                try? data.write(to: self.evidenceURL, options: [.atomic])
            }
        }
    }
}

private final class FixtureDelegate: NSObject, NSApplicationDelegate {
    let statusURL: URL
    let hitURL: URL
    let dragURL: URL
    let scrollURL: URL
    let activationURL: URL?
    var activationCount = 0
    var window: NSWindow?

    init(statusURL: URL, hitURL: URL, dragURL: URL, scrollURL: URL, activationURL: URL?) {
        self.statusURL = statusURL
        self.hitURL = hitURL
        self.dragURL = dragURL
        self.scrollURL = scrollURL
        self.activationURL = activationURL
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        activationCount += 1
        guard let activationURL else { return }
        let payload: [String: Any] = ["activationCount": activationCount, "pid": ProcessInfo.processInfo.processIdentifier]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
            try? data.write(to: activationURL, options: [.atomic])
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 80, y: 80, width: 360, height: 230)
        let window = SmokeWindow(contentRect: frame, hitURL: hitURL)
        window.title = "MBM Computer Use Fixture"
        window.isReleasedWhenClosed = false
        let content = TargetView(frame: NSRect(origin: .zero, size: frame.size), hitURL: hitURL)
        let button = NSButton(checkboxWithTitle: "AX Guard", target: nil, action: nil)
        button.frame = NSRect(x: 20, y: 20, width: 100, height: 32)
        button.identifier = NSUserInterfaceItemIdentifier("mbm-smoke-button")
        button.state = .off
        content.addSubview(button)
        let textField = NSTextField(string: "before")
        textField.frame = NSRect(x: 150, y: 20, width: 170, height: 24)
        textField.identifier = NSUserInterfaceItemIdentifier("mbm-smoke-text")
        content.addSubview(textField)
        let dragProbe = DragProbeView(frame: NSRect(x: 20, y: 82, width: 145, height: 96), evidenceURL: dragURL)
        content.addSubview(dragProbe)
        let scrollProbe = ScrollProbeView(frame: NSRect(x: 215, y: 68, width: 125, height: 122), evidenceURL: scrollURL)
        scrollProbe.hasVerticalScroller = true
        scrollProbe.scrollerStyle = .legacy
        scrollProbe.autohidesScrollers = false
        scrollProbe.verticalScrollElasticity = .none
        scrollProbe.horizontalScrollElasticity = .none
        let document = FlippedDocumentView(frame: NSRect(x: 0, y: 0, width: 105, height: 1200))
        for index in 0..<18 {
            let label = NSTextField(labelWithString: "row-\(index)")
            label.frame = NSRect(x: 8, y: CGFloat(index * 64 + 8), width: 82, height: 20)
            document.addSubview(label)
        }
        scrollProbe.documentView = document
        scrollProbe.contentView.scroll(to: .zero)
        content.addSubview(scrollProbe)
        window.contentView = content
        window.orderFrontRegardless()
        self.window = window

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            let windowID = CGWindowID(window.windowNumber)
            guard let raw = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID),
                  let windows = raw as? [[String: Any]],
                  let info = windows.first,
                  let boundsObject = info[kCGWindowBounds as String] as? NSDictionary,
                  let windowBounds = CGRect(dictionaryRepresentation: boundsObject) else { return }
            func normalizedPoint(_ point: NSPoint) -> [String: Double] {
                [
                    "x": Double(point.x / windowBounds.width),
                    "y": Double(1 - point.y / windowBounds.height),
                ]
            }
            let dragSource = dragProbe.convert(NSPoint(x: 22, y: dragProbe.bounds.midY), to: nil)
            let dragDestination = dragProbe.convert(NSPoint(x: dragProbe.bounds.width - 22, y: dragProbe.bounds.midY), to: nil)
            let scrollAnchor = scrollProbe.convert(NSPoint(x: scrollProbe.bounds.midX, y: scrollProbe.bounds.midY), to: nil)
            let clickProbe = content.convert(NSPoint(x: 180, y: 208), to: nil)
            let payload: [String: Any] = [
                "pid": ProcessInfo.processInfo.processIdentifier,
                "windowNumber": window.windowNumber,
                "clickProbe": normalizedPoint(clickProbe),
                "dragSource": normalizedPoint(dragSource),
                "dragDestination": normalizedPoint(dragDestination),
                "scrollAnchor": normalizedPoint(scrollAnchor),
                "scrollInitialOffsetY": scrollProbe.contentView.bounds.origin.y,
            ]
            if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
                try? data.write(to: self.statusURL, options: [.atomic])
            }
        }
    }
}

guard CommandLine.arguments.count == 5 || CommandLine.arguments.count == 6 else {
    fputs("usage: fixture <status-json> <hit-json> <drag-json> <scroll-json> [activation-json]\n", stderr)
    exit(64)
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
private let delegate = FixtureDelegate(
    statusURL: URL(fileURLWithPath: CommandLine.arguments[1]),
    hitURL: URL(fileURLWithPath: CommandLine.arguments[2]),
    dragURL: URL(fileURLWithPath: CommandLine.arguments[3]),
    scrollURL: URL(fileURLWithPath: CommandLine.arguments[4]),
    activationURL: CommandLine.arguments.count == 6 ? URL(fileURLWithPath: CommandLine.arguments[5]) : nil
)
application.delegate = delegate
application.run()
