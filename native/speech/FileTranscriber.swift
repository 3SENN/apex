/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Transcribes a recorded file (a meeting transcribed again from its
// audio). On macOS 26, languages the newer engine handles go through one
// SpeechAnalyzer over the whole file. Otherwise on-device languages read the
// whole file in one request; the others go in 50-second pieces, inside the
// server's limit. Words are grouped into segments at pauses, with times in
// the file's own time.

import AVFoundation
import Foundation
import Speech

/// State lives on `queue`, so it crosses tasks safely.
final class FileTranscriber: @unchecked Sendable {
  private let session: String
  private let url: URL
  private let locale: String
  private let contextualStrings: [String]
  private let queue: DispatchQueue
  private var task: SFSpeechRecognitionTask?
  private var export: AVAssetExportSession?
  private var finished = false
  private var onDone: (() -> Void)?
  private var durationMs: Double = 0
  private var lastProgress: Double = -1
  /// Stops the newer engine's analysis (set while it runs).
  private var cancelAnalyzer: (() -> Void)?
  /// The newer engine printed a segment (so it can't hand over to the older one).
  private var analyzerSpoke = false
  private static let chunkMs: Double = 50_000
  /// Bilingual files run once per language: this pass's part of the progress bar,
  /// whether it ends the session, and whether a failure just ends it quietly.
  private let share: (from: Double, to: Double)
  private let last: Bool
  private let quiet: Bool
  /// It ran to the end (not failed, not cancelled), so the next language can follow.
  private(set) var succeeded = false
  private var cancelled = false

  init(session: String, url: URL, locale: String, contextualStrings: [String], queue: DispatchQueue, share: (from: Double, to: Double) = (0, 1), last: Bool = true, quiet: Bool = false) {
    self.session = session
    self.url = url
    self.locale = locale
    self.contextualStrings = contextualStrings
    self.queue = queue
    self.share = share
    self.last = last
    self.quiet = quiet
  }

  func run(_ done: @escaping () -> Void) {
    onDone = done
    guard Permissions.speech() == "granted" else { return fail(.speechDenied, "Speech recognition is not allowed.") }
    guard FileManager.default.fileExists(atPath: url.path) else { return fail(.invalid, "The recording is missing.") }
    let asset = AVURLAsset(url: url)
    durationMs = max(0, CMTimeGetSeconds(asset.duration) * 1000)
    guard durationMs > 0 else { return fail(.invalid, "The recording is empty.") }
    if #available(macOS 26.0, *), ModernSpeech.enabled {
      Task { [self] in
        let ready = await ModernSpeech.ready(locale, wait: modelWaitSeconds)
        queue.async { [self] in
          if let ready { analyze(ready) } else { recognizeFile() }
        }
      }
      return
    }
    recognizeFile()
  }

  /// The older engine: the whole file, or 50-second pieces for server languages.
  private func recognizeFile() {
    guard !finished else { return }
    guard let recognizer = SFSpeechRecognizer(locale: speechLocale(locale)), recognizer.isAvailable else {
      return fail(.localeUnsupported, "Speech recognition is not available for \(locale).")
    }
    let asset = AVURLAsset(url: url)
    if recognizer.supportsOnDeviceRecognition || durationMs <= FileTranscriber.chunkMs {
      recognize(url, offsetMs: 0, recognizer) { [self] in finish() }
    } else {
      chunk(0, asset: asset, recognizer)
    }
  }

  func cancel() {
    queue.async { [self] in
      guard !finished else { return }
      cancelled = true
      task?.cancel()
      export?.cancelExport()
      cancelAnalyzer?()
      finish()
    }
  }

  private func fail(_ code: HelperError, _ message: String) {
    guard !finished else { return }
    // A second language that can't run leaves the first one's transcript as it is.
    if quiet {
      cancelled = true
      return finish()
    }
    finished = true
    emitError(session: session, code, message, fatal: true)
    onDone?()
    onDone = nil
  }

  private func finish() {
    guard !finished else { return }
    finished = true
    succeeded = !cancelled
    emit(["type": "progress", "session": session, "fraction": last ? 1 : share.to])
    if last { emit(["type": "stopped", "session": session, "durationMs": ms(durationMs), "audio": NSNull()]) }
    onDone?()
    onDone = nil
  }

  private func progress(_ atMs: Double) {
    let fraction = min(0.99, share.from + (share.to - share.from) * min(1, max(0, atMs / durationMs)))
    guard fraction - lastProgress >= 0.02 else { return }
    lastProgress = fraction
    emit(["type": "progress", "session": session, "fraction": fraction])
  }

  /// The newer engine over the whole file, with no time limit. If it fails
  /// before printing anything, the older engine tries instead.
  @available(macOS 26.0, *)
  private func analyze(_ speechLocale: Locale) {
    guard !finished else { return }
    guard let file = try? AVAudioFile(forReading: url) else { return recognizeFile() }
    let transcriber = ModernSpeech.transcriber(speechLocale, live: false)
    let analyzer = SpeechAnalyzer(modules: [transcriber], options: SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .lingering))
    cancelAnalyzer = { Task { await analyzer.cancelAndFinishNow() } }
    let strings = contextualStrings
    Task { [self] in
      do {
        if !strings.isEmpty {
          let context = AnalysisContext()
          context.contextualStrings[.general] = strings
          try? await analyzer.setContext(context)
        }
        let results = Task { [self] in
          for try await result in transcriber.results {
            queue.async { [self] in
              guard !finished else { return }
              let startMs = AnalyzerText.ms(result.range.start)
              let endMs = AnalyzerText.ms(CMTimeRangeGetEnd(result.range))
              for segment in AnalyzerText.segments(result.text, startMs: startMs, endMs: endMs) {
                analyzerSpoke = true
                emit(languageTagged(sure(["type": "final", "session": session, "source": "mic", "text": segment.text, "startMs": ms(segment.startMs), "endMs": ms(segment.endMs)], segment.confidence), locale: locale))
              }
              progress(endMs)
            }
          }
        }
        if let end = try await analyzer.analyzeSequence(from: file) {
          try await analyzer.finalizeAndFinish(through: end)
        } else {
          await analyzer.cancelAndFinishNow()
        }
        try await results.value
        queue.async { [self] in
          cancelAnalyzer = nil
          finish()
        }
      } catch {
        queue.async { [self] in
          cancelAnalyzer = nil
          guard !finished else { return }
          if analyzerSpoke { fail(.failed, error.localizedDescription) } else { recognizeFile() }
        }
      }
    }
  }

  /// One 50-second piece at a time, cut to a temporary file.
  private func chunk(_ index: Int, asset: AVURLAsset, _ recognizer: SFSpeechRecognizer) {
    let startMs = Double(index) * FileTranscriber.chunkMs
    guard !finished else { return }
    guard startMs < durationMs else { return finish() }
    let piece = FileManager.default.temporaryDirectory.appendingPathComponent("apex-speech-\(UUID().uuidString).m4a")
    guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
      return fail(.failed, "The recording could not be read.")
    }
    export.outputURL = piece
    export.outputFileType = .m4a
    export.timeRange = CMTimeRange(start: CMTime(seconds: startMs / 1000, preferredTimescale: 1000), duration: CMTime(seconds: min(FileTranscriber.chunkMs, durationMs - startMs) / 1000, preferredTimescale: 1000))
    self.export = export
    export.exportAsynchronously { [self] in
      queue.async { [self] in
        guard export.status == .completed else {
          try? FileManager.default.removeItem(at: piece)
          return fail(.failed, export.error?.localizedDescription ?? "The recording could not be read.")
        }
        recognize(piece, offsetMs: startMs, recognizer) { [self] in
          try? FileManager.default.removeItem(at: piece)
          chunk(index + 1, asset: asset, recognizer)
        }
      }
    }
  }

  private func recognize(_ file: URL, offsetMs: Double, _ recognizer: SFSpeechRecognizer, then next: @escaping () -> Void) {
    let request = SFSpeechURLRecognitionRequest(url: file)
    request.shouldReportPartialResults = true
    request.contextualStrings = contextualStrings
    if #available(macOS 13.0, *) { request.addsPunctuation = true }
    if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
    var called = false
    let proceed = {
      guard !called else { return }
      called = true
      next()
    }
    // On-device recognition starts over after a long pause or speech it can't follow (another
    // language): the results after that hold only what came next, and the final only the last
    // stretch. What the last result held is printed before it's lost.
    var held: [SFTranscriptionSegment] = []
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      guard let self else { return }
      self.queue.async {
        guard !self.finished else { return }
        if let result {
          let segments = result.bestTranscription.segments
          if FileTranscriber.startsOver(held, segments) { self.emitSegments(held, offsetMs: offsetMs) }
          held = segments
          if let last = segments.last { self.progress(offsetMs + (last.timestamp + last.duration) * 1000) }
          if result.isFinal {
            self.emitSegments(segments, offsetMs: offsetMs)
            held = []
            proceed()
          }
        } else if let error {
          // 1110: nothing was said in this piece.
          if (error as NSError).code == 1110 { proceed() } else { self.fail(.failed, error.localizedDescription) }
        }
      }
    }
  }

  /// True when `next` is a fresh start rather than `previous` revised: it begins
  /// later in the audio, or (without timings) shares none of its first words.
  static func startsOver(_ previous: [SFTranscriptionSegment], _ next: [SFTranscriptionSegment]) -> Bool {
    guard let before = previous.first, let after = next.first else { return false }
    let timed = previous.contains { $0.duration > 0 } && next.contains { $0.duration > 0 }
    if timed {
      let previousEnd = previous.last.map { $0.timestamp + $0.duration } ?? before.timestamp
      return after.timestamp >= previousEnd - 0.05 && after.timestamp > before.timestamp + 0.3
    }
    let opening = Set(previous.prefix(3).map { $0.substring.lowercased() })
    return next.count < previous.count && !next.prefix(3).contains { opening.contains($0.substring.lowercased()) }
  }

  /// Words grouped at pauses of 0.7 s, at sentence ends after 4 s, and at 25 s.
  private func emitSegments(_ segments: [SFTranscriptionSegment], offsetMs: Double) {
    var words: [String] = []
    var known: [(text: String, confidence: Double?)] = []
    var startMs: Double = 0
    var endMs: Double = 0
    let flush = { [self] in
      guard !words.isEmpty else { return }
      emit(languageTagged(sure(["type": "final", "session": session, "source": "mic", "text": words.joined(separator: " "), "startMs": ms(offsetMs + startMs), "endMs": ms(offsetMs + endMs)], Segments.confidence(known)), locale: locale))
      words = []
      known = []
    }
    for segment in segments {
      let begin = segment.timestamp * 1000
      let end = (segment.timestamp + min(segment.duration, wordSecondsMax)) * 1000
      if !words.isEmpty {
        let sentenceEnd = words.last.map { $0.hasSuffix(".") || $0.hasSuffix("?") || $0.hasSuffix("!") } ?? false
        if begin - endMs > 700 || endMs - startMs > 25_000 || (sentenceEnd && endMs - startMs > 4_000) { flush() }
      }
      if words.isEmpty { startMs = begin }
      words.append(segment.substring)
      // Partial results say 0: unknown, not unsure.
      known.append((segment.substring, segment.confidence > 0 ? Double(segment.confidence) : nil))
      endMs = end
    }
    flush()
  }
}
