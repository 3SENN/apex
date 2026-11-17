/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Live recognition for one source on macOS 26: one SpeechAnalyzer with a
// SpeechTranscriber for the whole session, so a long meeting is never cut
// into one-minute requests. Audio goes in converted to the analyzer's best
// format, stamped with session audio time (pauses excluded), so result
// times are segment times as they are. Volatile results print as
// `partial`; finalized ones as `final`, split at pauses into segments, then
// whatever is still volatile after them as a fresh `partial`. If the
// analyzer fails it reports `interrupted`, opens a new one (backing off),
// and reports `restored`.

import AVFoundation
import CoreMedia
import Foundation
import Speech

@available(macOS 26.0, *)
/// State lives on `queue`, so it crosses tasks safely.
final class AnalyzerRecognizer: SourceRecognizer, @unchecked Sendable {
  /// One analyzer, its transcriber and its input; replaced when it fails.
  private final class Lane: @unchecked Sendable {
    let analyzer: SpeechAnalyzer
    let input: AsyncStream<AnalyzerInput>.Continuation
    var results: Task<Void, Never>?
    /// The last volatile result, so what follows a final stays on screen.
    var volatile: SpeechTranscriber.Result?
    /// A partial with text is showing.
    var showing = false

    init(analyzer: SpeechAnalyzer, input: AsyncStream<AnalyzerInput>.Continuation) {
      self.analyzer = analyzer
      self.input = input
    }

    func close() {
      input.finish()
      results?.cancel()
      let analyzer = analyzer
      Task { await analyzer.cancelAndFinishNow() }
    }
  }

  private let session: String
  private let source: String
  private let locale: Locale
  private let contextualStrings: [String]
  private let dictation: Bool
  private let format: AVAudioFormat
  private let converter: FormatConverter
  private let queue: DispatchQueue
  private var lane: Lane?
  private var opening = false
  private var stopped = false
  private var interrupted = false
  private var failures = 0
  /// The end of the audio given to the analyzer, in its format's frames.
  private var nextFrame: Int64?
  private(set) var heardText = false
  let onDevice = true

  private init(session: String, source: String, locale: Locale, contextualStrings: [String], dictation: Bool, format: AVAudioFormat) {
    self.session = session
    self.source = source
    self.locale = locale
    self.contextualStrings = contextualStrings
    self.dictation = dictation
    self.format = format
    converter = FormatConverter(to: format)
    queue = DispatchQueue(label: "com.sennechin.atelier.speech.analyzer.\(source)")
  }

  /// A recognizer with its analyzer started, or nil (the older engine takes over).
  static func make(session: String, source: String, locale: Locale, contextualStrings: [String], dictation: Bool) async -> AnalyzerRecognizer? {
    let probe = ModernSpeech.transcriber(locale, live: true, dictation: dictation)
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [probe], considering: canonicalFormat) else { return nil }
    let recognizer = AnalyzerRecognizer(session: session, source: source, locale: locale, contextualStrings: contextualStrings, dictation: dictation, format: format)
    guard let lane = try? await recognizer.open() else { return nil }
    // Nobody else holds the recognizer yet.
    recognizer.lane = lane
    return recognizer
  }

  private func open() async throws -> Lane {
    let transcriber = ModernSpeech.transcriber(locale, live: true, dictation: dictation)
    let analyzer = SpeechAnalyzer(modules: [transcriber], options: SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .lingering))
    if !contextualStrings.isEmpty {
      // Custom vocabulary (ST-19); a model that ignores it still transcribes.
      let context = AnalysisContext()
      context.contextualStrings[.general] = contextualStrings
      try? await analyzer.setContext(context)
    }
    try await analyzer.prepareToAnalyze(in: format)
    let (stream, input) = AsyncStream.makeStream(of: AnalyzerInput.self)
    let lane = Lane(analyzer: analyzer, input: input)
    lane.results = Task { [weak self, lane] in
      do {
        for try await result in transcriber.results {
          self?.queue.async { self?.handle(result, lane) }
        }
        self?.queue.async { self?.ended(lane) }
      } catch {
        self?.queue.async { self?.ended(lane) }
      }
    }
    do {
      try await analyzer.start(inputSequence: stream)
    } catch {
      lane.close()
      throw error
    }
    return lane
  }

  func append(_ buffer: AVAudioPCMBuffer, atMs: Double, rms: Float) {
    queue.async { [self] in
      guard !stopped, let lane, let converted = converter.convert(buffer), converted.frameLength > 0 else { return }
      let rate = format.sampleRate
      let wanted = Int64((atMs / 1000 * rate).rounded())
      // Contiguous unless the source skipped ahead (a dropout, or a new analyzer).
      var start = nextFrame ?? wanted
      if wanted - start > Int64(rate / 10) { start = wanted }
      lane.input.yield(AnalyzerInput(buffer: converted, bufferStartTime: CMTime(value: start, timescale: CMTimeScale(rate))))
      nextFrame = start + Int64(converted.frameLength)
    }
  }

  func cut() {
    queue.async { [self] in
      guard !stopped, let analyzer = lane?.analyzer else { return }
      Task { try? await analyzer.finalize(through: nil) }
    }
  }

  func finish(_ done: @escaping () -> Void) {
    queue.async { [self] in
      stopped = true
      guard let current = lane else { return done() }
      current.input.finish()
      Task { [self] in
        let settled = await race(seconds: 10) { () async -> Bool in
          try? await current.analyzer.finalizeAndFinishThroughEndOfInput()
          await current.results?.value
          return true
        }
        if settled == nil { current.close() }
        // After every result the analyzer delivered, on the same queue.
        self.queue.async { [self] in
          lane = nil
          done()
        }
      }
    }
  }

  private func handle(_ result: SpeechTranscriber.Result, _ from: Lane) {
    guard from === lane else { return }
    failures = 0
    let startMs = AnalyzerText.ms(result.range.start)
    let endMs = AnalyzerText.ms(CMTimeRangeGetEnd(result.range))
    if result.isFinal {
      for segment in AnalyzerText.segments(result.text, startMs: startMs, endMs: endMs) {
        emit(languageTagged(sure(["type": "final", "session": session, "source": source, "text": segment.text, "startMs": ms(segment.startMs), "endMs": ms(segment.endMs)], segment.confidence), locale: locale.identifier))
        heardText = true
      }
      // A final clears the source's partial; the rest of the volatile text comes back at once.
      let tail = from.volatile.map { AnalyzerText.text(of: $0.text, from: endMs) } ?? ""
      let tailEnd = from.volatile.map { AnalyzerText.ms(CMTimeRangeGetEnd($0.range)) } ?? endMs
      from.volatile = nil
      from.showing = !tail.isEmpty
      if !tail.isEmpty { partial(tail, startMs: endMs, endMs: tailEnd) }
    } else {
      from.volatile = result
      let text = Segments.tidy(String(result.text.characters))
      // An empty result after text clears it (the analyzer took it back).
      guard !text.isEmpty || from.showing else { return }
      from.showing = !text.isEmpty
      partial(text, startMs: startMs, endMs: endMs)
    }
  }

  private func partial(_ text: String, startMs: Double, endMs: Double) {
    emit(languageTagged(["type": "partial", "session": session, "source": source, "text": text, "startMs": ms(startMs), "endMs": ms(max(startMs, endMs))], locale: locale.identifier))
  }

  /// The analyzer stopped on its own (an error): report it and open another.
  private func ended(_ which: Lane) {
    guard which === lane, !stopped else { return }
    lane = nil
    which.close()
    if !interrupted {
      interrupted = true
      emit(["type": "interrupted", "session": session, "source": source])
    }
    retry()
  }

  private func retry() {
    failures += 1
    let delay = min(8, 0.5 * pow(2, Double(failures - 1)))
    queue.asyncAfter(deadline: .now() + delay) { [weak self] in self?.reopen() }
  }

  private func reopen() {
    guard !stopped, lane == nil, !opening else { return }
    opening = true
    Task { [self] in
      let next = try? await open()
      queue.async { [self] in
        opening = false
        guard let next else { return retry() }
        guard !stopped else { return next.close() }
        lane = next
        nextFrame = nil
        if interrupted {
          interrupted = false
          emit(["type": "restored", "session": session, "source": source])
        }
      }
    }
  }
}

/// Reading SpeechTranscriber results: times and words from the audio-time attributes.
@available(macOS 26.0, *)
enum AnalyzerText {
  static func ms(_ time: CMTime) -> Double {
    let seconds = CMTimeGetSeconds(time)
    return seconds.isFinite ? max(0, seconds * 1000) : 0
  }

  /// Each run with an audio time is a word; text between them joins the next one.
  static func words(_ text: AttributedString) -> [Segments.Word] {
    var words: [Segments.Word] = []
    var pending = ""
    for run in text.runs {
      let piece = String(text[run.range].characters)
      if let range = run.audioTimeRange, range.isValid, !range.isIndefinite {
        words.append(Segments.Word(text: pending + piece, startMs: ms(range.start), endMs: ms(CMTimeRangeGetEnd(range)), confidence: run.transcriptionConfidence))
        pending = ""
      } else if words.isEmpty {
        pending += piece
      } else {
        words[words.count - 1].text += piece
      }
    }
    if !pending.isEmpty, !words.isEmpty { words[words.count - 1].text += pending }
    return words
  }

  /// A final result as segments; without word times, one segment over the result's range.
  static func segments(_ text: AttributedString, startMs: Double, endMs: Double) -> [Segments.Segment] {
    let list = words(text)
    if !list.isEmpty { return Segments.group(list) }
    let plain = Segments.tidy(String(text.characters))
    return plain.isEmpty ? [] : [Segments.Segment(text: plain, startMs: startMs, endMs: max(startMs, endMs))]
  }

  /// The words that start at or after `fromMs` (by their middle), as one line.
  static func text(of text: AttributedString, from fromMs: Double) -> String {
    let list = words(text).filter { ($0.startMs + $0.endMs) / 2 >= fromMs }
    return Segments.tidy(list.map(\.text).joined())
  }
}
