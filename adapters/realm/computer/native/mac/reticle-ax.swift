// reticle-ax: reads and drives one macOS application through the Accessibility API.
//
//   reticle-ax tree <pid>
//   reticle-ax reach <pid> <path> <role> <name>
//   reticle-ax act  <pid> <path> <role> <name> press|set|type|key|window [value] [budgetMs] [user-path|direct][:quietMs] [folder...]
//
// <path> is the child index at each level from the application element, joined by ".", "" for the
// application. <role> and <name> are what the caller last read there. If the element at <path> is
// now a different one, the helper refuses: it never acts on an element the caller did not choose.
//
// By default the helper acts only on an element a person could click (`user-path`). `direct` acts on
// an element under another view or window too, and the result says a person could not reach it.
//
// Each <folder> is watched while the helper waits: a file written there is an effect too, so the
// wait ends when the files and the tree are quiet, not only when the tree changed.
//
// Output is one JSON object on stdout. The helper decides nothing. It reports what it read.
//
//   reticle-ax web-tree <pid> on|off   (Electron: its accessibility switch)
//   reticle-ax web-tree <pid> try      (any other app: the screen reader's switch, kept if it adds)
//   reticle-ax capture <pid> <file.png> [screen]   (a picture of the application's window, or of
//                                                  the whole display that holds it)
//   reticle-ax apps                    (the applications that are open: name, process, pid)
//   reticle-ax serve      (one command for each line on standard input, as a JSON list of words)
import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit
import Security
import Vision

let attributes =
  [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
    kAXValueAttribute, kAXEnabledAttribute, kAXFocusedAttribute, kAXPositionAttribute,
    kAXSizeAttribute, kAXChildrenAttribute, kAXIdentifierAttribute, kAXSelectedAttribute,
    // The `id` of an element in a web view. A web view does not give it as the identifier.
    "AXDOMIdentifier",
    // The words a person gets when the pointer rests on the element.
    kAXHelpAttribute,
  ] as CFArray

func values(_ element: AXUIElement) -> [AnyObject]? {
  var out: CFArray?
  guard AXUIElementCopyMultipleAttributeValues(element, attributes, [], &out) == .success else {
    return nil
  }
  return out as? [AnyObject]
}

func text(_ value: AnyObject) -> String? {
  if let s = value as? String { return s }
  if let n = value as? NSNumber, CFGetTypeID(n) != AXValueGetTypeID() { return n.stringValue }
  return nil
}

func frame(_ position: AnyObject, _ size: AnyObject) -> CGRect? {
  guard CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else {
    return nil
  }
  var p = CGPoint.zero
  var s = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &p),
    AXValueGetValue(size as! AXValue, .cgSize, &s)
  else { return nil }
  // Numbers gives an infinite size for an element of its sheet. JSON has no infinity, and the
  // helper ended with an exception when it wrote the tree.
  guard [p.x, p.y, s.width, s.height].allSatisfy({ $0.isFinite }) else { return nil }
  return CGRect(origin: p, size: s)
}

/// The element as a dictionary. `unread` counts elements the API refused to describe, so a reader
/// can tell a small tree from a tree with holes in it.
func readElement(_ element: AXUIElement, _ depth: Int, _ unread: inout Int) -> [String: Any] {
  guard let v = values(element) else {
    unread += 1
    return ["role": "", "children": [Any]()]
  }
  var node: [String: Any] = ["role": text(v[0]) ?? ""]
  if let s = text(v[1]) { node["subrole"] = s }
  if let s = text(v[2]), !s.isEmpty { node["title"] = s }
  if let s = text(v[3]), !s.isEmpty { node["description"] = s }
  if let s = text(v[4]) { node["value"] = s }
  if let b = v[5] as? Bool { node["enabled"] = b }
  if let b = v[6] as? Bool { node["focused"] = b }
  if let r = frame(v[7], v[8]) {
    node["frame"] = [r.origin.x, r.origin.y, r.size.width, r.size.height]
  }
  if let s = text(v[10]), !s.isEmpty {
    node["id"] = s
  } else if v.count > 12, let s = text(v[12]), !s.isEmpty {
    node["id"] = s
  }
  if let b = v[11] as? Bool, b { node["selected"] = true }
  if v.count > 13, let s = text(v[13]), !s.isEmpty { node["help"] = s }
  var children = depth < 80 ? (v[9] as? [AXUIElement]) ?? [] : []
  // A table gives every row it has, and makes each one when it is asked. A table of 5,000 rows
  // did not answer in four minutes. A person sees the rows that are on the screen, so those are
  // the rows that are read. Each keeps its place in the whole list as "i", and "notShown" says how
  // many rows were left out.
  var places: [Int]?
  let role = text(v[0]) ?? ""
  // The menu bar of an application that is not in front is not on the screen: a person cannot
  // see it or press it, and a press on it is refused. It is given no size and its menus are not
  // read. They are most of the elements of an application, and each one costs a call.
  // The items at the right of the menu bar (Control Centre, Wi-Fi, Focus) are on the screen when
  // their application is not in front. Control Centre gave them as its menu bar, and they were
  // dropped, so its toggles (Stage Manager among them) could not be pressed.
  if role == "AXMenuBar" && !menuBarOnScreen && !isMenuExtras(children) {
    children = []
    if let r = frame(v[7], v[8]) { node["frame"] = [r.origin.x, r.origin.y, 0, 0] }
  }
  // A column of Finder's column view is a scroll area with no children: its list is given only as
  // its contents. Every file of the column was missing, so no file could be opened from there.
  if role == "AXScrollArea" && children.isEmpty && depth < 80 {
    var contents: AnyObject?
    if AXUIElementCopyAttributeValue(element, "AXContents" as CFString, &contents) == .success {
      children = (contents as? [AXUIElement]) ?? []
    }
  }
  // A list (that column, with a thousand files) gives the items on the screen as a table does.
  let isList = role == "AXList"
  if role == "AXTable" || role == "AXOutline" || isList {
    var visible: AnyObject?
    let shown = isList ? kAXVisibleChildrenAttribute : kAXVisibleRowsAttribute
    if AXUIElementCopyAttributeValue(element, shown as CFString, &visible)
      == .success, let rows = visible as? [AXUIElement]
    {
      let all = children
      let found = rows.compactMap { row in all.firstIndex { CFEqual($0, row) } }
      // Chromium gives an ARIA tree (Discord's servers) as an outline whose visible rows are an
      // empty list, and its items are not rows at all. That read as "no row is on the screen", and
      // every server was dropped. Visible rows that name none of the children of a short one are
      // not believed.
      // A long one is believed: a column of Finder whose window is not on the screen gives no
      // visible item, and its 48,336 items were read one by one for half an hour, which hung
      // Finder. A short one is read whole: Finder gives no visible item for the column of a
      // window it has just opened, and what is out of the window is left out by its place.
      let believed = all.count > shortList
      if found.isEmpty && !all.isEmpty && !believed { return finish(node, all, nil) }
      places = found
      children = found.map { all[$0] }
      // The rows that are not on the screen. The columns are left out too, and they are not
      // counted: they hold the same cells a second time, so nothing in them is hidden.
      var every: AnyObject?
      var total = all.count
      if !isList {
        total =
          AXUIElementCopyAttributeValue(element, kAXRowsAttribute as CFString, &every) == .success
          ? (every as? [AXUIElement])?.count ?? children.count : children.count
      }
      node["notShown"] = max(0, total - children.count)
    }
  }
  return finish(node, children, places)

  /// The node with its children read: each keeps its place in the whole list when only some were.
  func finish(_ node: [String: Any], _ children: [AXUIElement], _ places: [Int]?) -> [String: Any] {
    var node = node
    var kids: [[String: Any]] = []
    // The read has a budget: past it, what an element holds is not read, and is counted as not
    // shown on that element, so the loss is said where it is.
    if readBudget <= 0 && !children.isEmpty {
      node["notShown"] = ((node["notShown"] as? Int) ?? 0) + children.count
      node["children"] = kids
      return node
    }
    readBudget -= children.count
    for (order, child) in children.enumerated() {
      var one = readElement(child, depth + 1, &unread)
      if let places { one["i"] = places[order] }
      kids.append(one)
    }
    node["children"] = kids
    return node
  }
}

/// True when the menu bar on the screen is the one of this application: the application is the
/// one in front. Two sources, and either one is enough.
///
/// The workspace names the application in front. It learns of a change from the run loop, so the
/// loop is run once first. The window server names the owner of the topmost ordinary window, and
/// it is never old. The window alone was not enough: an application whose top window is an alert
/// or a panel has it on another layer, and its menu bar was then not read.
/// An old "in front" costs only time: the menu bar is read, and a press on it is refused.
func isInFront(_ pid: pid_t) -> Bool {
  RunLoop.current.run(until: Date())
  if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return true }
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
  let top = list.first { ($0[kCGWindowLayer as String] as? Int) == 0 }
  return (top?[kCGWindowOwnerPID as String] as? pid_t) == pid
}

/// The menu bar of the application being read is on the screen. Set for each read.
var menuBarOnScreen = true

/// A menu bar of items at the right of the screen, which are on the screen at all times.
func isMenuExtras(_ items: [AXUIElement]) -> Bool {
  guard let first = items.first else { return false }
  var subrole: AnyObject?
  AXUIElementCopyAttributeValue(first, kAXSubroleAttribute as CFString, &subrole)
  return (subrole as? String) == "AXMenuExtra"
}

/// The most elements one read takes. An application answers an element in about a millisecond, and
/// Finder in up to twenty: a read with no end ran for half an hour on a folder of 48,336 files.
let readLimit = 20_000
/// A list this long or shorter is read whole when it names no visible item.
let shortList = 200
/// What is left of the budget of the read that runs now.
var readBudget = readLimit

/// The largest visible window of the application on screen: its number and its rect in points.
func mainWindow(_ pid: pid_t) -> (id: Int, rect: CGRect)? {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
  var best: (id: Int, rect: CGRect)?
  for window in list where (window[kCGWindowOwnerPID as String] as? pid_t) == pid {
    guard let bounds = window[kCGWindowBounds as String] as? NSDictionary,
      let rect = CGRect(dictionaryRepresentation: bounds),
      let id = window[kCGWindowNumber as String] as? Int,
      (window[kCGWindowAlpha as String] as? Double ?? 1) > 0, rect.width > 40, rect.height > 40
    else { continue }
    if let b = best, b.rect.width * b.rect.height >= rect.width * rect.height { continue }
    best = (id, rect)
  }
  return best
}

/// A picture of one window, made small: `pictureWidth` pixels wide, 4 bytes for each pixel.
/// A canvas (a photo, a video frame, a drawing) has no elements, so its pixels are its effect.
let pictureWidth = 240
/// Waits for async work on a thread that has nothing else to do. The helper answers one command
/// at a time, so a blocked thread costs nothing.
func waitFor<T>(_ work: @escaping () async -> T?) -> T? {
  let done = DispatchSemaphore(value: 0)
  var out: T?
  Task {
    out = await work()
    done.signal()
  }
  done.wait()
  return out
}
/// The filter of the last window drawn, kept: to find a window again costs more than the picture.
var pictureFilter: (id: Int, filter: Any)?
/// A small picture of a window, drawn by the window server in this process: about 35 ms, where a
/// run of `screencapture` and a PNG to decode took 90 ms or more.
func windowImage(_ id: Int) -> CGImage? {
  if #available(macOS 14.0, *) {
    var filter = pictureFilter?.id == id ? pictureFilter?.filter as? SCContentFilter : nil
    if filter == nil {
      filter = waitFor {
        let content = try? await SCShareableContent.excludingDesktopWindows(
          false, onScreenWindowsOnly: true)
        return content?.windows.first { $0.windowID == CGWindowID(id) }
          .map { SCContentFilter(desktopIndependentWindow: $0) }
      }
      if let filter { pictureFilter = (id, filter) }
    }
    if let filter {
      let config = SCStreamConfiguration()
      config.width = pictureWidth
      config.height = max(1, Int(Double(pictureWidth) * Double(filter.contentRect.height)
        / Double(max(filter.contentRect.width, 1))))
      config.showsCursor = false
      if let image = waitFor({
        try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
      }) {
        return image
      }
    }
  }
  let path = NSTemporaryDirectory() + "reticle-pixels-\(getpid())-\(id).png"
  defer { try? FileManager.default.removeItem(atPath: path) }
  let shot = Process()
  shot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  shot.arguments = ["-x", "-o", "-l", String(id), "-t", "png", path]
  try? shot.run()
  shot.waitUntilExit()
  guard shot.terminationStatus == 0 else { return nil }
  return NSImage(contentsOfFile: path)?.cgImage(forProposedRect: nil, context: nil, hints: nil)
}
func windowPixels(_ id: Int) -> (bytes: [UInt8], width: Int, height: Int)? {
  guard let image = windowImage(id), image.width > 0 else { return nil }
  let width = min(pictureWidth, image.width)
  let height = max(1, image.height * width / image.width)
  var bytes = [UInt8](repeating: 0, count: width * height * 4)
  let drawn = bytes.withUnsafeMutableBytes { raw -> Bool in
    guard
      let context = CGContext(
        data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return false }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return true
  }
  return drawn ? (bytes, width, height) : nil
}

/// What part of the window changed between two pictures, and the box around the change in screen
/// points. A pixel counts when one channel moved more than `pixelStep`: less is the noise of the
/// scaling and of a blinking caret's edge.
let pixelStep = 24
typealias Pixels = (bytes: [UInt8], width: Int, height: Int)

/// The pixels that differ between two pictures of the same size.
func pixelsMoved(_ a: Pixels, _ b: Pixels) -> [Bool] {
  guard a.width == b.width, a.height == b.height else { return [] }
  var moved = [Bool](repeating: false, count: a.width * a.height)
  for p in 0..<moved.count {
    for c in 0..<3 {
      let i = p * 4 + c
      if abs(Int(a.bytes[i]) - Int(b.bytes[i])) > pixelStep { moved[p] = true }
    }
  }
  return moved
}

/// The pixels that moved by themselves, made a little wider: a video, a spinner or a caret moves
/// between two pictures with no action, and its edge moves a pixel more in the next frame.
func movingMask(_ pairs: [(Pixels, Pixels)], width: Int, height: Int) -> [Bool] {
  var mask = [Bool](repeating: false, count: width * height)
  for (a, b) in pairs {
    let moved = pixelsMoved(a, b)
    guard moved.count == mask.count else { continue }
    for y in 0..<height {
      for x in 0..<width where moved[y * width + x] {
        for yy in max(0, y - 2)...min(height - 1, y + 2) {
          for xx in max(0, x - 2)...min(width - 1, x + 2) { mask[yy * width + xx] = true }
        }
      }
    }
  }
  return mask
}

/// What part of the window changed, leaving out the pixels in `moving`, which change by
/// themselves. `moving` in the answer is the part of the window that moved with no action: a
/// change there cannot be told from the action's effect, so it is not counted as one.
func pixelChange(_ a: Pixels, _ b: Pixels, window: CGRect, moving: [Bool] = []) -> [String: Any]? {
  guard a.width == b.width, a.height == b.height else {
    // The window changed its size: all of it is new.
    return ["changed": 1.0, "box": [window.origin.x, window.origin.y, window.width, window.height]]
  }
  let moved = pixelsMoved(a, b)
  let still = moving.count == moved.count ? moving : [Bool](repeating: false, count: moved.count)
  let movingPart = Double(still.filter { $0 }.count) / Double(max(1, still.count))
  let rounded = { (n: Double) in (n * 10_000).rounded() / 10_000 }
  var count = 0
  var minX = a.width, minY = a.height, maxX = -1, maxY = -1
  for y in 0..<a.height {
    for x in 0..<a.width {
      let p = y * a.width + x
      guard moved[p], !still[p] else { continue }
      count += 1
      minX = min(minX, x)
      maxX = max(maxX, x)
      minY = min(minY, y)
      maxY = max(maxY, y)
    }
  }
  let extra: [String: Any] = movingPart > 0 ? ["moving": rounded(movingPart)] : [:]
  guard count > 0 else { return ["changed": 0.0].merging(extra) { $1 } }
  // The first row in the memory of a bitmap context is the top of the picture.
  let sx = window.width / Double(a.width)
  let sy = window.height / Double(a.height)
  let top = minY
  return extra.merging([
    "changed": rounded(Double(count) / Double(a.width * a.height)),
    "box": [
      (window.origin.x + Double(minX) * sx).rounded(), (window.origin.y + Double(top) * sy).rounded(),
      (Double(maxX - minX + 1) * sx).rounded(), (Double(maxY - minY + 1) * sy).rounded(),
    ],
  ]) { $1 }
}

/// A container by its role and its frame: the switch adds elements before it, so a path of child
/// indexes names another element after it.
func containerKey(_ node: [String: Any]) -> String? {
  guard let role = node["role"] as? String, ["AXScrollArea", "AXGroup", "AXSplitGroup"].contains(role),
    let frame = node["frame"] as? [Double], frame.count == 4, frame[2] > 0, frame[3] > 0
  else { return nil }
  return "\(role)@\(frame.map { Int($0.rounded()) })"
}

func hasContent(_ node: [String: Any]) -> Bool {
  (node["children"] as? [[String: Any]] ?? []).contains { ($0["role"] as? String) != "AXScrollBar" }
}

/// The containers that hold nothing but scroll bars.
func emptyContainers(_ node: [String: Any]) -> Set<String> {
  var found: Set<String> = []
  if !hasContent(node), let key = containerKey(node) { found.insert(key) }
  for child in node["children"] as? [[String: Any]] ?? [] { found.formUnion(emptyContainers(child)) }
  return found
}

/// Which of the containers in `places` now hold content other than scroll bars.
func filledContainers(_ node: [String: Any], among places: Set<String>) -> Set<String> {
  var filled: Set<String> = []
  if hasContent(node), let key = containerKey(node), places.contains(key) { filled.insert(key) }
  for child in node["children"] as? [[String: Any]] ?? [] {
    filled.formUnion(filledContainers(child, among: places))
  }
  return filled
}

func snapshot(_ app: AXUIElement) -> (tree: [String: Any], unread: Int, json: Data) {
  readBudget = readLimit
  var unread = 0
  var pid: pid_t = 0
  AXUIElementGetPid(app, &pid)
  menuBarOnScreen = isInFront(pid)
  var tree = readElement(app, 0, &unread)
  // An application that is busy can refuse its first read. Ask once more before the caller gets
  // a tree with nothing in it. A second refusal is reported as it is, in `unread`.
  if (tree["role"] as? String) == "" {
    unread = 0
    tree = readElement(app, 0, &unread)
  }
  let json = (try? JSONSerialization.data(withJSONObject: tree, options: [.sortedKeys])) ?? Data()
  return (tree, unread, json)
}

/// The answer to one command. A command ends when it throws its answer, at any depth.
struct Answer: Error {
  let body: [String: Any]
}

func emit(_ object: [String: Any]) throws -> Never {
  throw Answer(body: object)
}

func child(_ element: AXUIElement, _ index: Int) -> AXUIElement? {
  var value: AnyObject?
  var children: [AXUIElement] = []
  if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success {
    children = (value as? [AXUIElement]) ?? []
  }
  // As the read does: a column of Finder gives its list only as its contents. The way to a file
  // went through its children, found none, and every click on a file there was "stale".
  if children.isEmpty,
    AXUIElementCopyAttributeValue(element, "AXContents" as CFString, &value) == .success
  {
    children = (value as? [AXUIElement]) ?? []
  }
  guard index >= 0, index < children.count else { return nil }
  return children[index]
}

/// The visible part of the screen that holds most of `window`, in the top-left points of the
/// Accessibility API: the screen without the menu bar and the Dock.
func visibleArea(of window: AXUIElement) -> CGRect? {
  var position: AnyObject?
  var size: AnyObject?
  AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position)
  AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size)
  guard let main = NSScreen.screens.first else { return nil }
  let top = main.frame.height
  let middle = position.flatMap { p in size.flatMap { frame(p, $0) } }.map {
    CGPoint(x: $0.midX, y: top - $0.midY)
  }
  let screen =
    middle.flatMap { m in NSScreen.screens.first { $0.frame.contains(m) } } ?? NSScreen.main ?? main
  let visible = screen.visibleFrame
  return CGRect(x: visible.minX, y: top - visible.maxY, width: visible.width, height: visible.height)
}

/// What a person sees of `window`: its frame, and whether it is minimized or in full screen. A
/// minimized window keeps its frame in the Accessibility API, so the frame alone does not say it.
func windowState(_ window: AXUIElement, wanted: CGRect?) -> [String: Any] {
  var position: AnyObject?
  var size: AnyObject?
  var minimized: AnyObject?
  var full: AnyObject?
  AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position)
  AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size)
  AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &minimized)
  AXUIElementCopyAttributeValue(window, "AXFullScreen" as CFString, &full)
  var state: [String: Any] = [
    "minimized": (minimized as? Bool) ?? false, "fullscreen": (full as? Bool) ?? false,
  ]
  if let p = position, let s = size, let rect = frame(p, s) {
    state["frame"] = [rect.minX, rect.minY, rect.width, rect.height]
  }
  if let w = wanted { state["wanted"] = [w.minX, w.minY, w.width, w.height] }
  return state
}

/// Gives `window` an arrangement: minimize, zoom, fullscreen, restore, left, right, or
/// "frame:x,y,width,height". The position is set again after the size: a window that grows
/// against the edge of the screen is moved by the system. Absent answer: no such arrangement.
func arrange(_ window: AXUIElement, _ how: String) -> (AXError, CGRect?)? {
  func set(_ attribute: String, _ value: CFTypeRef) -> AXError {
    AXUIElementSetAttributeValue(window, attribute as CFString, value)
  }
  func place(_ rect: CGRect) -> AXError {
    var origin = rect.origin
    var size = rect.size
    guard let p = AXValueCreate(.cgPoint, &origin), let s = AXValueCreate(.cgSize, &size) else {
      return .failure
    }
    _ = set(kAXPositionAttribute, p)
    let sized = set(kAXSizeAttribute, s)
    _ = set(kAXPositionAttribute, p)
    return sized
  }
  let area = visibleArea(of: window)
  switch how {
  case "minimize": return (set(kAXMinimizedAttribute, kCFBooleanTrue), nil)
  case "fullscreen": return (set("AXFullScreen", kCFBooleanTrue), nil)
  case "restore":
    _ = set("AXFullScreen", kCFBooleanFalse)
    return (set(kAXMinimizedAttribute, kCFBooleanFalse), nil)
  case "zoom":
    guard let a = area else { return (.failure, nil) }
    return (place(a), a)
  case "left", "right":
    guard let a = area else { return (.failure, nil) }
    let half = a.width / 2
    let rect = CGRect(x: how == "left" ? a.minX : a.minX + half, y: a.minY, width: half, height: a.height)
    return (place(rect), rect)
  default:
    let numbers = how.hasPrefix("frame:")
      ? how.dropFirst(6).split(separator: ",").compactMap { Double($0) } : []
    guard numbers.count == 4 else { return nil }
    let rect = CGRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3])
    return (place(rect), rect)
  }
}

/// The name of the HUD program of the realm. Its windows take no click: the pointer and the glow
/// let every click through to what is under them.
let hudProgram = "reticle-hud"

/// The application that owns the frontmost window at a point, from the window server's own list.
/// It needs no answer from any application. The windows of the HUD are not counted: the pointer
/// rests on the last target, and it was named as the window over the next one.
func windowOwner(at point: CGPoint) -> (pid: pid_t, name: String, layer: Int)? {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    return nil
  }
  for window in list {
    guard let bounds = window[kCGWindowBounds as String] as? NSDictionary,
      let rect = CGRect(dictionaryRepresentation: bounds), rect.contains(point),
      (window[kCGWindowAlpha as String] as? Double ?? 1) > 0,
      window[kCGWindowOwnerName as String] as? String != hudProgram,
      let pid = window[kCGWindowOwnerPID as String] as? pid_t
    else { continue }
    return (
      pid, window[kCGWindowOwnerName as String] as? String ?? "",
      window[kCGWindowLayer as String] as? Int ?? 0
    )
  }
  return nil
}

/// The windows of an application that the window server has and that are not on the screen now:
/// on another Space, or made small in the Dock. The Accessibility API does not list them, so an
/// application with all its windows there reads as an application with none.
func windowsNotOnScreen(_ pid: pid_t) -> Int {
  func count(_ options: CGWindowListOption) -> Int {
    let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    return list.filter {
      ($0[kCGWindowOwnerPID as String] as? pid_t) == pid
        && ($0[kCGWindowLayer as String] as? Int) == 0
        && (($0[kCGWindowBounds as String] as? [String: Any])?["Height"] as? Double ?? 0) > 60
    }.count
  }
  return max(
    0, count([.optionAll, .excludeDesktopElements])
      - count([.optionOnScreenOnly, .excludeDesktopElements]))
}

enum Reach {
  case yes
  /// Another element is on top at that point. `by` says which.
  case no(by: String)
  /// The operating system did not answer. Nothing is known about the element.
  case unknown(code: Int)
}

/// Whether `hit`, the answer of a hit test at the middle of `target`, is an empty layer that a
/// click goes through. Chromium answers a hit test with an empty group over the whole window that
/// has `pointer-events: none`, as the layer that Discord keeps for its popups, and the realm then
/// refused every button of Discord. The backdrop of an open dialog is an empty group too, and a
/// click on it does not go through (it closes the dialog). So the layer passes only when no open
/// dialog near it is without the target.
func passesThrough(_ hit: AXUIElement, to target: AXUIElement) -> Bool {
  var hitPid: pid_t = 0
  var targetPid: pid_t = 0
  AXUIElementGetPid(hit, &hitPid)
  AXUIElementGetPid(target, &targetPid)
  var count: CFIndex = 0
  AXUIElementGetAttributeValueCount(hit, kAXChildrenAttribute as CFString, &count)
  guard hitPid == targetPid, count == 0, let v = values(hit), text(v[0]) == "AXGroup",
    (text(v[2]) ?? "").isEmpty, (text(v[3]) ?? "").isEmpty
  else { return false }
  func parent(_ e: AXUIElement) -> AXUIElement? {
    var up: AnyObject?
    guard AXUIElementCopyAttributeValue(e, kAXParentAttribute as CFString, &up) == .success,
      let found = up, CFGetTypeID(found) == AXUIElementGetTypeID()
    else { return nil }
    return (found as! AXUIElement)
  }
  func holdsTarget(_ dialog: AXUIElement) -> Bool {
    var at: AXUIElement? = target
    for _ in 0..<80 {
      guard let now = at else { return false }
      if CFEqual(now, dialog) { return true }
      at = parent(now)
    }
    return false
  }
  // A popup is drawn after its backdrop: a later sibling with content that does not hold the
  // target is in front of it, with a mark of a dialog or not. Discord's empty layer has no such
  // sibling.
  var siblings: AnyObject?
  if let up = parent(hit),
    AXUIElementCopyAttributeValue(up, kAXChildrenAttribute as CFString, &siblings) == .success,
    let all = siblings as? [AXUIElement],
    let index = all.firstIndex(where: { CFEqual($0, hit) })
  {
    for later in all[(index + 1)...] {
      var size: CFIndex = 0
      AXUIElementGetAttributeValueCount(later, kAXChildrenAttribute as CFString, &size)
      if size > 0 && !holdsTarget(later) { return false }
    }
  }
  // The dialogs near the layer: in the parent of the layer, a few levels down.
  var level = parent(hit).map { [$0] } ?? []
  for _ in 0..<4 {
    var next: [AXUIElement] = []
    for element in level {
      var role: AnyObject?
      var subrole: AnyObject?
      AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
      AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole)
      let isDialog =
        role as? String == "AXSheet" || subrole as? String == "AXApplicationDialog"
        || subrole as? String == "AXDialog"
      if isDialog && !holdsTarget(element) { return false }
      var kids: AnyObject?
      AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &kids)
      next += (kids as? [AXUIElement]) ?? []
    }
    level = next
  }
  return true
}

/// Whether a person who clicks the middle of `target` reaches `target`: the topmost element on the
/// screen at that point is the target or sits inside it.
///
/// A call that fails is not "covered". A busy machine fails this call now and then, so it is asked
/// three times, and a failure is reported as its own answer.
func reach(_ target: AXUIElement, _ rect: CGRect) -> Reach {
  let system = AXUIElementCreateSystemWide()
  var code = AXError.failure
  for attempt in 0..<3 {
    if attempt > 0 { Thread.sleep(forTimeInterval: 0.04) }
    var hit: AXUIElement?
    code = AXUIElementCopyElementAtPosition(system, Float(rect.midX), Float(rect.midY), &hit)
    guard code == .success, let top = hit else { continue }
    var at = top
    for _ in 0..<8 {
      if CFEqual(at, target) { return .yes }
      var parent: AnyObject?
      guard AXUIElementCopyAttributeValue(at, kAXParentAttribute as CFString, &parent) == .success,
        let up = parent, CFGetTypeID(up) == AXUIElementGetTypeID()
      else { break }
      at = up as! AXUIElement
    }
    // A text or a picture that takes no click is not the answer of a hit test: the system gives
    // the element that holds it. That is no cover. Only for those two roles, and only for an
    // element near above the target: a button that is not the answer has something on top of it.
    var targetRole: AnyObject?
    AXUIElementCopyAttributeValue(target, kAXRoleAttribute as CFString, &targetRole)
    if let role = targetRole as? String, role == "AXStaticText" || role == "AXImage" {
      var up = target
      for _ in 0..<3 {
        var parent: AnyObject?
        guard AXUIElementCopyAttributeValue(up, kAXParentAttribute as CFString, &parent) == .success,
          let above = parent, CFGetTypeID(above) == AXUIElementGetTypeID()
        else { break }
        up = above as! AXUIElement
        if CFEqual(up, top) { return .yes }
      }
    }
    if passesThrough(top, to: target) { return .yes }
    // The answer is the target's own window: no part of the window takes the hit at that point, so
    // no part covers the target. Dia's profile sidebar answers so, and its profile rows were
    // refused as "covered by the window". Another part of the window over the target is the answer
    // of the hit test, so that refusal stays.
    if let hitRole = values(top).flatMap({ text($0[0]) }), hitRole == "AXWindow" {
      var up = target
      for _ in 0..<80 {
        var parent: AnyObject?
        guard AXUIElementCopyAttributeValue(up, kAXParentAttribute as CFString, &parent) == .success,
          let above = parent, CFGetTypeID(above) == AXUIElementGetTypeID()
        else { break }
        up = above as! AXUIElement
        if CFEqual(up, top) { return .yes }
      }
    }
    let v = values(top)
    let role = v.flatMap { text($0[0]) } ?? "element"
    let name = v.flatMap { text($0[2]) ?? text($0[3]) } ?? ""
    var owner: pid_t = 0
    AXUIElementGetPid(top, &owner)
    let app = NSRunningApplication(processIdentifier: owner)?.localizedName ?? "pid \(owner)"
    let front = windowOwner(at: CGPoint(x: rect.midX, y: rect.midY))
    let server = front.map { "; front window: \($0.name) layer \($0.layer)" } ?? "; front window: none"
    // The words of an element of ANOTHER application are not said: they are what the person has
    // open there (the subject of a mail was reported once), and the caller needs only the
    // application to know what covers the target.
    var own: pid_t = 0
    AXUIElementGetPid(target, &own)
    let what = owner == own ? "\(role) \"\(name)\"" : "a \(role)"
    return .no(by: "\(what) of \(app)\(server)")
  }
  return .unknown(code: Int(code.rawValue))
}

/// How long the application must show no change before an action is called finished: 500 ms, the
/// quiet time the engine uses for a web page. The fixture holds it: an effect in two steps, 300 ms
/// apart, is cut off after the first step with a quiet time of 100 ms. A caller that knows its
/// application can set another time in the environment.
let quietNeededMs = Int(ProcessInfo.processInfo.environment["RETICLE_AX_QUIET_MS"] ?? "") ?? 500

/// The processes that a process started, and the ones those started.
func descendants(_ pid: pid_t, _ depth: Int = 0) -> [pid_t] {
  guard depth < 6 else { return [] }
  var buffer = [pid_t](repeating: 0, count: 512)
  let size = Int32(buffer.count * MemoryLayout<pid_t>.size)
  let found = Int(proc_listchildpids(pid, &buffer, size))
  guard found > 0 else { return [] }
  let children = buffer.prefix(min(found, buffer.count)).filter { $0 > 0 }
  return children + children.flatMap { descendants($0, depth + 1) }
}

/// The bytes that a process and the processes it started have written to disk, as the kernel
/// counts them. It is a fact from the operating system and not from the application: an
/// application that says "saved" and wrote nothing has a count that did not move.
///
/// An application made of several processes (a browser, an Electron application) writes from a
/// child, so the children are counted too. Two writers are not counted: a helper that the system
/// started for the application, which is not its child, and a child that wrote and ended before
/// the count was read. The caller must not read zero as "no write anywhere".
/// nil when the kernel does not answer for the process itself.
func bytesWritten(_ pid: pid_t) -> UInt64? {
  func one(_ pid: pid_t) -> UInt64? {
    var info = rusage_info_v4()
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
        proc_pid_rusage(pid, RUSAGE_INFO_V4, $0)
      }
    }
    return result == 0 ? info.ri_diskio_byteswritten : nil
  }
  guard let own = one(pid) else { return nil }
  return descendants(pid).reduce(own) { $0 + (one($1) ?? 0) }
}

/// Whether a running application is in a sandbox, asked of its code signature. nil when the
/// system does not answer.
///
/// It was asked of the file system before: is there a folder for the application in
/// ~/Library/Containers. macOS guards that folder, and a look into it can put a question on the
/// person's screen ("would like to access data from other apps"). The signature needs no such
/// look.
func sandboxed(_ pid: pid_t) -> Bool? {
  var code: SecCode?
  let attributes = [kSecGuestAttributePid: pid] as CFDictionary
  guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code
  else { return nil }
  var fixed: SecStaticCode?
  guard SecCodeCopyStaticCode(code, [], &fixed) == errSecSuccess, let fixed else { return nil }
  var info: CFDictionary?
  let flags = SecCSFlags(rawValue: kSecCSSigningInformation)
  guard SecCodeCopySigningInformation(fixed, flags, &info) == errSecSuccess,
    let facts = info as? [String: Any]
  else { return nil }
  let entitlements = facts[kSecCodeInfoEntitlementsDict as String] as? [String: Any]
  return (entitlements?["com.apple.security.app-sandbox"] as? Bool) == true
}

/// The settings of an application: the values in its preferences domain, each as text.
///
/// nil when they cannot be read from outside the application. An application in a sandbox keeps
/// its settings in its own container, and a read from here gives nothing: that is "not read", and
/// it must not be taken for "no setting changed".
func settings(_ pid: pid_t) -> [String: String]? {
  guard let app = NSRunningApplication(processIdentifier: pid),
    let domain = app.bundleIdentifier ?? app.executableURL?.lastPathComponent
  else { return nil }
  // An application in a sandbox: not read. Nil too when the question has no answer.
  guard sandboxed(pid) == false else { return nil }
  CFPreferencesAppSynchronize(domain as CFString)
  let all =
    CFPreferencesCopyMultiple(
      nil, domain as CFString, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) as? [String: Any]
    ?? [:]
  return all.mapValues { String(describing: $0) }
}

/// The settings that are different after an action: new, changed or gone.
///
/// The whole values are compared. A value is given in its first 200 characters, and "cut" says so
/// when there was more: a change past that place is still a change, and the reader is told that
/// the two texts it sees are not the whole of it.
func settingsChanged(_ before: [String: String], _ after: [String: String]) -> [[String: Any]] {
  Set(before.keys).union(after.keys).sorted().compactMap { key -> [String: Any]? in
    let old = before[key] ?? ""
    let new = after[key] ?? ""
    guard before[key] != after[key] else { return nil }
    var change: [String: Any] = ["key": key, "old": String(old.prefix(200)), "new": String(new.prefix(200))]
    if old.count > 200 || new.count > 200 { change["cut"] = true }
    return change
  }
}

/// The clipboard. Its change count goes up each time something is put on it. The helper reads the
/// count and never the content: what a person copied is not the realm's to read.
///
/// A check can name another clipboard in the environment, so that it does not write over the one
/// the person at the machine uses.
let clipboard: NSPasteboard = {
  if let name = ProcessInfo.processInfo.environment["RETICLE_AX_PASTEBOARD"], !name.isEmpty {
    return NSPasteboard(name: NSPasteboard.Name(name))
  }
  return NSPasteboard.general
}()

/// The applications this process has read once. See the first read, in `tree`.
var readBefore = Set<pid_t>()

/// Key codes of the ANSI keyboard. A letter here is the key at that place, for a shortcut.
let keyCodes: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53, "backspace": 51, "delete": 117,
  "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126, "home": 115, "end": 119,
  "pageup": 116, "pagedown": 121,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
  "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38,
  "k": 40, "n": 45, "m": 46,
  // Digits and marks: shortcuts such as Command-1 or Command-= use them.
  "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
  "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41, "'": 39, ",": 43, ".": 47, "/": 44,
  "`": 50,
  // The function keys: editors of video and sound use them (Shift-F12 appends a clip in Resolve).
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
  "f10": 109, "f11": 103, "f12": 111,
]
let modifierFlags: [String: CGEventFlags] = [
  "meta": .maskCommand, "shift": .maskShift, "alt": .maskAlternate, "control": .maskControl,
]

/// One command: `args` are the words of a command line, the program name first.
/// The screen is locked, as the session says it.
func screenIsLocked() -> Bool {
  let session = CGSessionCopyCurrentDictionary() as? [String: Any]
  return (session?["CGSSessionScreenIsLocked"] as? Bool) == true
}

/// The process is there, and it is not one that ended and waits to be collected by its parent.
///
/// The system is asked for the path of the program: it has none for a process that ended. The
/// list of running applications was asked before. It said "not there" for a moment while an
/// application came to the front, and the realm then said that a living application had ended.
func isRunning(_ pid: pid_t) -> Bool {
  if kill(pid, 0) != 0 && errno == ESRCH { return false }
  var path = [CChar](repeating: 0, count: 4096)
  return proc_pidpath(pid, &path, UInt32(path.count)) > 0
}

func run(_ args: [String]) throws {
  if args.count >= 2, args[1] == "apps" {
    // The applications a person could mean by a name: the name they see, and the name of the
    // process. Only names and numbers, and only of applications that have a face.
    let list = NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy != .prohibited && !$0.isTerminated && kill($0.processIdentifier, 0) == 0 }
      .map { app -> [String: Any] in
        [
          "name": app.localizedName ?? "",
          "process": app.executableURL?.lastPathComponent ?? "",
          "pid": Int(app.processIdentifier),
          // In the Dock, with windows of its own: what a person calls an application.
          "regular": app.activationPolicy == .regular,
          // When it was started. Of two with one name, the caller takes the newer one.
          "launched": app.launchDate?.timeIntervalSince1970 ?? 0,
        ]
      }
    try emit(["apps": list])
  }
  if args.count >= 2, args[1] == "texts" {
    // The words in a picture, each with its box in the pixels of the picture: the same space as a
    // `point` of a picture. A canvas, a game or a remote desktop has no elements, and its words
    // are what an agent looks for. Vision reads them on this machine; nothing leaves it.
    guard args.count >= 3, let image = NSImage(contentsOfFile: args[2]),
      let picture = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else { try emit(["error": "usage"]) }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: picture, options: [:]).perform([request])
    let width = Double(picture.width)
    let height = Double(picture.height)
    let found: [[String: Any]] = (request.results ?? []).compactMap { seen in
      guard let best = seen.topCandidates(1).first else { return nil }
      // Vision's box is a fraction, from the bottom left. The picture's points are from the top left.
      let box = seen.boundingBox
      return [
        "text": best.string, "confidence": Double(best.confidence),
        "box": [
          (box.minX * width).rounded(), ((1 - box.maxY) * height).rounded(),
          (box.width * width).rounded(), (box.height * height).rounded(),
        ],
      ]
    }
    try emit(["texts": found])
  }

  guard args.count >= 3, let pid = Int32(args[2]) else {
    try emit(["error": "usage"])
  }
  guard AXIsProcessTrusted() else {
    try emit(["error": "not-trusted"])
  }
  // An application that ended gives a read with nothing in it, and that looked like an
  // application with no window. Say that it ended.
  guard isRunning(pid) else {
    try emit(["error": "app-gone"])
  }
  // With the screen locked, the system gives no window of any application: the application read
  // as one with no window, and nothing said why.
  guard !screenIsLocked() else {
    try emit(["error": "screen-locked"])
  }
  // Not the realm's own window. Pause in that window is for the person at the machine: a realm
  // that can read the window can press Resume in it, and the pause is then worth nothing. The
  // check of the window sets this name in the environment, and nothing else does.
  var program = [CChar](repeating: 0, count: 4096)
  if proc_pidpath(pid, &program, UInt32(program.count)) > 0,
    URL(fileURLWithPath: String(cString: program)).lastPathComponent == hudProgram,
    ProcessInfo.processInfo.environment["RETICLE_AX_CHECKS_ITS_OWN_WINDOW"] == nil
  {
    try emit(["error": "own-window"])
  }
  let app = AXUIElementCreateApplication(pid)

  if args[1] == "web-tree" {
    // An Electron application gives its tree with no switch, and then does nothing for a press:
    // the press is answered with "done" and the page never gets it. With this attribute on, the
    // press works. It is the attribute that Electron documents for a tool that is not a screen
    // reader. It costs the application some speed, so it is set only when the person asks, and
    // set back when the realm leaves.
    if args.count > 3 && args[3] == "try" {
      // Some native applications build part of their tree only for a screen reader: Numbers gives
      // its sheet as an empty scroll area, and with this switch every cell with its value. Set it,
      // and keep it only when the tree grew: for an application that already gives all of it, the
      // switch only costs speed.
      var before = snapshot(app)
      for _ in 0..<12 {
        Thread.sleep(forTimeInterval: 0.15)
        let again = snapshot(app)
        if again.json == before.json { break }
        before = again
      }
      // Not any growth: a feed or a list that loads by itself grows too, and would keep a switch
      // that only costs it speed. The switch is kept when a container that held nothing but its
      // scroll bars now holds content, as the sheet of Numbers does.
      let empty = emptyContainers(before.tree)
      AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
      readBefore.remove(pid)
      var grew = false
      var last = before.json
      let until = Date().addingTimeInterval(3)
      while Date() < until {
        Thread.sleep(forTimeInterval: 0.15)
        let now = snapshot(app)
        if !empty.isDisjoint(with: filledContainers(now.tree, among: empty)) { grew = true }
        if grew && now.json == last { break }
        last = now.json
      }
      if !grew {
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
      }
      try emit(["set": grew])
    }
    let on = args.count > 3 && args[3] == "on"
    if on {
      // An application that just started has no window yet. A switch that is set then is in
      // effect at a time nobody knows, and the wait below ends too soon. Wait for a window first,
      // five seconds at most: an application with no window at all gets the switch as before.
      let until = Date().addingTimeInterval(5)
      while Date() < until {
        var windows: AnyObject?
        AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows)
        if let list = windows as? [AXUIElement], !list.isEmpty { break }
        Thread.sleep(forTimeInterval: 0.15)
      }
    }
    // The tree as it is before the switch, read until two reads agree: a web view makes its tree
    // when it is first asked, and that first growth must not be taken for the switch.
    var before = snapshot(app).json
    for _ in 0..<12 {
      Thread.sleep(forTimeInterval: 0.15)
      let again = snapshot(app).json
      if again == before { break }
      before = again
    }
    let result = AXUIElementSetAttributeValue(
      app, "AXManualAccessibility" as CFString, on ? kCFBooleanTrue : kCFBooleanFalse)
    // The second switch, the one a screen reader sets. Electron does a press with the first one
    // alone. Chrome does not: it gives its tree, answers "done" to a press, and the page gets no
    // click. With this one the click comes. Its answer is not read: Chrome says "not implemented"
    // and takes it.
    _ = AXUIElementSetAttributeValue(
      app, "AXEnhancedUserInterface" as CFString, on ? kCFBooleanTrue : kCFBooleanFalse)
    readBefore.remove(pid)
    // The switch is not in effect at once. For some seconds the application gives the same tree
    // as before, answers "done" to a press, and loses the press. When the switch is in effect the
    // tree is another one (a heading gets its level, for one). So wait until the tree has changed
    // and two reads agree, for five seconds at most. With no change in that time, the tree was
    // the full one already.
    if on && result == .success {
      var last = before
      var changed = false
      // By the clock, and not by a count of reads: a read of a large page takes time of its own.
      let until = Date().addingTimeInterval(5)
      while Date() < until {
        Thread.sleep(forTimeInterval: 0.15)
        let now = snapshot(app).json
        if now != before { changed = true }
        if changed && now == last { break }
        last = now
      }
    } else if on {
      // Chrome refuses the first switch and takes the second one. Its tree does not change when
      // the switch is in effect, so there is nothing to wait for but time. Measured on Chrome: a
      // press is lost up to 2.4 s after the switch, and it comes from 3.3 s on.
      // ponytail: a fixed four seconds. Wait for a true sign when one is found.
      Thread.sleep(forTimeInterval: 4)
    }
    try emit(["set": result == .success])
  }

  if args[1] == "capture" {
    // A picture of the application's own window, and of nothing else: the window server draws
    // the window by its number, also when another window is over it. For an application that
    // gives no elements (a canvas, a game), the picture is what there is to read.
    guard args.count >= 4 else { try emit(["error": "usage"]) }
    guard CGPreflightScreenCaptureAccess() else {
      try emit(["ok": false, "reason": "no-screen-recording-permission"])
    }
    let best = mainWindow(pid)
    // "screen": the whole display that holds the application's window, with every application
    // on it. An overlay of another application, or a dialog of the system, is there too.
    if args.count >= 5, args[4] == "screen" {
      var displays = [CGDirectDisplayID](repeating: 0, count: 16)
      var count: UInt32 = 0
      CGGetActiveDisplayList(16, &displays, &count)
      let active = Array(displays.prefix(Int(count)))
      let display =
        best.flatMap { b in active.first { CGDisplayBounds($0).intersects(b.rect) } }
        ?? CGMainDisplayID()
      let bounds = CGDisplayBounds(display)
      // screencapture numbers the displays from 1, in the order of the active list.
      let number = (active.firstIndex(of: display) ?? 0) + 1
      let shot = Process()
      shot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
      shot.arguments = ["-x", "-D", String(number), args[3]]
      try? shot.run()
      shot.waitUntilExit()
      guard shot.terminationStatus == 0, FileManager.default.fileExists(atPath: args[3]) else {
        try emit(["ok": false, "reason": "the capture failed"])
      }
      let scale = Double(CGDisplayPixelsWide(display)) / Double(max(bounds.width, 1))
      let pixels = NSImage(contentsOfFile: args[3])?.representations.first?.pixelsWide ?? 0
      var answer: [String: Any] = [
        "ok": true, "path": args[3],
        "scale": pixels > 0 ? Double(pixels) / Double(bounds.width) : scale,
        "window": [bounds.origin.x, bounds.origin.y, bounds.width, bounds.height],
      ]
      if let b = best {
        answer["appWindow"] = [b.rect.origin.x, b.rect.origin.y, b.rect.width, b.rect.height]
      }
      try emit(answer)
    }
    guard let window = best else { try emit(["ok": false, "reason": "no-window-on-this-screen"]) }
    let shot = Process()
    shot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    // -x: no sound. -o: no shadow, so the picture is the window and its points are the window's.
    shot.arguments = ["-x", "-o", "-l", String(window.id), args[3]]
    try? shot.run()
    shot.waitUntilExit()
    guard shot.terminationStatus == 0, FileManager.default.fileExists(atPath: args[3]) else {
      try emit(["ok": false, "reason": "the capture failed"])
    }
    let scale =
      NSScreen.screens.first { $0.frame.intersects(window.rect) }?.backingScaleFactor ?? 2
    try emit([
      "ok": true, "path": args[3], "scale": Double(scale),
      "window": [window.rect.origin.x, window.rect.origin.y, window.rect.width, window.rect.height],
    ])
  }

  if args[1] == "tree" {
    let started = Date()
    var shot = snapshot(app)
    // The first read of an application can be less than the application has. A web view makes
    // its accessibility tree when it is first asked, and the first answer had an empty group
    // where the page is. So the first read of each application is read again until two reads
    // agree, for a second at most.
    if !readBefore.contains(pid) {
      readBefore.insert(pid)
      for _ in 0..<8 {
        Thread.sleep(forTimeInterval: 0.12)
        let again = snapshot(app)
        let same = again.json == shot.json
        shot = again
        if same { break }
      }
    }
    try emit([
      "tree": shot.tree, "unread": shot.unread, "windowsNotOnScreen": windowsNotOnScreen(pid),
      "readMs": Int(Date().timeIntervalSince(started) * 1000),
    ])
  }

  let onlyReach = args[1] == "reach"
  guard (args[1] == "act" && args.count >= 7) || (onlyReach && args.count >= 6) else {
    try emit(["error": "usage"])
  }
  let path = args[3].split(separator: ".").compactMap { Int($0) }
  let action = onlyReach ? "" : args[6]
  let value = args.count > 7 ? args[7] : ""
  let budgetMs = args.count > 8 ? Int(args[8]) ?? 1000 : 1000
  // The way to deliver, and after ":" the quiet time for this action when the caller gives one.
  let how = args.count > 9 ? args[9].split(separator: ":").map(String.init) : []
  let direct = how.first == "direct"
  // In the foreground: the application is brought to the front and the real pointer is used, as
  // a person uses it. It takes the pointer and the keyboard of the person at the machine for a
  // moment, so a caller asks for it by name. The pointer and the application that was in front
  // are put back after the action.
  let foreground = how.first == "foreground"
  /// A key goes to the application alone, with no use of the keyboard of the person at the machine.
  /// In the foreground it goes the way a real key goes: a panel that the system draws for the
  /// application (the save panel, the open panel) is another process, and a key that is sent to
  /// the application does not reach it.
  ///
  /// A real key goes to whatever application has the keyboard. So it is sent only when the system
  /// says that THIS application has it. A key that was meant for this application was once typed
  /// into the terminal of the person at the machine, because the application had not taken the
  /// keyboard. When it has not, no key is sent at all, and the action is refused.
  func hasKeyboard() -> Bool {
    RunLoop.current.run(until: Date())
    return NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
  }
  func deliver(_ event: CGEvent) {
    if foreground { event.post(tap: .cghidEventTap) } else { event.postToPid(pid) }
  }
  let quietWanted = how.count > 1 ? Int(how[1]) ?? quietNeededMs : quietNeededMs
  let folders = Array(args.dropFirst(10))

  /// The names, sizes and change times of every file in the watched folders, as one string.
  func filesNow() -> String {
    var out = ""
    for folder in folders {
      let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
      guard
        let walk = FileManager.default.enumerator(
          at: URL(fileURLWithPath: folder), includingPropertiesForKeys: keys)
      else { continue }
      for case let url as URL in walk {
        let v = try? url.resourceValues(forKeys: Set(keys))
        out += "\(url.path)|\(v?.fileSize ?? -1)|\(v?.contentModificationDate?.timeIntervalSince1970 ?? 0)\n"
      }
    }
    return out
  }

  var target = app
  for index in path {
    guard let next = child(target, index) else {
      try emit(["refused": "stale", "detail": "no element at the path"])
    }
    target = next
  }
  guard var now = values(target) else {
    try emit(["refused": "stale", "detail": "the element does not answer"])
  }
  let nameNow = [text(now[2]), text(now[3])].compactMap { $0 }.first { !$0.isEmpty } ?? ""
  guard text(now[0]) == args[4], nameNow == args[5] else {
    try emit(["refused": "stale", "detail": "a different element is at the path"])
  }
  if onlyReach {
    // Asks one thing and acts on nothing: can a person see and click this element now?
    switch frame(now[7], now[8]).map({ reach(target, $0) }) ?? .unknown(code: -1) {
    case .yes: try emit(["reach": "yes"])
    case .no(let by): try emit(["reach": "no", "detail": by])
    case .unknown(let code): try emit(["reach": "unknown", "detail": "the hit test failed with \(code)"])
    }
  }
  // An application with no window on the screen (all on another desktop, or in another set of
  // Stage Manager) says that it is not enabled. That is when a person brings it to the front, and
  // the realm refused to: Finder could not be brought back. A control that is off is refused.
  let raisesApp = action == "raise" && text(now[0]) == "AXApplication"
  if let enabled = now[5] as? Bool, !enabled, !raisesApp {
    try emit(["refused": "disabled"])
  }

  var appBefore: NSRunningApplication?
  var pointerBefore: CGPoint?
  if foreground {
    // Not while the person at the machine types or moves the pointer: a key or a click of theirs
    // would land in the application that is brought to the front. Wait for a moment with no
    // input from them, and refuse when there is none in five seconds.
    func idleSeconds() -> Double {
      let any = CGEventType(rawValue: ~0)!
      return CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: any)
    }
    var waited = 0.0
    while idleSeconds() < 0.8 && waited < 5 {
      Thread.sleep(forTimeInterval: 0.1)
      waited += 0.1
    }
    guard idleSeconds() >= 0.8 else {
      try emit(["refused": "person-active", "detail": "the person at the machine is typing or moving the pointer"])
    }
    RunLoop.current.run(until: Date())
    appBefore = NSWorkspace.shared.frontmostApplication
    pointerBefore = CGEvent(source: nil)?.location
    // Two ways to bring it to the front, and the first is the one that works on a new macOS: a
    // tool for accessibility may say that an application is the one in front. The plain request
    // to activate is one the system is free to pass over, and it did for an application that was
    // opened in the background.
    AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    NSRunningApplication(processIdentifier: pid)?.activate(options: [])
    // Not long: an application that never takes the front (a panel, an accessory) is acted on
    // where it is, and the reach test below says if a person could click it.
    for _ in 0..<12 where !isInFront(pid) { Thread.sleep(forTimeInterval: 0.05) }
  }
  /// Puts the pointer and the application in front back as they were. Not after a hover or a
  /// raise: what those are for is gone when the pointer or the application goes away.
  func putBack() {
    guard foreground, action != "hover", action != "raise" else { return }
    if let was = pointerBefore { CGWarpMouseCursorPosition(was) }
    if let was = appBefore, was.processIdentifier != pid {
      // The same two ways as above: the plain request alone can be passed over, and the person
      // would then be left with the keyboard in the wrong application.
      AXUIElementSetAttributeValue(
        AXUIElementCreateApplication(was.processIdentifier), kAXFrontmostAttribute as CFString,
        kCFBooleanTrue)
      was.activate(options: [])
    }
  }

  let before = snapshot(app)
  let filesBefore = filesNow()
  let writtenBefore = bytesWritten(pid)
  let settingsBefore = settings(pid)
  let clipboardBefore = clipboard.changeCount
  var canReach = false
  var coveredBy = ""
  // To bring an application to the front, nothing has to be reached: an application with no
  // window has no place on the screen at all, and it can still come to the front.
  // A pointer action at a given point goes to that point, not to the middle of the element: the
  // point has its own test below. A hover at the edge of a window that a sidebar covers was
  // refused here, because the middle of the window was under that sidebar.
  // A drag from a point gives four numbers, and the wheel at a point gives three.
  // A pointer action carries its points first, and after "|" how the hand holds it: the keys held
  // ("mods=shift+alt") and how long the button stays down ("hold=500"). Only for the pointer: a
  // text that is typed can hold a "|" of its own.
  let pointerActions: Set<String> = ["click", "dblclick", "rightclick", "hover", "drag", "wheel"]
  let handParts = pointerActions.contains(action) ? value.components(separatedBy: "|") : [value]
  let pointValue = handParts.first ?? ""
  var hand: [String: String] = [:]
  for part in handParts.dropFirst() {
    let pair = part.split(separator: "=", maxSplits: 1).map(String.init)
    if pair.count == 2 { hand[pair[0]] = pair[1] }
  }
  // A canvas shows its effect only in pixels: take the window's picture before the hand moves.
  // Only for a pointer in the foreground, where the window is on the screen to be drawn.
  // The realm asks for it ("pixels=1") only for a point of a picture or an element that can be a
  // canvas: each picture costs time, and a button shows its effect in its elements.
  let pictureWindow = foreground && pointerActions.contains(action) && action != "hover"
    && hand["pixels"] == "1" ? mainWindow(pid) : nil
  // A window that just came to the front draws itself again (a selection turns from grey to
  // blue). That redraw is not the action's effect: wait for it before the first picture.
  if pictureWindow != nil, let was = appBefore, was.processIdentifier != pid {
    Thread.sleep(forTimeInterval: 0.2)
  }
  // Two pictures, a moment apart: what moves between them moves by itself (a video that plays).
  let pixelsEarlier = pictureWindow.flatMap { windowPixels($0.id) }
  if pixelsEarlier != nil { Thread.sleep(forTimeInterval: 0.1) }
  let pixelsBefore = pictureWindow.flatMap { windowPixels($0.id) }
  let pointNumbers = pointValue.split(separator: ",").compactMap({ Double($0) })
  let pointCount = ["click": 2, "dblclick": 2, "rightclick": 2, "hover": 2, "wheel": 3]
  // A drag from a point is four numbers or more: a start, then each point of its path.
  let atPoint =
    action == "drag"
    ? pointNumbers.count >= 4 && pointNumbers.count % 2 == 0
    : pointCount[action] == pointNumbers.count
  // A key to the application as a whole aims at no point, so the test of a click does not apply:
  // the middle of the Dock is under the menu bar of the application in front. A key to a field
  // keeps the test.
  // Typing is keys too: a person types into the application in front, not at a point of it.
  let keyToApp = (action == "key" || action == "type") && text(now[0]) == "AXApplication"
  let needsReach = !direct && action != "raise" && !atPoint && !keyToApp
  var reached = frame(now[7], now[8]).map({ reach(target, $0) }) ?? .unknown(code: -1)
  // Stage Manager keeps a window in its strip at the side until its application comes to the
  // front, and then slides it to the middle. The element is then covered by the strip, and its
  // place is the old one: a click was refused, and would have gone to the old place. Read the
  // element again while the window moves, a second and a half at most.
  if foreground, case .no = reached {
    let until = Date().addingTimeInterval(1.5)
    while Date() < until {
      Thread.sleep(forTimeInterval: 0.1)
      guard let fresh = values(target) else { break }
      now = fresh
      reached = frame(now[7], now[8]).map({ reach(target, $0) }) ?? .unknown(code: -1)
      if case .yes = reached { break }
    }
  }
  // A part of the element can be under another view (a handle of a table lies on the middle of a
  // cell). A person clicks the part they can see: try the middle of each quarter.
  var visiblePoint: CGPoint?
  if foreground, case .no = reached, let rect = frame(now[7], now[8]) {
    for (fx, fy) in [(0.25, 0.5), (0.75, 0.5), (0.5, 0.25), (0.5, 0.75)] {
      let point = CGPoint(x: rect.minX + rect.width * fx, y: rect.minY + rect.height * fy)
      if case .yes = reach(target, CGRect(origin: point, size: .zero)) {
        visiblePoint = point
        reached = .yes
        break
      }
    }
  }
  switch reached {
  case .yes: canReach = true
  case .no(let by):
    coveredBy = by
    if needsReach {
      putBack()
      try emit(["refused": "unreachable", "detail": by])
    }
  case .unknown(let code):
    if needsReach {
      putBack()
      try emit(["refused": "reach-unknown", "detail": "the hit test failed with \(code)"])
    }
  }

  let started = Date()
  let result: AXError
  /// The window that `window` arranged, and the frame it was given: read again after the wait.
  var arranged: AXUIElement?
  var wantedFrame: CGRect?
  switch action {
  case "press":
    var targetRole: AnyObject?
    AXUIElementCopyAttributeValue(target, kAXRoleAttribute as CFString, &targetRole)
    // The words of a row: a text, a field or a picture inside it. A click of a person on them
    // chooses the row, or the item of a list (a file in a column of Finder). Only these: a button
    // or a box inside a row that refuses its press (it is busy, or it is off) must be reported as
    // refused, and never turned into a choice of its row that the answer then calls done.
    let isWords = ["AXStaticText", "AXTextField", "AXImage"].contains(targetRole as? String ?? "")
    // The words are not pressed when a row or an item holds them: the name field of a file in
    // Finder says yes to a press and to "selected", and nothing is chosen. The choice is read
    // again after it, because Finder chooses the file and answers with an error.
    var done: AXError?
    if isWords {
      var up = target
      for _ in 0..<4 {
        var parent: AnyObject?
        guard AXUIElementCopyAttributeValue(up, kAXParentAttribute as CFString, &parent) == .success,
          let above = parent, CFGetTypeID(above) == AXUIElementGetTypeID()
        else { break }
        let item = up
        up = above as! AXUIElement
        let role = values(up).flatMap { text($0[0]) }
        if role == "AXRow" {
          done = AXUIElementSetAttributeValue(up, kAXSelectedAttribute as CFString, kCFBooleanTrue)
          break
        }
        if role == "AXList" {
          AXUIElementSetAttributeValue(up, kAXSelectedChildrenAttribute as CFString, [item] as CFArray)
          var chosen: AnyObject?
          AXUIElementCopyAttributeValue(up, kAXSelectedChildrenAttribute as CFString, &chosen)
          let picked = ((chosen as? [AXUIElement]) ?? []).contains { CFEqual($0, item) }
          done = picked ? .success : .failure
          break
        }
      }
    }
    if done == nil {
      let pressed = AXUIElementPerformAction(target, kAXPressAction as CFString)
      // A row of a table has no press. A click on it chooses it, so choose it.
      done =
        pressed == .actionUnsupported && !isWords
        ? AXUIElementSetAttributeValue(target, kAXSelectedAttribute as CFString, kCFBooleanTrue)
        : pressed
    }
    result = done ?? .failure
  case "set":
    // An element whose value is a number (a slider, a scroll bar) takes a number, not its text.
    let number = now[4] is NSNumber ? Double(value).map { NSNumber(value: $0) } : nil
    result = AXUIElementSetAttributeValue(
      target, kAXValueAttribute as CFString, number ?? (value as CFString))
  case "type":
    if foreground && !hasKeyboard() {
      putBack()
      try emit(["refused": "no-keyboard", "detail": "the application did not take the keyboard"])
    }
    // Key events, one for each character, sent to the application and not to the screen: the
    // pointer and the keyboard of the person at the machine are not used. The element takes the
    // keyboard first, as a click in it does. Delivery proves nothing here. The caller reads the
    // value after it.
    _ = AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let source = CGEventSource(stateID: .hidSystemState)
    for unit in value.utf16 {
      var character = [unit]
      for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else {
          continue
        }
        event.keyboardSetUnicodeString(stringLength: 1, unicodeString: &character)
        deliver(event)
      }
      usleep(4000)
    }
    result = .success
  case "key":
    // The shortcuts of Mission Control and the desktops. The system takes them before any
    // application does, so they need no application with the keyboard: the Dock, which holds
    // Mission Control, never has it. No other key goes without that check.
    let systemShortcuts: Set<String> = [
      "control+arrowup", "control+arrowdown", "control+arrowleft", "control+arrowright",
    ]
    if foreground && !hasKeyboard() && !systemShortcuts.contains(value.lowercased()) {
      putBack()
      try emit(["refused": "no-keyboard", "detail": "the application did not take the keyboard"])
    }
    // One key, with its modifiers: "Return", "Tab", "Meta+s". Sent to the application, as "type" is.
    let parts = value.split(separator: "+").map(String.init)
    guard let name = parts.last, let code = keyCodes[name.lowercased()] else {
      try emit(["error": "unknown-key"])
    }
    var flags: CGEventFlags = []
    for modifier in parts.dropLast() {
      guard let flag = modifierFlags[modifier.lowercased()] else { try emit(["error": "unknown-key"]) }
      flags.insert(flag)
    }
    // A real arrow key comes with the flags of the number pad and of Fn. The system matches its
    // shortcuts on the whole set of flags, so Control+Up with no such flags did not open Mission
    // Control. Only for those shortcuts: an arrow to a list in the background moved nothing with them.
    if systemShortcuts.contains(value.lowercased()) {
      flags.formUnion([.maskNumericPad, .maskSecondaryFn])
    }
    _ = AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let source = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] {
      guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else {
        continue
      }
      event.flags = flags
      deliver(event)
    }
    // A key with flags, posted to the system, leaves those flags held in its state when no key of
    // a modifier went up: Control, Fn and the number pad stayed held after Control+Up, and every
    // key typed after it on the machine was a Control key. Let them go, as a hand lets go.
    if foreground && !flags.isEmpty, let release = CGEvent(source: source) {
      release.type = .flagsChanged
      release.flags = []
      deliver(release)
    }
    result = .success
  case "menu":
    // The menu a right-click gives, asked for by name. No pointer is used.
    result = AXUIElementPerformAction(target, kAXShowMenuAction as CFString)
  case "window":
    // The window of the element, arranged as a person does it with its buttons and the Window
    // menu. No pointer: the window is set through the Accessibility API, also in the background.
    var window = target
    if text(now[0]) == "AXApplication" {
      // On the application, as a person uses its tile in the Dock: `restore` brings back a window
      // that is minimized or in full screen, and the others arrange the main window.
      var all: AnyObject?
      AXUIElementCopyAttributeValue(target, kAXWindowsAttribute as CFString, &all)
      let windows = (all as? [AXUIElement]) ?? []
      func flag(_ w: AXUIElement, _ name: String) -> Bool {
        var v: AnyObject?
        AXUIElementCopyAttributeValue(w, name as CFString, &v)
        return (v as? Bool) ?? false
      }
      var main: AnyObject?
      AXUIElementCopyAttributeValue(target, kAXMainWindowAttribute as CFString, &main)
      let hidden = windows.first { flag($0, kAXMinimizedAttribute) || flag($0, "AXFullScreen") }
      let chosen =
        value == "restore" ? hidden : (main.map { $0 as! AXUIElement } ?? windows.first)
      guard let found = chosen else {
        try emit(["refused": "no-window", "detail": "the application has no such window"])
      }
      window = found
    } else if text(now[0]) != "AXWindow" {
      var holder: AnyObject?
      guard AXUIElementCopyAttributeValue(target, kAXWindowAttribute as CFString, &holder) == .success,
        let found = holder, CFGetTypeID(found) == AXUIElementGetTypeID()
      else { try emit(["refused": "no-window", "detail": "the element is in no window"]) }
      window = found as! AXUIElement
    }
    arranged = window
    guard let (done, wanted) = arrange(window, value) else {
      try emit(["refused": "bad-value", "detail": "no arrangement \(value)"])
    }
    wantedFrame = wanted
    result = done
  case "raise":
    // The application is in front already: that was done above. Give the element the keyboard.
    guard foreground else { try emit(["refused": "needs-foreground"]) }
    _ = AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    result = isInFront(pid) ? .success : .cannotComplete
  case "click", "dblclick", "rightclick", "hover", "drag", "wheel":
    // The real pointer. Only in the foreground: a pointer event that is sent to one application
    // in the background is not taken by it.
    guard foreground, let rect = frame(now[7], now[8]) else {
      try emit(["refused": "needs-foreground"])
    }
    // The middle of the element, or the point the caller gives as "x,y" on the screen: for an
    // application that gives no elements, a point in its picture is all a caller has.
    // The start of a drag is its first two numbers, and the point of the wheel its last two.
    let numbers = pointNumbers
    let given: [Double]
    switch action {
    case "drag": given = numbers.count >= 4 ? Array(numbers[0..<2]) : []
    case "wheel": given = numbers.count == 3 ? Array(numbers[1..<3]) : []
    default: given = numbers
    }
    let at =
      given.count == 2
      ? CGPoint(x: given[0], y: given[1]) : (visiblePoint ?? CGPoint(x: rect.midX, y: rect.midY))
    if given.count == 2 {
      // The reach test above is for the middle of the element. A point is another place: when a
      // window of another application is at that point, the click would go to that application.
      var hit: AXUIElement?
      var owner: pid_t = 0
      let found =
        AXUIElementCopyElementAtPosition(
          AXUIElementCreateSystemWide(), Float(at.x), Float(at.y), &hit) == .success
      if let top = hit { AXUIElementGetPid(top, &owner) }
      // A part of a window that gives no element (the pinned tabs of Dia's sidebar) fails the hit
      // test. The window server still knows whose window is in front at that point.
      let frontIsOwn = !found && windowOwner(at: at)?.pid == pid
      guard (found && owner == pid) || frontIsOwn else {
        putBack()
        let other = NSRunningApplication(processIdentifier: owner)?.localizedName ?? "another application"
        try emit([
          "refused": "unreachable",
          "detail": found ? "a window of \(other)" : "nothing this realm can name",
        ])
      }
    }
    let source = CGEventSource(stateID: .hidSystemState)
    // The keys a hand holds through the action: shift-click to add to a choice, option-drag to make
    // a copy, shift-drag for a straight line.
    var held: CGEventFlags = []
    for name in (hand["mods"] ?? "").lowercased().split(separator: "+") {
      switch name {
      case "shift": held.insert(.maskShift)
      case "alt", "option": held.insert(.maskAlternate)
      case "control", "ctrl": held.insert(.maskControl)
      case "meta", "command", "cmd": held.insert(.maskCommand)
      default: break
      }
    }
    let holdSeconds = min(10, max(0, Double(hand["hold"] ?? "0") ?? 0) / 1000)
    func send(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, clicks: Int64 = 1) {
      guard
        let event = CGEvent(
          mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
      else { return }
      event.setIntegerValueField(.mouseEventClickState, value: clicks)
      if !held.isEmpty { event.flags = held }
      event.post(tap: .cghidEventTap)
      Thread.sleep(forTimeInterval: 0.03)
    }
    func flagsTo(_ flags: CGEventFlags) {
      guard let change = CGEvent(source: source) else { return }
      change.type = .flagsChanged
      change.flags = flags
      change.post(tap: .cghidEventTap)
      Thread.sleep(forTimeInterval: 0.02)
    }
    // Pressed before the pointer moves, and let go after it, whatever the action did.
    if !held.isEmpty { flagsTo(held) }
    defer { if !held.isEmpty { flagsTo([]) } }
    send(.mouseMoved, at, .left)
    // A second small move: a view learns that the pointer came in from a move inside it, and one
    // jump to its middle did not always tell it.
    send(.mouseMoved, CGPoint(x: at.x + 1, y: at.y + 1), .left)
    send(.mouseMoved, at, .left)
    switch action {
    case "click":
      // "count=3" is a triple-click (a line or a paragraph), "button=middle" the middle button.
      let middle = hand["button"] == "middle"
      let count = Int64(min(3, max(1, Int(hand["count"] ?? "1") ?? 1)))
      for n in 1...count {
        send(middle ? .otherMouseDown : .leftMouseDown, at, middle ? .center : .left, clicks: n)
        if holdSeconds > 0 && n == count { Thread.sleep(forTimeInterval: holdSeconds) }
        send(middle ? .otherMouseUp : .leftMouseUp, at, middle ? .center : .left, clicks: n)
      }
    case "dblclick":
      for count in [Int64(1), 2] {
        send(.leftMouseDown, at, .left, clicks: count)
        send(.leftMouseUp, at, .left, clicks: count)
      }
    case "rightclick":
      send(.rightMouseDown, at, .right)
      send(.rightMouseUp, at, .right)
    case "wheel":
      // Lines of the wheel over the element, in small turns as a hand gives them. More than 0 is
      // down; the system counts a turn up as more than 0, so the sign is turned over.
      // "across=5" in the hand turns it to the side: more than 0 is to the right.
      let lines = Int32(numbers.first ?? 0)
      let across = Int32(hand["across"] ?? "0") ?? 0
      let step: Int32 = lines == 0 ? 0 : (lines > 0 ? -3 : 3)
      let side: Int32 = across == 0 ? 0 : (across > 0 ? -3 : 3)
      for _ in 0..<max(1, max(abs(Int(lines)), abs(Int(across))) / 3) {
        guard
          let turn = CGEvent(
            scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: step,
            wheel2: side, wheel3: 0)
        else { break }
        turn.location = at
        turn.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.02)
      }
    case "drag":
      // To the point "x,y" on the screen, in steps: an application that follows a drag reads
      // where the pointer is on the way.
      // "x,y" of the end, from the element; or "x,y,x,y,..." from a start through each point of a
      // path: a stroke of a brush, a lasso, a curve. Each part of the way is walked in small steps,
      // as a hand moves, so an application that draws where the pointer is draws all of it.
      guard numbers.count >= 2 && numbers.count % 2 == 0 else { try emit(["error": "drag-needs-a-point"]) }
      var way: [CGPoint] = numbers.count == 2 ? [at] : []
      for i in stride(from: 0, to: numbers.count, by: 2) { way.append(CGPoint(x: numbers[i], y: numbers[i + 1])) }
      send(.leftMouseDown, way[0], .left)
      if holdSeconds > 0 { Thread.sleep(forTimeInterval: holdSeconds) }
      for (from, to) in zip(way, way.dropFirst()) {
        let length = hypot(to.x - from.x, to.y - from.y)
        let steps = max(4, min(40, Int(length / 6)))
        for step in 1...steps {
          let part = CGFloat(step) / CGFloat(steps)
          send(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * part, y: from.y + (to.y - from.y) * part), .left)
        }
      }
      send(.leftMouseUp, way[way.count - 1], .left)
    default: break
    }
    result = .success
  default: try emit(["error": "unknown-action"])
  }

  // Wait for the application to finish. Notifications from AXObserver are not dependable from one
  // application to the next, and a read is cheap, so read again until the application is quiet.
  //
  // Quiet is a length of TIME with no change, not a number of reads. It was two reads that agree,
  // and when a read took 60 ms that was a long time. With a read of 5 ms it was 50 ms: a menu that
  // shows its choice for a moment before it closes was called finished before it ran its action.
  // An action that is called finished too soon gives a false "no effect".
  //
  // When nothing has changed at all, spend the whole budget: an early "nothing changed" is a false
  // result for every effect that takes longer than the first read.
  // A choice in a menu is not finished while its menu is on the screen. The menu shows the choice
  // for a moment, closes, and only then runs the action. No length of quiet time is right for
  // every application here, so this is a fact that is read: the menu that held the target.
  var menu: AXUIElement?
  var up: AXUIElement = target
  for _ in 0..<6 {
    var parent: AnyObject?
    guard AXUIElementCopyAttributeValue(up, kAXParentAttribute as CFString, &parent) == .success,
      let next = parent, CFGetTypeID(next) == AXUIElementGetTypeID()
    else { break }
    up = next as! AXUIElement
    if let v = values(up), text(v[0]) == "AXMenu" {
      menu = up
      break
    }
  }
  func menuShows() -> Bool {
    guard let menu, let v = values(menu), let rect = frame(v[7], v[8]) else { return false }
    return rect.width > 0 && rect.height > 0
  }

  func sameButFocus(_ json: Data) -> String {
    String(decoding: json, as: UTF8.self).replacingOccurrences(
      of: "\"focused\":true", with: "\"focused\":false")
  }
  let startButFocus = sameButFocus(before.json)
  var last = before.json
  var lastFiles = filesBefore
  var after = before
  var quietSince = Date()
  func elapsedMs() -> Int { Int(Date().timeIntervalSince(started) * 1000) }
  func quietMs() -> Int { Int(Date().timeIntervalSince(quietSince) * 1000) }
  while elapsedMs() < budgetMs {
    Thread.sleep(forTimeInterval: 0.025)
    after = snapshot(app)
    let files = filesNow()
    if after.json != last || files != lastFiles || menuShows() { quietSince = Date() }
    last = after.json
    lastFiles = files
    // The keyboard coming to the target is not an effect. A button in a web view takes the
    // keyboard when it is pressed. That was "a change", so the wait ended before a slow effect,
    // and the next action was given that effect.
    if quietMs() >= quietWanted && (sameButFocus(after.json) != startButFocus || files != filesBefore) {
      break
    }
  }
  let settled = quietMs() >= quietWanted
  // Before the app in front is put back: the window then draws itself as one in the back.
  // The tree shows no change: the pixels can. Taken only then, so an action with elements pays
  // nothing more. A window that moved or is gone is not compared.
  var pixels: [String: Any]?
  if after.json == before.json, let window = pictureWindow, let was = pixelsBefore,
    let now = mainWindow(pid), now.id == window.id, now.rect.origin == window.rect.origin,
    let seen = windowPixels(now.id)
  {
    // And two after it: a motion that started with the action, or that is slow, shows there.
    Thread.sleep(forTimeInterval: 0.1)
    let later = windowPixels(now.id)
    var pairs: [(Pixels, Pixels)] = []
    if let earlier = pixelsEarlier { pairs.append((earlier, was)) }
    if let later { pairs.append((seen, later)) }
    pixels = pixelChange(was, seen, window: now.rect,
      moving: movingMask(pairs, width: was.width, height: was.height))
  }
  putBack()
  var changedSettings: [[String: Any]]?
  if let was = settingsBefore, let now = settings(pid) { changedSettings = settingsChanged(was, now) }
  var wrote: UInt64?
  if let was = writtenBefore, let now = bytesWritten(pid), now >= was { wrote = now - was }

  try emit([
    "delivered": result == .success, "axError": Int(result.rawValue), "reachable": canReach,
    // The application ended while the action ran: it quit, or it crashed.
    "appGone": !isRunning(pid),
    "coveredBy": coveredBy,
    "settled": settled, "waitedMs": elapsedMs(), "budgetMs": budgetMs,
    "before": before.tree, "after": after.tree, "unreadBefore": before.unread,
    "unreadAfter": after.unread,
  ].merging(wrote.map { ["bytesWritten": $0] } ?? [:]) { $1 }
    .merging(changedSettings.map { ["settingsChanged": $0] } ?? [:]) { $1 }
    .merging(["clipboardChanged": clipboard.changeCount != clipboardBefore]) { $1 }
    .merging(pixels.map { ["pixels": $0] } ?? [:]) { $1 }
    .merging(arranged.map { ["windowState": windowState($0, wanted: wantedFrame)] } ?? [:]) { $1 })
}

func write(_ object: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func answer(_ args: [String]) -> [String: Any] {
  do {
    try run(args)
  } catch let answer as Answer {
    return answer.body
  } catch {
    return ["error": "\(error)"]
  }
  return ["error": "no-answer"]
}

// `reticle-ax serve` stays open: each line on standard input is one command, as a JSON list of its
// words, and each answer is one line. Starting a process for each command costs more than most
// commands do. Any other first word runs that one command and ends.
if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "serve" {
  while let line = readLine() {
    let words = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String]
    write(words.map { answer(["reticle-ax"] + $0) } ?? ["error": "usage"])
  }
} else {
  write(answer(CommandLine.arguments))
}
