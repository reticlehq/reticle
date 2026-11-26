// The photo that photocheck.mjs edits: a blue gradient with a white disc, 600 x 400. Every pixel
// of it has much blue, so a stroke of another colour shows as pixels with little blue.
//   photo <path>                 writes the photo.
//   photo <path> --count-unlike  prints how many pixels of the photo at <path> have little blue.
import AppKit

let path = CommandLine.arguments[1]
if CommandLine.arguments.count > 2 {
  guard let rep = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: path))) else {
    print(-1)
    exit(1)
  }
  var dark = 0
  for y in 0..<rep.pixelsHigh {
    for x in 0..<rep.pixelsWide {
      guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
      if c.blueComponent < 0.45 && c.alphaComponent > 0.5 {
        dark += 1
      }
    }
  }
  print(dark)
  exit(0)
}
let width = 600
let height = 400
guard
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)
else { exit(1) }
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGradient(starting: .systemTeal, ending: .systemIndigo)?.draw(
  in: NSRect(x: 0, y: 0, width: width, height: height), angle: 30)
NSColor.white.setFill()
NSBezierPath(ovalIn: NSRect(x: 250, y: 150, width: 100, height: 100)).fill()
try rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
