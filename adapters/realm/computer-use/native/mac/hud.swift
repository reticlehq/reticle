// reticle-hud: what the person at the machine sees of the realm.
//
//   - A pointer of the realm's own: an arrow, as a mouse has, in the colour of Reticle. It goes
//     to the element the realm acts on, and a ring spreads from its tip when the realm acts. The
//     pointer of the person does not move for an action in the background, so without this
//     nothing on the screen says where the realm is.
//   - The HUD, as in a browser. At rest it is one circle with the mark and a ring in the colour
//     of the state. A press opens it: a panel with the mark and the name, a row with the dot of
//     the state, the action that runs, and the buttons to pause and to stop, the last actions with
//     what each one did, and a toolbar under it. The same parts, in the same places, as in a browser.
//
// The program draws and reports. It never reads an application and never acts on one.
//
// One line of JSON on standard input for each thing to show:
//   {"t":"app","name":"Notes"}
//   {"t":"move","x":120,"y":300}          the middle of the element, in points from the top left
//   {"t":"act","text":"press button \"Save\""}
//   {"t":"effect","text":"2 changes","kind":"ok"}      kind: ok | none | refused
//   {"t":"glow","x":80,"y":80,"w":450,"h":320}   a ring round the window the realm works in
//   {"t":"hide"}                          the pointer goes away
// One line on standard output when the person presses a button: {"paused":true} or false for
// the pause, and {"stopped":true} for the stop. After a stop the realm leaves the application.
// The program ends when standard input closes.
import AppKit

func hex(_ value: UInt32, _ alpha: CGFloat = 1) -> NSColor {
  NSColor(
    srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
    blue: CGFloat(value & 0xff) / 255, alpha: alpha)
}

/// The design values, in one place. They are the tokens of the HUD in the browser
/// (`presenter-design-tokens.ts`, `presenter-shell-styles.ts`): the same ground, text, brand
/// colour, state colours, radii, sizes and motion.
enum Token {
  static let ground = hex(0x0b0b0c)
  static let surface = hex(0x151417, 0.9)
  static let hover = hex(0xffffff, 0.12)
  static let border = hex(0x3a3941)
  static let text = hex(0xf5f3ef)
  static let muted = hex(0xa6a29a)
  static let faint = hex(0x8b867d)
  static let brand = hex(0xf0872e)
  static let active = hex(0x3b82f6)
  static let idle = hex(0xeab308)
  static let ended = hex(0xef4444)
  static let radiusLarge: CGFloat = 14
  static let space1: CGFloat = 4
  static let space2: CGFloat = 8
  static let space3: CGFloat = 12
  static let edge: CGFloat = 20
  static let extraSmall = NSFont.systemFont(ofSize: 11, weight: .regular)
  static let small = NSFont.systemFont(ofSize: 12, weight: .regular)
  static let base = NSFont.systemFont(ofSize: 13, weight: .semibold)
  static let dockWidth: CGFloat = 320
  static let toolbarHeight: CGFloat = 44
  static let control: CGFloat = 36
  static let rowHeight: CGFloat = 34
  static let rows = 4
  static let fab: CGFloat = 44
  static let headerHeight: CGFloat = 40
  static let statusHeight: CGFloat = 38
  static let square: CGFloat = 26
  static let radiusSmall: CGFloat = 6
  static let wash = 0.18
  static let glide = 0.32
  static let ease = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
  static let ripple = 0.45
  static let pointerRest = 4.0
  static let glowDepth = 22
  static let glowIn = 0.25
  static let glowRest = 1.4
  static let pointerBox: CGFloat = 64
  /// The tip of the arrow, from the top left of its box: the ring spreads from here.
  static let tip = NSPoint(x: 20, y: 20)
}

/// The arrow of a mouse, in the colour of Reticle, with a light edge and a soft shadow. A ring
/// spreads from its tip when the realm acts, as the ripple does in a browser.
final class ArrowView: NSView {
  var ring: CGFloat = 0 { didSet { needsDisplay = true } }
  var ringColor = Token.text
  override var isFlipped: Bool { true }
  override func draw(_ dirtyRect: NSRect) {
    let tip = Token.tip
    if ring > 0 {
      let reach = 6 + ring * 18
      ringColor.withAlphaComponent(0.55 * (1 - ring)).setStroke()
      let circle = NSBezierPath(
        ovalIn: NSRect(x: tip.x - reach, y: tip.y - reach, width: reach * 2, height: reach * 2))
      circle.lineWidth = 2
      circle.stroke()
    }
    // The outline of a pointer: the tip, down the left edge, the notch, the tail, and back.
    let shape: [(CGFloat, CGFloat)] = [
      (0, 0), (0, 21), (5.6, 16), (9.4, 24.6), (13, 23), (9.2, 14.6), (16.4, 14.6),
    ]
    let arrow = NSBezierPath()
    for (index, point) in shape.enumerated() {
      let at = NSPoint(x: tip.x + point.0, y: tip.y + point.1)
      if index == 0 { arrow.move(to: at) } else { arrow.line(to: at) }
    }
    arrow.close()
    arrow.lineJoinStyle = .round
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.45)
    shadow.shadowBlurRadius = 5
    shadow.shadowOffset = NSSize(width: 0, height: -2)
    shadow.set()
    Token.brand.setFill()
    arrow.fill()
    NSGraphicsContext.restoreGraphicsState()
    Token.text.setStroke()
    arrow.lineWidth = 1.6
    arrow.stroke()
  }
}

/// The glow round the window the realm works in, as the glow at the edge of a page in a
/// browser: a thin ring and a soft light inside it, in the colour of the state.
final class GlowView: NSView {
  var color = Token.active { didSet { needsDisplay = true } }
  override func draw(_ dirtyRect: NSRect) {
    let corner = Token.radiusLarge - 4
    // The soft light: rings that fade toward the inside.
    for step in 0..<Token.glowDepth {
      let inset = CGFloat(step) + 1
      let part = 1 - CGFloat(step) / CGFloat(Token.glowDepth)
      color.withAlphaComponent(0.26 * part * part).setStroke()
      let ring = NSBezierPath(
        roundedRect: bounds.insetBy(dx: inset, dy: inset), xRadius: corner, yRadius: corner)
      ring.lineWidth = 1
      ring.stroke()
    }
    color.withAlphaComponent(0.7).setStroke()
    let edge = NSBezierPath(
      roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: corner, yRadius: corner)
    edge.lineWidth = 2
    edge.stroke()
  }
}

/// A picture that is only a picture: a click goes through it to the button it lies on, and it is
/// no element of its own. The mark on the circle took the click of a person, and the circle did
/// not open.
final class Picture: NSImageView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func isAccessibilityElement() -> Bool { false }
}

/// A round button of the toolbar: clear, and lighter under the pointer.
final class RoundButton: NSButton {
  override func updateTrackingAreas() {
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(
      NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self))
  }
  override func mouseEntered(with event: NSEvent) { layer?.backgroundColor = Token.hover.cgColor }
  override func mouseExited(with event: NSEvent) { layer?.backgroundColor = NSColor.clear.cgColor }
}

/// An icon of the HUD, drawn as lines in the colour of the text.
func icon(_ size: CGFloat, _ draw: @escaping (NSBezierPath) -> Void, fill: Bool = false) -> NSImage {
  NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
    let path = NSBezierPath()
    path.lineWidth = 1.5
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    draw(path)
    if fill {
      Token.text.setFill()
      path.fill()
    } else {
      Token.text.setStroke()
      path.stroke()
    }
    return true
  }
}

final class Hud: NSObject, NSApplicationDelegate {
  var pointer: NSWindow!
  let arrow = ArrowView(
    frame: NSRect(x: 0, y: 0, width: Token.pointerBox, height: Token.pointerBox))
  var glow: NSWindow!
  let glowView = GlowView()
  var glowRest: Timer?
  var panel: NSPanel!
  // At rest: the circle. Open: the panel and the toolbar.
  let fabHolder = NSView()
  let dockHolder = NSView()
  var fab: RoundButton!
  let card = NSView()
  let wash = CAGradientLayer()
  let dot = NSView()
  let doing = NSTextField(labelWithString: "Ready")
  let app = NSTextField(labelWithString: "")
  var pause: RoundButton!
  var stop: RoundButton!
  var empty: [NSTextField] = []
  var log: [(action: NSTextField, effect: NSTextField)] = []
  var lines: [(action: String, effect: String, kind: String)] = []
  var state = Token.idle
  var open = false
  var paused = false
  var stopped = false
  var rest: Timer?
  var rippling: Timer?

  /// The colour of the state: the realm acts, the realm waits or is paused, the action was refused.
  func setState(_ color: NSColor) {
    state = color
    dot.layer?.backgroundColor = color.cgColor
    fab.layer?.borderColor = color.withAlphaComponent(0.85).cgColor
    fab.layer?.shadowColor = color.cgColor
    card.layer?.borderColor = color.blended(withFraction: 0.6, of: Token.border)?.cgColor
    wash.colors = [
      (Token.ground.blended(withFraction: Token.wash, of: color) ?? Token.ground).cgColor,
      Token.ground.cgColor,
    ]
  }

  func text(_ field: NSTextField, _ font: NSFont, _ color: NSColor, _ frame: NSRect, in view: NSView) {
    field.font = font
    field.textColor = color
    field.frame = frame
    field.lineBreakMode = .byTruncatingTail
    view.addSubview(field)
  }

  func round(_ title: String, _ image: NSImage, _ frame: NSRect, _ action: Selector, in view: NSView)
    -> RoundButton
  {
    let button = RoundButton(title: "", target: self, action: action)
    button.isBordered = false
    button.wantsLayer = true
    button.image = image
    button.frame = frame
    button.layer?.cornerRadius = min(frame.width, frame.height) / 2
    button.setAccessibilityLabel(title)
    view.addSubview(button)
    return button
  }

  /// The place of the window: the corner at the bottom right, as in a browser. The circle and
  /// the open HUD keep the same corner.
  func place() {
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
    let size = open ? dockHolder.frame.size : fabHolder.frame.size
    let right = panel.frame.width > 0 ? panel.frame.maxX : screen.maxX - Token.edge
    let bottom = panel.frame.height > 0 ? panel.frame.minY : screen.minY + Token.edge
    panel.setFrame(
      NSRect(x: right - size.width, y: bottom, width: size.width, height: size.height),
      display: true)
    fabHolder.isHidden = open
    dockHolder.isHidden = !open
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // The pointer: over every window, and a click goes through it to what is under it.
    pointer = NSWindow(
      contentRect: arrow.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    pointer.isOpaque = false
    pointer.backgroundColor = .clear
    pointer.hasShadow = false
    pointer.ignoresMouseEvents = true
    pointer.level = .screenSaver
    pointer.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    pointer.contentView = arrow
    pointer.alphaValue = 0

    // The glow: a window with nothing in it but the ring, and a click goes through it.
    glow = NSWindow(
      contentRect: .zero, styleMask: [.borderless], backing: .buffered, defer: false)
    glow.isOpaque = false
    glow.backgroundColor = .clear
    glow.hasShadow = false
    glow.ignoresMouseEvents = true
    glow.level = .floating
    glow.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    glow.contentView = glowView
    glow.alphaValue = 0

    // The HUD. It floats, it never takes the keyboard, and the person can move it.
    panel = NSPanel(
      contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered,
      defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.level = .floating
    panel.isMovableByWindowBackground = true
    panel.collectionBehavior = [.canJoinAllSpaces, .ignoresCycle, .fullScreenAuxiliary]
    let root = NSView()
    panel.contentView = root
    root.addSubview(fabHolder)
    root.addSubview(dockHolder)

    // At rest: one circle, with room round it for its light.
    let room: CGFloat = 12
    fabHolder.frame = NSRect(x: 0, y: 0, width: Token.fab + room * 2, height: Token.fab + room * 2)
    fab = round(
      "Open Reticle", NSImage(), NSRect(x: room, y: room, width: Token.fab, height: Token.fab),
      #selector(toggleOpen), in: fabHolder)
    fab.layer?.backgroundColor = Token.ground.cgColor
    fab.layer?.borderWidth = 1.5
    fab.layer?.shadowOpacity = 0.75
    fab.layer?.shadowRadius = 8
    fab.layer?.shadowOffset = .zero
    fab.layer?.masksToBounds = false
    // The mark is a file beside the source of this program: the same paths as in the browser.
    let markFile = URL(fileURLWithPath: CommandLine.arguments[0])
      .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(
        "reticle-mark.svg")
    let markImage = NSImage(contentsOf: markFile)
    func mark(_ frame: NSRect, in view: NSView) {
      let image = Picture(frame: frame)
      image.image = markImage
      image.imageScaling = .scaleProportionallyUpOrDown
      view.addSubview(image)
    }
    mark(fab.bounds.insetBy(dx: 11, dy: 11), in: fab)

    // Open: the card, and the toolbar under it.
    let logHeight = CGFloat(Token.rows) * Token.rowHeight + Token.space2 * 2
    let cardHeight = Token.headerHeight + Token.statusHeight + logHeight
    dockHolder.frame = NSRect(
      x: 0, y: 0, width: Token.dockWidth,
      height: cardHeight + Token.space2 + Token.toolbarHeight)
    card.frame = NSRect(
      x: 0, y: Token.toolbarHeight + Token.space2, width: Token.dockWidth, height: cardHeight)
    card.wantsLayer = true
    card.layer?.cornerRadius = Token.radiusLarge
    card.layer?.borderWidth = 1
    card.layer?.masksToBounds = true
    wash.frame = card.bounds
    wash.startPoint = CGPoint(x: 0.5, y: 1)
    wash.endPoint = CGPoint(x: 0.5, y: 0.35)
    card.layer?.addSublayer(wash)
    dockHolder.addSubview(card)

    func rule(_ y: CGFloat) {
      let line = NSView(frame: NSRect(x: 0, y: y, width: Token.dockWidth, height: 1))
      line.wantsLayer = true
      line.layer?.backgroundColor = Token.hover.cgColor
      card.addSubview(line)
    }

    // The header: the mark, the name, the application, and the sign that closes the HUD.
    let headerY = cardHeight - Token.headerHeight
    mark(NSRect(x: Token.space3, y: headerY + 12, width: 16, height: 16), in: card)
    text(
      NSTextField(labelWithString: "Reticle"), Token.base, Token.text,
      NSRect(x: 36, y: headerY + 11, width: 56, height: 18), in: card)
    text(app, Token.small, Token.muted, NSRect(x: 92, y: headerY + 11, width: 170, height: 17), in: card)
    _ = round(
      "Hide",
      icon(16) { path in
        path.move(to: NSPoint(x: 3.5, y: 10))
        path.line(to: NSPoint(x: 8, y: 5.5))
        path.line(to: NSPoint(x: 12.5, y: 10))
      },
      NSRect(x: Token.dockWidth - 36, y: headerY + 7, width: Token.square, height: Token.square),
      #selector(toggleOpen), in: card)
    rule(headerY)

    // The row of the state: the dot, the action that runs, and the two buttons.
    let statusY = headerY - Token.statusHeight
    dot.frame = NSRect(x: Token.space3, y: statusY + 15, width: 8, height: 8)
    dot.wantsLayer = true
    dot.layer?.cornerRadius = 4
    card.addSubview(dot)
    text(
      doing, Token.small, Token.text,
      NSRect(x: 28, y: statusY + 10, width: Token.dockWidth - 28 - 76, height: 17), in: card)
    func square(_ title: String, _ image: NSImage, _ x: CGFloat, _ action: Selector) -> RoundButton {
      let button = round(
        title, image, NSRect(x: x, y: statusY + 6, width: Token.square, height: Token.square),
        action, in: card)
      button.layer?.cornerRadius = Token.radiusSmall
      button.layer?.borderWidth = 1
      button.layer?.borderColor = Token.hover.cgColor
      return button
    }
    pause = square("Pause", NSImage(), Token.dockWidth - 68, #selector(togglePause))
    stop = square(
      "Stop",
      icon(14) { path in
        path.appendRoundedRect(NSRect(x: 3.5, y: 3.5, width: 7, height: 7), xRadius: 1.5, yRadius: 1.5)
      }, Token.dockWidth - 36, #selector(pressStop))
    setPauseSign()
    rule(statusY)

    // The last actions, the newest at the bottom, each with what it did. Before the first
    // action: what this window is for, as the panel in a browser says it.
    for row in 0..<Token.rows {
      let y = Token.space2 + CGFloat(Token.rows - 1 - row) * Token.rowHeight
      let action = NSTextField(labelWithString: "")
      let effect = NSTextField(labelWithString: "")
      text(
        action, Token.small, Token.text,
        NSRect(x: Token.space3, y: y + 15, width: Token.dockWidth - Token.space3 * 2, height: 16),
        in: card)
      text(
        effect, Token.extraSmall, Token.muted,
        NSRect(x: Token.space3, y: y + 1, width: Token.dockWidth - Token.space3 * 2, height: 14),
        in: card)
      log.append((action, effect))
    }
    for (index, words) in [
      "Reticle works in this application from the outside.",
      "Each action of your agent shows here, live,",
      "with what it changed.",
    ].enumerated() {
      let line = NSTextField(labelWithString: words)
      line.alignment = .center
      text(
        line, index == 0 ? Token.base : Token.small, index == 0 ? Token.text : Token.muted,
        NSRect(
          x: Token.space3, y: logHeight / 2 + 14 - CGFloat(index) * 20,
          width: Token.dockWidth - Token.space3 * 2, height: 18),
        in: card)
      empty.append(line)
    }

    // The toolbar: a pill, as in a browser. It has the parts this HUD has: the log, and Hide.
    let bar = NSView(
      frame: NSRect(x: 0, y: 0, width: Token.dockWidth, height: Token.toolbarHeight))
    bar.wantsLayer = true
    bar.layer?.backgroundColor = Token.ground.cgColor
    bar.layer?.cornerRadius = Token.toolbarHeight / 2
    bar.layer?.borderWidth = 1
    bar.layer?.borderColor = Token.border.cgColor
    dockHolder.addSubview(bar)
    func tab(_ title: String, _ image: NSImage, _ x: CGFloat, _ action: Selector?, active: Bool) {
      let holder = NSView(frame: NSRect(x: x, y: 2, width: 64, height: Token.toolbarHeight - 4))
      bar.addSubview(holder)
      let button = round(
        title, image, NSRect(x: 20, y: 16, width: 24, height: 22), action ?? #selector(noop),
        in: holder)
      button.layer?.cornerRadius = Token.radiusSmall
      let name = NSTextField(labelWithString: title)
      name.alignment = .center
      text(
        name, Token.extraSmall, active ? Token.text : Token.muted,
        NSRect(x: 0, y: 4, width: 64, height: 13), in: holder)
      if active {
        let under = NSView(frame: NSRect(x: 24, y: 0, width: 16, height: 2))
        under.wantsLayer = true
        under.layer?.backgroundColor = Token.text.cgColor
        under.layer?.cornerRadius = 1
        holder.addSubview(under)
      }
    }
    tab(
      "Log",
      icon(18) { path in
        path.appendRoundedRect(NSRect(x: 2.5, y: 5, width: 13, height: 9.5), xRadius: 3, yRadius: 3)
        path.move(to: NSPoint(x: 6, y: 5))
        path.line(to: NSPoint(x: 5, y: 2.5))
        path.line(to: NSPoint(x: 9, y: 5))
      }, Token.space3, nil, active: true)
    tab(
      "Hide",
      icon(18) { path in
        path.move(to: NSPoint(x: 4.5, y: 4.5))
        path.line(to: NSPoint(x: 13.5, y: 13.5))
        path.move(to: NSPoint(x: 13.5, y: 4.5))
        path.line(to: NSPoint(x: 4.5, y: 13.5))
      }, Token.dockWidth - 64 - Token.space3, #selector(toggleOpen), active: false)

    redraw()
    setState(Token.idle)
    place()
    panel.orderFrontRegardless()

    // One line of JSON for each thing to show. Read off the main thread; draw on it.
    Thread.detachNewThread {
      while let line = readLine() {
        guard let data = line.data(using: .utf8),
          let say = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { continue }
        DispatchQueue.main.async { self.show(say) }
      }
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
  }

  @objc func noop() {}

  /// The circle opens the HUD, and the sign in the header or Hide in the toolbar closes it.
  @objc func toggleOpen() {
    open.toggle()
    place()
  }

  /// The sign on the button: two bars to pause, a triangle to go on.
  func setPauseSign() {
    let isPaused = paused
    pause.image = icon(14, { path in
      if isPaused {
        path.move(to: NSPoint(x: 4.5, y: 3))
        path.line(to: NSPoint(x: 11, y: 7))
        path.line(to: NSPoint(x: 4.5, y: 11))
        path.close()
      } else {
        path.move(to: NSPoint(x: 5, y: 3.5))
        path.line(to: NSPoint(x: 5, y: 10.5))
        path.move(to: NSPoint(x: 9, y: 3.5))
        path.line(to: NSPoint(x: 9, y: 10.5))
      }
    })
    pause.setAccessibilityLabel(paused ? "Resume" : "Pause")
  }

  func redraw() {
    let shown = Array(lines.suffix(Token.rows))
    empty.forEach { $0.isHidden = !lines.isEmpty }
    for (row, fields) in log.enumerated() {
      let line = row < shown.count ? shown[row] : ("", "", "none")
      let newest = row == shown.count - 1
      fields.action.stringValue = line.0
      fields.action.textColor = newest ? Token.text : Token.muted
      fields.effect.stringValue = line.1
      fields.effect.textColor =
        line.2 == "refused" ? Token.ended : (line.2 == "ok" ? Token.text : Token.faint)
    }
  }

  @objc func togglePause() {
    guard !stopped else { return }
    paused.toggle()
    setPauseSign()
    doing.stringValue = paused ? "Paused by you" : "Ready"
    setState(Token.idle)
    print(paused ? "{\"paused\":true}" : "{\"paused\":false}")
    fflush(stdout)
  }

  @objc func pressStop() {
    guard !stopped else { return }
    stopped = true
    stop.isEnabled = false
    pause.isEnabled = false
    doing.stringValue = "Stopped by you"
    setState(Token.ended)
    pointer.animator().alphaValue = 0
    glow.animator().alphaValue = 0
    print("{\"stopped\":true}")
    fflush(stdout)
  }

  /// A ring that spreads from the tip of the pointer, once.
  func ripple(_ color: NSColor) {
    rippling?.invalidate()
    arrow.ringColor = color
    let started = Date()
    rippling = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { timer in
      let part = CGFloat(Date().timeIntervalSince(started) / Token.ripple)
      self.arrow.ring = part >= 1 ? 0 : max(part, 0.01)
      if part >= 1 { timer.invalidate() }
    }
  }

  func show(_ say: [String: Any]) {
    switch say["t"] as? String {
    case "app":
      app.stringValue = say["name"] as? String ?? ""
    case "move":
      guard let x = say["x"] as? Double, let y = say["y"] as? Double else { return }
      // The realm gives points from the top left. AppKit counts from the bottom left.
      let top = NSScreen.screens.first?.frame.height ?? 0
      let target = NSPoint(x: x, y: top - y)
      // The HUD must not lie over what the realm acts on: the realm presses only what a person
      // could press, and it would refuse a control that is under the HUD. So the HUD goes to the
      // other side of the screen when the target is under it.
      if panel.frame.insetBy(dx: -Token.space3, dy: -Token.space3).contains(target),
        let screen = NSScreen.main?.visibleFrame
      {
        let left = panel.frame.midX > screen.midX
        panel.setFrameOrigin(
          NSPoint(
            x: left ? screen.minX + Token.edge : screen.maxX - panel.frame.width - Token.edge,
            y: panel.frame.origin.y))
      }
      // The tip of the arrow goes to the target.
      let to = NSPoint(x: target.x - Token.tip.x, y: target.y - (Token.pointerBox - Token.tip.y))
      pointer.orderFrontRegardless()
      NSAnimationContext.runAnimationGroup { move in
        move.duration = pointer.alphaValue > 0 ? Token.glide : 0
        move.timingFunction = Token.ease
        pointer.animator().setFrameOrigin(to)
        pointer.animator().alphaValue = 1
      }
      rest?.invalidate()
      rest = Timer.scheduledTimer(withTimeInterval: Token.pointerRest, repeats: false) { _ in
        self.pointer.animator().alphaValue = 0
      }
    case "glow":
      guard !paused, !stopped, let x = say["x"] as? Double, let y = say["y"] as? Double,
        let w = say["w"] as? Double, let h = say["h"] as? Double
      else { return }
      let top = NSScreen.screens.first?.frame.height ?? 0
      glow.setFrame(NSRect(x: x, y: top - y - h, width: w, height: h), display: true)
      glowView.color = Token.active
      glow.orderFrontRegardless()
      NSAnimationContext.runAnimationGroup { fade in
        fade.duration = Token.glowIn
        glow.animator().alphaValue = 1
      }
      glowRest?.invalidate()
    case "act":
      guard !paused, !stopped else { return }
      let words = say["text"] as? String ?? ""
      doing.stringValue = words
      lines.append((words, "…", "none"))
      redraw()
      setState(Token.active)
      ripple(Token.text)
    case "effect":
      guard !lines.isEmpty else { return }
      let kind = say["kind"] as? String ?? "none"
      lines[lines.count - 1].effect = say["text"] as? String ?? ""
      lines[lines.count - 1].kind = kind
      redraw()
      setState(kind == "refused" ? Token.ended : Token.idle)
      if kind == "refused" { ripple(Token.ended) }
      // The glow says what the action did, and then goes: it lies over the application of the
      // person, so it does not stay.
      glowView.color = kind == "refused" ? Token.ended : Token.active
      glowRest?.invalidate()
      glowRest = Timer.scheduledTimer(withTimeInterval: Token.glowRest, repeats: false) { _ in
        NSAnimationContext.runAnimationGroup { fade in
          fade.duration = Token.glowIn * 2
          self.glow.animator().alphaValue = 0
        }
      }
    case "open":
      // For a check, and for a person who wants the HUD open from the start.
      if !open { toggleOpen() }
    case "hide":
      pointer.animator().alphaValue = 0
    default: break
    }
  }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let hud = Hud()
application.delegate = hud
application.run()
