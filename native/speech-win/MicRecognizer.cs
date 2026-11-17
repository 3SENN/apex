/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-speech.exe: the microphone through Windows.Media.SpeechRecognition, in
// continuous dictation. Windows' dictation topic runs on Microsoft's online
// speech service (Settings › Privacy › Speech), so `started` reports
// onDevice false while it transcribes; it always listens to the default
// microphone, which is why the session records and meters that one too.
using Windows.Globalization;
using Windows.Media.SpeechRecognition;

namespace Atelier.Speech;

internal sealed class MicRecognizer : IAsyncDisposable
{
    private readonly SpeechRecognizer recognizer;
    private readonly AudioClock clock;
    private readonly Action<bool, string, double, double> onText;
    private readonly Action<bool> onInterrupted;
    private readonly Action<string> onFailed;
    private volatile bool stopping;
    private bool heard;
    private double phraseStart = -1;

    private MicRecognizer(SpeechRecognizer recognizer, AudioClock clock, Action<bool, string, double, double> onText, Action<bool> onInterrupted, Action<string> onFailed)
    {
        this.recognizer = recognizer;
        this.clock = clock;
        this.onText = onText;
        this.onInterrupted = onInterrupted;
        this.onFailed = onFailed;
    }

    /// <summary>Whether any final text arrived (stop reports no-speech otherwise).</summary>
    public bool Heard => heard;

    /// <summary>The locale Windows would use, or null when it can't dictate in it.</summary>
    public static Language? Supported(string locale)
    {
        foreach (var language in SpeechRecognizer.SupportedTopicLanguages)
            if (string.Equals(language.LanguageTag, locale, StringComparison.OrdinalIgnoreCase)) return language;
        // en-US asked for, en-GB installed: the same language is close enough.
        var prefix = locale.Split('-')[0];
        foreach (var language in SpeechRecognizer.SupportedTopicLanguages)
            if (string.Equals(language.LanguageTag.Split('-')[0], prefix, StringComparison.OrdinalIgnoreCase)) return language;
        return null;
    }

    /// <param name="onText">(partial, text, startMs, endMs) on the audio clock.</param>
    /// <param name="onInterrupted">true when recognition dropped out, false once it is back.</param>
    /// <param name="onFailed">recognition could not be restarted.</param>
    public static async Task<MicRecognizer> StartAsync(string locale, AudioClock clock, Action<bool, string, double, double> onText, Action<bool> onInterrupted, Action<string> onFailed)
    {
        var language = Supported(locale) ?? throw new HelperException("locale-unsupported", $"Windows can't transcribe {locale}.");
        var recognizer = new SpeechRecognizer(language);
        try
        {
            recognizer.Constraints.Add(new SpeechRecognitionTopicConstraint(SpeechRecognitionScenario.Dictation, "atelier-dictation"));
            var compiled = await recognizer.CompileConstraintsAsync();
            if (compiled.Status != SpeechRecognitionResultStatus.Success) throw FromStatus(compiled.Status);
            // Long silences in a meeting are normal; Completed restarts it anyway.
            recognizer.ContinuousRecognitionSession.AutoStopSilenceTimeout = TimeSpan.FromMinutes(30);
            var mic = new MicRecognizer(recognizer, clock, onText, onInterrupted, onFailed);
            mic.Wire();
            await recognizer.ContinuousRecognitionSession.StartAsync(SpeechContinuousRecognitionMode.Default);
            return mic;
        }
        catch (Exception ex)
        {
            recognizer.Dispose();
            throw Errors.From(ex);
        }
    }

    private void Wire()
    {
        recognizer.HypothesisGenerated += (_, e) =>
        {
            var text = e.Hypothesis?.Text;
            if (string.IsNullOrWhiteSpace(text)) return;
            var now = clock.AudioMs;
            if (phraseStart < 0) phraseStart = now;
            onText(true, text, phraseStart, now);
        };
        recognizer.ContinuousRecognitionSession.ResultGenerated += (_, e) =>
        {
            var result = e.Result;
            var start = phraseStart;
            phraseStart = -1;
            if (result.Status != SpeechRecognitionResultStatus.Success || result.Confidence == SpeechRecognitionConfidence.Rejected || string.IsNullOrWhiteSpace(result.Text)) return;
            var from = clock.AudioMsAt(result.PhraseStartTime);
            if (start >= 0 && from <= 0) from = start;
            var to = Math.Max(from, Math.Min(clock.AudioMs, from + result.PhraseDuration.TotalMilliseconds));
            heard = true;
            onText(false, result.Text, from, to);
        };
        // A named sender: with a lone `_` parameter, `_ =` below would assign to it rather than discard.
        recognizer.ContinuousRecognitionSession.Completed += (session, e) =>
        {
            if (!stopping) _ = RestartAsync(e.Status);
        };
    }

    private async Task RestartAsync(SpeechRecognitionResultStatus status)
    {
        // A long silence ends a continuous session quietly; anything else is
        // an interruption the person should see.
        var quiet = status is SpeechRecognitionResultStatus.Success or SpeechRecognitionResultStatus.TimeoutExceeded;
        if (!quiet) onInterrupted(true);
        for (var attempt = 0; attempt < 5 && !stopping; attempt++)
        {
            try
            {
                if (!quiet || attempt > 0) await Task.Delay(500 * (attempt + 1));
                if (stopping) return;
                await recognizer.ContinuousRecognitionSession.StartAsync(SpeechContinuousRecognitionMode.Default);
                if (!quiet) onInterrupted(false);
                return;
            }
            catch
            {
                // Try again after a longer pause.
            }
        }
        if (!stopping) onFailed($"Speech recognition stopped ({status}) and could not restart.");
    }

    public async Task PauseAsync()
    {
        try
        {
            await recognizer.ContinuousRecognitionSession.PauseAsync();
        }
        catch
        {
            // Not running between restarts; the session's clock still pauses.
        }
    }

    public void Resume()
    {
        try
        {
            recognizer.ContinuousRecognitionSession.Resume();
        }
        catch
        {
            // Restarting; it comes back by itself.
        }
    }

    /// <summary>Stops listening; the last phrase arrives as a final first.</summary>
    public async Task StopAsync()
    {
        if (stopping) return;
        stopping = true;
        try
        {
            await recognizer.ContinuousRecognitionSession.StopAsync();
        }
        catch
        {
            // Already idle.
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        recognizer.Dispose();
    }

    private static HelperException FromStatus(SpeechRecognitionResultStatus status) => status switch
    {
        SpeechRecognitionResultStatus.TopicLanguageNotSupported or SpeechRecognitionResultStatus.GrammarLanguageMismatch => new HelperException("locale-unsupported", "Windows can't transcribe this language."),
        SpeechRecognitionResultStatus.MicrophoneUnavailable => new HelperException("device-missing", "No microphone is available."),
        SpeechRecognitionResultStatus.NetworkFailure => new HelperException("failed", "Windows' speech service can't be reached."),
        _ => new HelperException("failed", $"Speech recognition could not start ({status})."),
    };
}
