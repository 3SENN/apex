/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The recording (ST-18c): each source is written to its own
// AAC part while the session runs, and on stop the parts are merged into the
// one compressed audio.m4a Apex asked for. Parts start where their source's
// first audio fell on the session clock, so You and Others stay in step.
// A part is ADTS AAC, whose frames each stand alone, so a crash, a force quit
// or a power cut still leaves a readable part (an .m4a is only readable once
// it is closed). Its start is in its name, so `recover` puts a recording left
// behind together on Apex's next run.

import AVFoundation
import Foundation

/// A part on disk, and where it starts in session audio time.
struct Part {
  let url: URL
  let startMs: Double
}

enum Parts {
  /// `.audio.m4a.mic.1234.part.aac`, hidden beside the target.
  static func url(target: URL, source: String, startMs: Double) -> URL {
    target.deletingLastPathComponent().appendingPathComponent(".\(target.lastPathComponent).\(source).\(Int(startMs.rounded())).part.aac")
  }

  /// The parts a session that never finished left beside `target`. An older
  /// `.part.m4a` (before parts were ADTS) that can still be read counts from
  /// the start; one that can't (it was never closed) is removed.
  static func leftBehind(target: URL) -> [Part] {
    let dir = target.deletingLastPathComponent()
    let prefix = ".\(target.lastPathComponent)."
    var out: [Part] = []
    for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where name.hasPrefix(prefix) {
      let url = dir.appendingPathComponent(name)
      let middle = name.dropFirst(prefix.count)
      if middle.hasSuffix(".part.aac") {
        let fields = middle.dropLast(".part.aac".count).split(separator: ".")
        out.append(Part(url: url, startMs: fields.count >= 2 ? Double(fields[fields.count - 1]) ?? 0 : 0))
      } else if middle.hasSuffix(".part.m4a") {
        if hasAudio(url) {
          out.append(Part(url: url, startMs: 0))
        } else {
          try? FileManager.default.removeItem(at: url)
        }
      }
    }
    // The microphone's part first ("mic" sorts before "system"): a failed merge keeps it.
    return out.sorted { $0.url.lastPathComponent < $1.url.lastPathComponent }
  }

  /// The part can be read and holds some audio.
  static func hasAudio(_ url: URL) -> Bool {
    ((try? AVAudioFile(forReading: url))?.length ?? 0) > 0
  }
}

/// One source's AAC part, written as audio arrives.
final class PartWriter {
  let part: Part
  private var file: AVAudioFile?
  private(set) var frames: AVAudioFramePosition = 0

  init(target: URL, source: String, startMs: Double) throws {
    part = Part(url: Parts.url(target: target, source: source, startMs: startMs), startMs: startMs)
    try? FileManager.default.removeItem(at: part.url)
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: canonicalFormat.sampleRate,
      AVNumberOfChannelsKey: 1,
      AVEncoderBitRateKey: 64_000,
    ]
    // The .aac extension makes it an ADTS stream.
    file = try AVAudioFile(forWriting: part.url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
  }

  func write(_ buffer: AVAudioPCMBuffer) throws {
    guard let file else { return }
    try file.write(from: buffer)
    frames += AVAudioFramePosition(buffer.frameLength)
  }

  /// Fills a gap (a source that dropped out) so later audio stays in place.
  func writeSilence(frames count: AVAudioFrameCount) throws {
    var left = count
    while left > 0 {
      let chunk = min(left, AVAudioFrameCount(canonicalFormat.sampleRate))
      guard let buffer = AVAudioPCMBuffer(pcmFormat: canonicalFormat, frameCapacity: chunk) else { return }
      buffer.frameLength = chunk
      if let data = buffer.floatChannelData?[0] { data.initialize(repeating: 0, count: Int(chunk)) }
      try write(buffer)
      left -= chunk
    }
  }

  /// Finishes the file.
  func close() {
    file = nil
  }

  func discard() {
    close()
    try? FileManager.default.removeItem(at: part.url)
  }
}

enum Merger {
  /// Closes a session's parts, drops the empty ones and merges the rest.
  static func merge(_ writers: [PartWriter], into target: URL, completion: @escaping (Result<Int, Error>) -> Void) {
    for writer in writers { writer.close() }
    for writer in writers where writer.frames == 0 { writer.discard() }
    merge(writers.filter { $0.frames > 0 }.map(\.part), into: target, completion: completion)
  }

  /// Merges parts that hold audio into `target` (an .m4a) and reports its
  /// size. The parts are deleted once it is written; when nothing could be
  /// written they stay, so `recover` can try again on the next run.
  static func merge(_ parts: [Part], into target: URL, completion: @escaping (Result<Int, Error>) -> Void) {
    let done: (Result<Int, Error>) -> Void = { result in
      if case .success = result {
        for part in parts { try? FileManager.default.removeItem(at: part.url) }
      }
      completion(result)
    }
    try? FileManager.default.removeItem(at: target)
    guard !parts.isEmpty else {
      done(.failure(failure(10, "Nothing was recorded.")))
      return
    }
    // One source from the start: its audio as it is, in an .m4a.
    if parts.count == 1, let only = parts.first, only.startMs < 1 {
      export(AVURLAsset(url: only.url), preset: AVAssetExportPresetPassthrough, to: target) { error in
        if let error { fallback(parts, target, error, done) } else { done(.success(size(of: target))) }
      }
      return
    }
    let composition = AVMutableComposition()
    do {
      for part in parts {
        let asset = AVURLAsset(url: part.url)
        guard let track = asset.tracks(withMediaType: .audio).first,
              let lane = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
        let at = CMTime(seconds: part.startMs / 1000, preferredTimescale: 48_000)
        try lane.insertTimeRange(CMTimeRange(start: .zero, duration: asset.duration), of: track, at: at)
      }
    } catch {
      fallback(parts, target, error, done)
      return
    }
    export(composition, preset: AVAssetExportPresetAppleM4A, to: target) { error in
      if let error { fallback(parts, target, error, done) } else { done(.success(size(of: target))) }
    }
  }

  /// A failed merge keeps the microphone's part (the first), encoded afresh, rather than nothing.
  private static func fallback(_ parts: [Part], _ target: URL, _ error: Error, _ done: @escaping (Result<Int, Error>) -> Void) {
    guard let first = parts.first else { return done(.failure(error)) }
    export(AVURLAsset(url: first.url), preset: AVAssetExportPresetAppleM4A, to: target) { again in
      if again == nil {
        done(.success(size(of: target)))
      } else {
        try? FileManager.default.removeItem(at: target)
        done(.failure(error))
      }
    }
  }

  private static func export(_ asset: AVAsset, preset: String, to target: URL, _ completion: @escaping (Error?) -> Void) {
    try? FileManager.default.removeItem(at: target)
    guard let export = AVAssetExportSession(asset: asset, presetName: preset) else {
      completion(failure(11, "The recording could not be saved."))
      return
    }
    export.outputURL = target
    export.outputFileType = .m4a
    export.exportAsynchronously {
      completion(export.status == .completed ? nil : (export.error ?? failure(11, "The recording could not be saved.")))
    }
  }

  private static func failure(_ code: Int, _ message: String) -> NSError {
    NSError(domain: "apex-speech", code: code, userInfo: [NSLocalizedDescriptionKey: message])
  }

  static func size(of url: URL) -> Int {
    ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.intValue ?? 0
  }

  /// How long a written recording lasts.
  static func durationMs(of url: URL) -> Double {
    guard let file = try? AVAudioFile(forReading: url) else { return 0 }
    return Double(file.length) / file.processingFormat.sampleRate * 1000
  }
}
