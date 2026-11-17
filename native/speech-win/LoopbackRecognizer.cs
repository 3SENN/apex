/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-speech.exe: the other side of a call. WASAPI loopback (CaptureSource
// with loopback: true) captures what the default output plays; the session
// resamples it to 16 kHz mono and feeds it here, into System.Speech's
// SpeechRecognitionEngine with a DictationGrammar. That engine runs on this
// PC, and reads only installed desktop recognisers, so fewer languages work
// than for the microphone. The same engine transcribes files.
using System.Globalization;
using System.Speech.AudioFormat;
using System.Speech.Recognition;

namespace Atelier.Speech;

internal sealed class LoopbackRecognizer : IDisposable
{
    private readonly SpeechRecognitionEngine engine;
    private readonly BlockingAudioStream stream;
    private readonly Action<bool, string, double, double> onText;
    private readonly TaskCompletionSource done = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private double lastEnd;
    private bool heard;

    private LoopbackRecognizer(SpeechRecognitionEngine engine, BlockingAudioStream stream, Action<bool, string, double, double> onText)
    {
        this.engine = engine;
        this.stream = stream;
        this.onText = onText;
    }

    public bool Heard => heard;

    /// <summary>An installed desktop recogniser for the locale (or its language), or null.</summary>
    public static RecognizerInfo? Pick(string locale)
    {
        var installed = SpeechRecognitionEngine.InstalledRecognizers();
        var exact = installed.FirstOrDefault(r => string.Equals(r.Culture.Name, locale, StringComparison.OrdinalIgnoreCase));
        if (exact != null) return exact;
        string language;
        try
        {
            language = CultureInfo.GetCultureInfo(locale).TwoLetterISOLanguageName;
        }
        catch (CultureNotFoundException)
        {
            return null;
        }
        return installed.FirstOrDefault(r => r.Culture.TwoLetterISOLanguageName == language);
    }

    /// <param name="stream">16 kHz mono 16-bit PCM; Complete() it to finish.</param>
    /// <param name="onText">(partial, text, startMs, endMs) in stream time, which excludes pauses.</param>
    public static LoopbackRecognizer Start(string locale, BlockingAudioStream stream, Action<bool, string, double, double> onText)
    {
        var info = Pick(locale) ?? throw new HelperException("locale-unsupported", $"Windows has no on-device recogniser for {locale}.", fatal: false);
        var engine = new SpeechRecognitionEngine(info);
        try
        {
            engine.LoadGrammar(new DictationGrammar());
            engine.SetInputToAudioStream(stream, new SpeechAudioFormatInfo(Pcm.Rate, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            var recognizer = new LoopbackRecognizer(engine, stream, onText);
            engine.SpeechHypothesized += (_, e) => recognizer.Report(true, e.Result);
            engine.SpeechRecognized += (_, e) => recognizer.Report(false, e.Result);
            engine.RecognizeCompleted += (_, _) => recognizer.done.TrySetResult();
            engine.RecognizeAsync(RecognizeMode.Multiple);
            return recognizer;
        }
        catch (Exception ex)
        {
            engine.Dispose();
            throw Errors.From(ex);
        }
    }

    private void Report(bool partial, RecognitionResult? result)
    {
        var text = result?.Text;
        if (string.IsNullOrWhiteSpace(text)) return;
        // Hypotheses carry no audio; they run from the end of the last final.
        var audio = result!.Audio;
        var start = audio?.AudioPosition.TotalMilliseconds ?? lastEnd;
        var end = audio != null ? start + audio.Duration.TotalMilliseconds : start;
        if (!partial)
        {
            lastEnd = end;
            heard = true;
        }
        onText(partial, text, start, end);
    }

    /// <summary>Ends the audio and waits (up to `timeout`) for the last words.</summary>
    public async Task FinishAsync(TimeSpan timeout)
    {
        stream.Complete();
        await Task.WhenAny(done.Task, Task.Delay(timeout));
    }

    public void Dispose()
    {
        stream.Complete();
        try
        {
            engine.RecognizeAsyncCancel();
        }
        catch
        {
            // Already finished.
        }
        engine.Dispose();
    }
}
