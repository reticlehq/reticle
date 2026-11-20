// reticle-ax: reads and drives one macOS application through the Accessibility API.
//
//   reticle-ax tree <pid>
//   reticle-ax act  <pid> <path> <role> <name> press|set|type|key [value] [budgetMs] [user-path|direct] [folder...]
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
// ponytail: one process for each call. Keep one process open over stdio when the start cost shows
// in a measurement.
import AppKit
import ApplicationServices
import Foundation

let attributes =
  [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
    kAXValueAttribute, kAXEnabledAttribute, kAXFocusedAttribute, kAXPositionAttribute,
    kAXSizeAttribute, kAXChildrenAttribute, kAXIdentifierAttribute,
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
  return CGRect(origin: p, size: s)
}

/// The element as a dictionary. `unread` counts elements the API refused to describe, so a reader
/// can tell a small tree from a tree with holes in it.
func read(_ element: AXUIElement, _ depth: Int, _ unread: inout Int) -> [String: Any] {
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
  if let s = text(v[10]), !s.isEmpty { node["id"] = s }
  let children = depth < 80 ? (v[9] as? [AXUIElement]) ?? [] : []
  node["children"] = children.map { read($0, depth + 1, &unread) }
  return node
}

func snapshot(_ app: AXUIElement) -> (tree: [String: Any], unread: Int, json: Data) {
  var unread = 0
  var tree = read(app, 0, &unread)
  // An application that is busy can refuse its first read. Ask once more before the caller gets
  // a tree with nothing in it. A second refusal is reported as it is, in `unread`.
  if (tree["role"] as? String) == "" {
    unread = 0
    tree = read(app, 0, &unread)
  }
  let json = (try? JSONSerialization.data(withJSONObject: tree, options: [.sortedKeys])) ?? Data()
  return (tree, unread, json)
}

func emit(_ object: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  exit(0)
}

func child(_ element: AXUIElement, _ index: Int) -> AXUIElement? {
  var value: AnyObject?
  guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
    let children = value as? [AXUIElement], index >= 0, index < children.count
  else { return nil }
  return children[index]
}

/// The application that owns the frontmost window at a point, from the window server's own list.
/// It needs no answer from any application.
func windowOwner(at point: CGPoint) -> (pid: pid_t, name: String, layer: Int)? {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    return nil
  }
  for window in list {
    guard let bounds = window[kCGWindowBounds as String] as? NSDictionary,
      let rect = CGRect(dictionaryRepresentation: bounds), rect.contains(point),
      (window[kCGWindowAlpha as String] as? Double ?? 1) > 0,
      let pid = window[kCGWindowOwnerPID as String] as? pid_t
    else { continue }
    return (
      pid, window[kCGWindowOwnerName as String] as? String ?? "",
      window[kCGWindowLayer as String] as? Int ?? 0
    )
  }
  return nil
}

enum Reach {
  case yes
  /// Another element is on top at that point. `by` says which.
  case no(by: String)
  /// The operating system did not answer. Nothing is known about the element.
  case unknown(code: Int)
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
    let v = values(top)
    let role = v.flatMap { text($0[0]) } ?? "element"
    let name = v.flatMap { text($0[2]) ?? text($0[3]) } ?? ""
    var owner: pid_t = 0
    AXUIElementGetPid(top, &owner)
    let app = NSRunningApplication(processIdentifier: owner)?.localizedName ?? "pid \(owner)"
    let front = windowOwner(at: CGPoint(x: rect.midX, y: rect.midY))
    let server = front.map { "; front window: \($0.name) layer \($0.layer)" } ?? "; front window: none"
    return .no(by: "\(role) \"\(name)\" of \(app)\(server)")
  }
  return .unknown(code: Int(code.rawValue))
}

/// Key codes of the ANSI keyboard. A letter here is the key at that place, for a shortcut.
let keyCodes: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53, "backspace": 51, "delete": 117,
  "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126, "home": 115, "end": 119,
  "pageup": 116, "pagedown": 121,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
  "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38,
  "k": 40, "n": 45, "m": 46,
]
let modifierFlags: [String: CGEventFlags] = [
  "meta": .maskCommand, "shift": .maskShift, "alt": .maskAlternate, "control": .maskControl,
]

let args = CommandLine.arguments
guard args.count >= 3, let pid = Int32(args[2]) else {
  emit(["error": "usage"])
}
guard AXIsProcessTrusted() else {
  emit(["error": "not-trusted"])
}
let app = AXUIElementCreateApplication(pid)

if args[1] == "tree" {
  let started = Date()
  let shot = snapshot(app)
  emit([
    "tree": shot.tree, "unread": shot.unread,
    "readMs": Int(Date().timeIntervalSince(started) * 1000),
  ])
}

guard args[1] == "act", args.count >= 7 else {
  emit(["error": "usage"])
}
let path = args[3].split(separator: ".").compactMap { Int($0) }
let action = args[6]
let value = args.count > 7 ? args[7] : ""
let budgetMs = args.count > 8 ? Int(args[8]) ?? 1000 : 1000
let direct = args.count > 9 && args[9] == "direct"
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
    emit(["refused": "stale", "detail": "no element at the path"])
  }
  target = next
}
guard let now = values(target) else {
  emit(["refused": "stale", "detail": "the element does not answer"])
}
let nameNow = [text(now[2]), text(now[3])].compactMap { $0 }.first { !$0.isEmpty } ?? ""
guard text(now[0]) == args[4], nameNow == args[5] else {
  emit(["refused": "stale", "detail": "a different element is at the path"])
}
if let enabled = now[5] as? Bool, !enabled {
  emit(["refused": "disabled"])
}

let before = snapshot(app)
let filesBefore = filesNow()
var canReach = false
var coveredBy = ""
switch frame(now[7], now[8]).map({ reach(target, $0) }) ?? .unknown(code: -1) {
case .yes: canReach = true
case .no(let by):
  coveredBy = by
  if !direct { emit(["refused": "unreachable", "detail": by]) }
case .unknown(let code):
  if !direct { emit(["refused": "reach-unknown", "detail": "the hit test failed with \(code)"]) }
}

let started = Date()
let result: AXError
switch action {
case "press": result = AXUIElementPerformAction(target, kAXPressAction as CFString)
case "set":
  result = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, value as CFString)
case "type":
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
      event.postToPid(pid)
    }
    usleep(4000)
  }
  result = .success
case "key":
  // One key, with its modifiers: "Return", "Tab", "Meta+s". Sent to the application, as "type" is.
  let parts = value.split(separator: "+").map(String.init)
  guard let name = parts.last, let code = keyCodes[name.lowercased()] else {
    emit(["error": "unknown-key"])
  }
  var flags: CGEventFlags = []
  for modifier in parts.dropLast() {
    guard let flag = modifierFlags[modifier.lowercased()] else { emit(["error": "unknown-key"]) }
    flags.insert(flag)
  }
  _ = AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  let source = CGEventSource(stateID: .hidSystemState)
  for down in [true, false] {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else {
      continue
    }
    event.flags = flags
    event.postToPid(pid)
  }
  result = .success
default: emit(["error": "unknown-action"])
}

// Wait for the application to finish. Notifications from AXObserver are not dependable from one
// application to the next, and a read is cheap, so read again until two reads in a row agree.
// When nothing has changed, spend the whole budget: an early "nothing changed" is a false result
// for every effect that takes longer than the first read.
var last = before.json
var lastFiles = filesBefore
var after = before
var stable = 0
func elapsedMs() -> Int { Int(Date().timeIntervalSince(started) * 1000) }
while elapsedMs() < budgetMs {
  Thread.sleep(forTimeInterval: 0.025)
  after = snapshot(app)
  let files = filesNow()
  stable = after.json == last && files == lastFiles ? stable + 1 : 0
  last = after.json
  lastFiles = files
  if stable >= 2 && (after.json != before.json || files != filesBefore) { break }
}

emit([
  "delivered": result == .success, "axError": Int(result.rawValue), "reachable": canReach,
  "coveredBy": coveredBy,
  "settled": stable >= 2, "waitedMs": elapsedMs(), "budgetMs": budgetMs,
  "before": before.tree, "after": after.tree, "unreadBefore": before.unread,
  "unreadAfter": after.unread,
])
