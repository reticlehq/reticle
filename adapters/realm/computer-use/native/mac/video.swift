// The clip that videocheck.mjs edits, with what macOS has: no ffmpeg.
//   video <path.mov>              writes a 10-second clip, 640 x 360, 30 frames a second.
//   video <path> --seconds        prints how long the movie at <path> is, in seconds.
import AVFoundation
import AppKit

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)

func wait<T>(_ work: @escaping () async -> T?) -> T? {
  let done = DispatchSemaphore(value: 0)
  var out: T?
  Task {
    out = await work()
    done.signal()
  }
  done.wait()
  return out
}

if CommandLine.arguments.count > 2 {
  let seconds = wait { try? await AVURLAsset(url: url).load(.duration).seconds } ?? -1
  print(seconds)
  exit(0)
}

let width = 640
let height = 360
let fps: Int32 = 30
guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mov) else { exit(1) }
let input = AVAssetWriterInput(
  mediaType: .video,
  outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
  ])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
  assetWriterInput: input,
  sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
  ])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)
for frame in 0..<(10 * Int(fps)) {
  while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.005) }
  guard let pool = adaptor.pixelBufferPool else { exit(1) }
  var made: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, pool, &made)
  guard let buffer = made else { exit(1) }
  CVPixelBufferLockBaseAddress(buffer, [])
  // Each second has its own colour, and a bar moves across: a frame shows where in the clip it is.
  let context = CGContext(
    data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8,
    bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
  let second = frame / Int(fps)
  context?.setFillColor(
    NSColor(hue: CGFloat(second) / 10, saturation: 0.7, brightness: 0.9, alpha: 1).cgColor)
  context?.fill(CGRect(x: 0, y: 0, width: width, height: height))
  context?.setFillColor(NSColor.white.cgColor)
  context?.fill(CGRect(x: frame * width / 300, y: 150, width: 20, height: 60))
  CVPixelBufferUnlockBaseAddress(buffer, [])
  adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: fps))
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
exit(writer.status == .completed ? 0 : 1)
