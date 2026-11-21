// reticle-ax: reads and drives one macOS application through the Accessibility API.
//
//   reticle-ax tree <pid>
//   reticle-ax reach <pid> <path> <role> <name>
//   reticle-ax act  <pid> <path> <role> <name> press|set|type|key [value] [budgetMs] [user-path|direct][:quietMs] [folder...]
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
//   reticle-ax serve      (one command for each line on standard input, as a JSON list of words)
import AppKit
import ApplicationServices
import Foundation
import Security

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
  if role == "AXMenuBar" && !menuBarOnScreen {
    children = []
    if let r = frame(v[7], v[8]) { node["frame"] = [r.origin.x, r.origin.y, 0, 0] }
  }
  if role == "AXTable" || role == "AXOutline" {
    var visible: AnyObject?
    if AXUIElementCopyAttributeValue(element, kAXVisibleRowsAttribute as CFString, &visible)
      == .success, let rows = visible as? [AXUIElement]
    {
      let all = children
      let found = rows.compactMap { row in all.firstIndex { CFEqual($0, row) } }
      places = found
      children = found.map { all[$0] }
      // The rows that are not on the screen. The columns are left out too, and they are not
      // counted: they hold the same cells a second time, so nothing in them is hidden.
      var every: AnyObject?
      let total =
        AXUIElementCopyAttributeValue(element, kAXRowsAttribute as CFString, &every) == .success
        ? (every as? [AXUIElement])?.count ?? children.count : children.count
      node["notShown"] = max(0, total - children.count)
    }
  }
  var kids: [[String: Any]] = []
  for (order, child) in children.enumerated() {
    var one = readElement(child, depth + 1, &unread)
    if let places { one["i"] = places[order] }
    kids.append(one)
  }
  node["children"] = kids
  return node
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

func snapshot(_ app: AXUIElement) -> (tree: [String: Any], unread: Int, json: Data) {
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
]
let modifierFlags: [String: CGEventFlags] = [
  "meta": .maskCommand, "shift": .maskShift, "alt": .maskAlternate, "control": .maskControl,
]

/// One command: `args` are the words of a command line, the program name first.
/// The process is there. A process that ended and was not yet collected by its parent still has
/// its number, so the list of running applications is asked too.
func isRunning(_ pid: pid_t) -> Bool {
  if kill(pid, 0) != 0 && errno == ESRCH { return false }
  return NSRunningApplication(processIdentifier: pid) != nil
}

func run(_ args: [String]) throws {
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
  let app = AXUIElementCreateApplication(pid)

  if args[1] == "web-tree" {
    // An Electron application gives its tree with no switch, and then does nothing for a press:
    // the press is answered with "done" and the page never gets it. With this attribute on, the
    // press works. It is the attribute that Electron documents for a tool that is not a screen
    // reader. It costs the application some speed, so it is set only when the person asks, and
    // set back when the realm leaves.
    let on = args.count > 3 && args[3] == "on"
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
    readBefore.remove(pid)
    // The switch is not in effect at once. For some seconds the application gives the same tree
    // as before, answers "done" to a press, and loses the press. When the switch is in effect the
    // tree is another one (a heading gets its level, for one). So wait until the tree has changed
    // and two reads agree, for five seconds at most. With no change in that time, the tree was
    // the full one already.
    if on && result == .success {
      var last = before
      var changed = false
      for _ in 0..<34 {
        Thread.sleep(forTimeInterval: 0.15)
        let now = snapshot(app).json
        if now != before { changed = true }
        if changed && now == last { break }
        last = now
      }
    }
    try emit(["set": result == .success])
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
  guard let now = values(target) else {
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
  if let enabled = now[5] as? Bool, !enabled {
    try emit(["refused": "disabled"])
  }

  let before = snapshot(app)
  let filesBefore = filesNow()
  let writtenBefore = bytesWritten(pid)
  let settingsBefore = settings(pid)
  let clipboardBefore = clipboard.changeCount
  var canReach = false
  var coveredBy = ""
  switch frame(now[7], now[8]).map({ reach(target, $0) }) ?? .unknown(code: -1) {
  case .yes: canReach = true
  case .no(let by):
    coveredBy = by
    if !direct { try emit(["refused": "unreachable", "detail": by]) }
  case .unknown(let code):
    if !direct { try emit(["refused": "reach-unknown", "detail": "the hit test failed with \(code)"]) }
  }

  let started = Date()
  let result: AXError
  switch action {
  case "press":
    let pressed = AXUIElementPerformAction(target, kAXPressAction as CFString)
    // A row of a table has no press. A click on it chooses it, so choose it.
    result =
      pressed == .actionUnsupported
      ? AXUIElementSetAttributeValue(target, kAXSelectedAttribute as CFString, kCFBooleanTrue)
      : pressed
  case "set":
    // An element whose value is a number (a slider, a scroll bar) takes a number, not its text.
    let number = now[4] is NSNumber ? Double(value).map { NSNumber(value: $0) } : nil
    result = AXUIElementSetAttributeValue(
      target, kAXValueAttribute as CFString, number ?? (value as CFString))
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
      try emit(["error": "unknown-key"])
    }
    var flags: CGEventFlags = []
    for modifier in parts.dropLast() {
      guard let flag = modifierFlags[modifier.lowercased()] else { try emit(["error": "unknown-key"]) }
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
    .merging(["clipboardChanged": clipboard.changeCount != clipboardBefore]) { $1 })
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
