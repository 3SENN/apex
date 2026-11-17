/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-speech.exe: `transcribe` (a saved recording or an imported file). Media
// Foundation decodes it (m4a, mp3, wav, …), it is resampled to 16 kHz mono
// and read by System.Speech on this PC. Lines match the macOS helper:
// `progress` as it goes, `final`s (source mic), then progress 1 and `stopped`.
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace Atelier.Speech;

internal static class FileTranscriber
{
    // A small buffer keeps progress close to what has been recognised.
    private const int BufferBytes = Pcm.BytesPerMs * 2_000;

    public static async Task RunAsync(TranscribeCommand c, CancellationToken cancel)
    {
        if (!File.Exists(c.Path)) throw new HelperException("invalid", "That file doesn't exist.");
        using var reader = new MediaFoundationReader(c.Path);
        ISampleProvider samples = reader.ToSampleProvider();
        if (samples.WaveFormat.Channels != 1) samples = new DownmixToMono(samples);
        if (samples.WaveFormat.SampleRate != Pcm.Rate) samples = new WdlResamplingSampleProvider(samples, Pcm.Rate);
        var pcm = samples.ToWaveProvider16();
        var totalMs = Math.Max(1, reader.TotalTime.TotalMilliseconds);

        using var stream = new BlockingAudioStream(BufferBytes, blockWhenFull: true);
        using var recognizer = LoopbackRecognizer.Start(c.Locale, stream, (partial, text, from, to) =>
        {
            if (!partial) Out.Emit(new { type = "final", session = c.Session, source = "mic", text, startMs = Math.Round(from), endMs = Math.Round(Math.Max(from, to)) });
        });

        var fedMs = await Task.Run(() =>
        {
            var buffer = new byte[Pcm.BytesPerMs * 200];
            double fed = 0;
            double reported = 0;
            int read;
            while (!cancel.IsCancellationRequested && (read = pcm.Read(buffer, 0, buffer.Length)) > 0)
            {
                stream.Push(buffer.AsSpan(0, read));
                fed += read / (double)Pcm.BytesPerMs;
                var fraction = Math.Min(0.99, fed / totalMs);
                if (fraction - reported >= 0.02)
                {
                    reported = fraction;
                    Out.Emit(new { type = "progress", session = c.Session, fraction = Math.Round(fraction, 3) });
                }
            }
            return fed;
        }, CancellationToken.None);

        await recognizer.FinishAsync(cancel.IsCancellationRequested ? TimeSpan.FromSeconds(1) : TimeSpan.FromMinutes(5));
        Out.Emit(new { type = "progress", session = c.Session, fraction = 1.0 });
        Out.Emit(new { type = "stopped", session = c.Session, durationMs = Math.Round(fedMs), audio = (object?)null });
    }
}
