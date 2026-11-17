/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Which of Apple's two speech engines a source listens with. On macOS 26
// SpeechAnalyzer with SpeechTranscriber (Analyzer.swift) runs on this Mac
// with no time limit per request, for the languages it supports once their
// model is installed (Models.swift). Everything else, and every older macOS,
// uses SFSpeechRecognizer (Recognition.swift). The JSON lines are the same
// either way; `started` says which engine is listening.

import AVFoundation
import Foundation
import Speech

/// What a source pipeline feeds, whichever engine is behind it.
protocol SourceRecognizer: AnyObject {
  /// Recognition stays on this Mac.
  var onDevice: Bool { get }
  /// Any text was recognised (no-speech is reported otherwise).
  var heardText: Bool { get }
  /// One canonical buffer at `atMs` in session audio time, with its RMS after gain.
  func append(_ buffer: AVAudioPCMBuffer, atMs: Double, rms: Float)
  /// Makes what was said so far final (on pause).
  func cut()
  /// Stops listening, waits for the last finals (briefly), then calls `done`.
  func finish(_ done: @escaping () -> Void)
}

extension Recognizer: SourceRecognizer {}

/// Bilingual: two recognizers, one per language, hear every buffer. Each prints
/// its own lines, tagged with its language; Apex keeps what fits.
final class PairRecognizer: SourceRecognizer {
  private let first: SourceRecognizer
  private let second: SourceRecognizer

  init(_ first: SourceRecognizer, _ second: SourceRecognizer) {
    self.first = first
    self.second = second
  }

  var onDevice: Bool { first.onDevice && second.onDevice }
  var heardText: Bool { first.heardText || second.heardText }

  func append(_ buffer: AVAudioPCMBuffer, atMs: Double, rms: Float) {
    first.append(buffer, atMs: atMs, rms: rms)
    second.append(buffer, atMs: atMs, rms: rms)
  }

  func cut() {
    first.cut()
    second.cut()
  }

  /// Both finish (each on the session queue), then `done` once.
  func finish(_ done: @escaping () -> Void) {
    var left = 2
    let one = {
      left -= 1
      if left == 0 { done() }
    }
    first.finish(one)
    second.finish(one)
  }
}

enum SpeechEngine: String {
  case analyzer
  case recognizer
}

/// How long a start waits for a language's model to finish installing before using the older engine this once.
let modelWaitSeconds: Double = 2.5

enum Engines {
  /// One recognizer per source, on the newer engine when this Mac and the
  /// language have it ready, else on the older one. Calls back on `queue`;
  /// a source missing from the result has no engine for this language.
  static func make(session: String, locale: String, contextualStrings: [String], sources: [String], dictation: Bool, queue: DispatchQueue, _ completion: @escaping ([String: SourceRecognizer], SpeechEngine) -> Void) {
    let older: ([String: SourceRecognizer]) -> [String: SourceRecognizer] = { made in
      var all = made
      for source in sources where all[source] == nil {
        if let recognizer = Recognizer(session: session, source: source, locale: locale, contextualStrings: contextualStrings) { all[source] = recognizer }
      }
      return all
    }
    if #available(macOS 26.0, *), ModernSpeech.enabled {
      Task {
        var made: [String: SourceRecognizer] = [:]
        if let ready = await ModernSpeech.ready(locale, wait: modelWaitSeconds) {
          // Both sides of a call load their analyzers at once.
          await withTaskGroup(of: (String, AnalyzerRecognizer?).self) { group in
            for source in sources {
              group.addTask { (source, await AnalyzerRecognizer.make(session: session, source: source, locale: ready, contextualStrings: contextualStrings, dictation: dictation)) }
            }
            for await (source, recognizer) in group {
              if let recognizer { made[source] = recognizer }
            }
          }
        }
        let newer = made
        queue.async {
          let engine: SpeechEngine = newer[sources.first ?? "mic"] == nil ? .recognizer : .analyzer
          completion(older(newer), engine)
        }
      }
      return
    }
    completion(older([:]), .recognizer)
  }
}

/// Claims a one-time outcome across tasks.
final class Once {
  private let lock = NSLock()
  private var done = false

  func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if done { return false }
    done = true
    return true
  }
}

/// The body's value, or nil when it takes longer than `seconds` (the body keeps running).
func race<T>(seconds: Double, _ body: @escaping () async -> T) async -> T? {
  await withCheckedContinuation { (continuation: CheckedContinuation<T?, Never>) in
    let once = Once()
    Task {
      let value = await body()
      if once.claim() { continuation.resume(returning: value) }
    }
    Task {
      try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
      if once.claim() { continuation.resume(returning: nil) }
    }
  }
}

/// Words grouped into transcript segments: at pauses of 0.7 s, at sentence
/// ends after 4 s, and at 25 s, so a long stretch of speech still reads as
/// lines with their own times.
enum Segments {
  struct Word {
    var text: String
    let startMs: Double
    let endMs: Double
    /// How sure the recognizer was of it (0 to 1), when it says.
    var confidence: Double? = nil
  }

  struct Segment {
    let text: String
    let startMs: Double
    let endMs: Double
    /// Its words' confidence, averaged by length (bilingual: a recognizer forcing another language into its own is unsure).
    var confidence: Double? = nil
  }

  /// The words' confidence averaged by their length; nil when none says.
  static func confidence(_ words: [(text: String, confidence: Double?)]) -> Double? {
    var weight = 0.0
    var sum = 0.0
    for word in words {
      guard let c = word.confidence else { continue }
      let w = Double(max(1, word.text.count))
      weight += w
      sum += c * w
    }
    return weight > 0 ? (sum / weight * 1000).rounded() / 1000 : nil
  }

  /// `joiner` goes between words (the older engine's words carry no spaces; the newer one's do).
  static func group(_ words: [Word], joiner: String = "") -> [Segment] {
    var out: [Segment] = []
    var pieces: [String] = []
    var sure: [(text: String, confidence: Double?)] = []
    var startMs: Double = 0
    var endMs: Double = 0
    func flush() {
      let text = tidy(pieces.joined(separator: joiner))
      if !text.isEmpty { out.append(Segment(text: text, startMs: startMs, endMs: max(startMs, endMs), confidence: confidence(sure))) }
      pieces = []
      sure = []
    }
    for word in words {
      if !pieces.isEmpty {
        let last = pieces.last.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        let sentenceEnd = last.hasSuffix(".") || last.hasSuffix("?") || last.hasSuffix("!")
        if word.startMs - endMs > 700 || endMs - startMs > 25_000 || (sentenceEnd && endMs - startMs > 4_000) { flush() }
      }
      if pieces.isEmpty { startMs = word.startMs }
      pieces.append(word.text)
      sure.append((word.text, word.confidence))
      endMs = max(endMs, word.endMs)
    }
    flush()
    return out
  }

  /// Single spaces, no space at either end.
  static func tidy(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
  }
}

/// Converts PCM to one target format, keeping converter state between buffers.
final class FormatConverter {
  let target: AVAudioFormat
  private var converter: AVAudioConverter?
  private var inputFormat: AVAudioFormat?

  init(to target: AVAudioFormat) {
    self.target = target
  }

  func convert(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    if input.format.isEqual(target) { return input }
    if converter == nil || inputFormat?.isEqual(input.format) != true {
      converter = AVAudioConverter(from: input.format, to: target)
      inputFormat = input.format
    }
    guard let converter else { return nil }
    let ratio = target.sampleRate / input.format.sampleRate
    let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 1024
    guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
    var fed = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, inputStatus in
      if fed {
        inputStatus.pointee = .noDataNow
        return nil
      }
      fed = true
      inputStatus.pointee = .haveData
      return input
    }
    guard status != .error, output.frameLength > 0 else { return nil }
    return output
  }
}
