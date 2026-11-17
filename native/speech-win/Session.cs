/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-speech.exe: one capture session (protocol v2 `start` … `stopped`).
//
//   microphone: WinRT dictation (MicRecognizer) for the words; a WASAPI
//               capture of the same default microphone for levels and the
//               recording.
//   system:     WASAPI loopback of the default output (meeting mode), fed to
//               System.Speech (LoopbackRecognizer) and to the recording.
//
// Pausing stops the clock and drops audio, so segment times and the
// recording both exclude pauses. A system source that can't start leaves
// the microphone running alone, with a non-fatal error that says so.
namespace Atelier.Speech;

internal sealed class Session : IAsyncDisposable
{
    // System.Speech may lag behind live audio by this much before the oldest is dropped.
    private const int LiveBufferBytes = Pcm.BytesPerMs * 30_000;
    // Loopback delivers nothing while the output is silent; pad once this far behind.
    private const int GapBytes = Pcm.BytesPerMs * 200;

    private readonly StartCommand cmd;
    private readonly AudioClock clock = new();
    private readonly object gate = new();
    private MicRecognizer? micRecognizer;
    private LoopbackRecognizer? systemRecognizer;
    private BlockingAudioStream? systemStream;
    private CaptureSource? micCapture;
    private CaptureSource? systemCapture;
    private LevelMeter? micLevel;
    private LevelMeter? systemLevel;
    private Recorder? recorder;
    private Timer? tick;
    private readonly HashSet<string> recovering = [];
    private bool paused;
    private bool stopping;
    private long systemBytes;

    private Session(StartCommand cmd) => this.cmd = cmd;

    public string Id => cmd.Session;

    /// <summary>Starts, never prompting; throws a fatal HelperException when it can't.</summary>
    public static async Task<Session> StartAsync(StartCommand cmd)
    {
        var session = new Session(cmd);
        try
        {
            await session.BeginAsync();
            return session;
        }
        catch
        {
            await session.DisposeAsync();
            throw;
        }
    }

    private async Task BeginAsync()
    {
        if (Permissions.Microphone() != "granted") throw new HelperException("mic-denied", "Microphone access is off for desktop apps in Windows Settings.");
        if (cmd.Transcribe && Permissions.Speech() == "denied") throw new HelperException("speech-denied", "Online speech recognition is off in Windows Settings › Privacy › Speech.");
        var defaultId = Devices.DefaultCaptureId() ?? throw new HelperException("device-missing", "No microphone is connected.");
        // Windows dictation only hears the default microphone, so a chosen
        // one is replaced by it, and main shows its device-fallback warning.
        var fallback = cmd.DeviceId != null && !string.Equals(cmd.DeviceId, defaultId, StringComparison.OrdinalIgnoreCase);

        if (cmd.RecordPath != null) recorder = new Recorder(cmd.RecordPath);
        if (cmd.Levels) micLevel = new LevelMeter((rms, peak) => Level("mic", rms, peak));
        if (cmd.Levels || recorder != null)
        {
            micCapture = StartCapture("mic", loopback: false, () => (float)cmd.MicGain, OnMicPcm, fatal: true);
        }
        if (cmd.Transcribe)
        {
            micRecognizer = await MicRecognizer.StartAsync(
                cmd.Locale,
                clock,
                (partial, text, from, to) => Text(partial, "mic", text, from, to),
                lost => Interruption("mic", lost),
                message => Out.Error("failed", message, fatal: false, Id, "mic"));
        }
        var systemAudio = cmd.Mode == "meeting" && StartSystem();
        tick = new Timer(_ => Tick(), null, 100, 100);
        Out.Emit(new
        {
            type = "started",
            session = Id,
            mode = cmd.Mode,
            // Dictation goes through Microsoft's online service; capture alone stays here.
            onDevice = !cmd.Transcribe,
            systemAudio,
            deviceId = defaultId,
            locale = cmd.Locale,
            fallbackDevice = fallback,
        });
    }

    private bool StartSystem()
    {
        try
        {
            systemCapture = StartCapture("system", loopback: true, () => (float)cmd.SystemGain, OnSystemPcm, fatal: false);
        }
        catch (Exception ex)
        {
            Out.Error("failed", $"System audio can't be captured ({ex.Message}), so only the microphone is used.", fatal: false, Id, "system");
            systemCapture = null;
            return false;
        }
        if (cmd.Levels) systemLevel = new LevelMeter((rms, peak) => Level("system", rms, peak));
        if (!cmd.Transcribe) return true;
        try
        {
            systemStream = new BlockingAudioStream(LiveBufferBytes, blockWhenFull: false);
            systemRecognizer = LoopbackRecognizer.Start(cmd.Locale, systemStream, (partial, text, from, to) => Text(partial, "system", text, from, to));
            return true;
        }
        catch (Exception ex)
        {
            var e = Errors.From(ex, "locale-unsupported");
            Out.Error(e.Code, "Windows can't transcribe the other side of the call in this language on this PC, so only your microphone is transcribed.", fatal: false, Id, "system");
            systemStream?.Dispose();
            systemStream = null;
            return false;
        }
    }

    private CaptureSource StartCapture(string source, bool loopback, Func<float> gain, Action<byte[]> onPcm, bool fatal)
    {
        var capture = new CaptureSource(loopback, gain);
        capture.Pcm += onPcm;
        capture.Failed += error => _ = RecoverAsync(source, capture, error);
        try
        {
            capture.Start();
        }
        catch (Exception ex)
        {
            capture.Dispose();
            var e = Errors.From(ex, loopback ? "failed" : "device-missing");
            throw new HelperException(e.Code, e.Message, fatal);
        }
        return capture;
    }

    /// <summary>A lost device (unplugged, or a new default output): say so, and start again on the new default.</summary>
    private async Task RecoverAsync(string source, CaptureSource capture, Exception error)
    {
        // A failing capture can report twice (its last buffer, then the stop).
        lock (gate) if (stopping || !recovering.Add(source)) return;
        try
        {
            await RestartCaptureAsync(source, capture, error);
        }
        finally
        {
            lock (gate) recovering.Remove(source);
        }
    }

    private async Task RestartCaptureAsync(string source, CaptureSource capture, Exception error)
    {
        Interruption(source, lost: true);
        for (var attempt = 1; attempt <= 5; attempt++)
        {
            await Task.Delay(500 * attempt);
            lock (gate) if (stopping) return;
            try
            {
                capture.Start();
                Interruption(source, lost: false);
                return;
            }
            catch
            {
                // No device yet; wait longer.
            }
        }
        Out.Error("device-missing", $"The {(source == "mic" ? "microphone" : "system audio")} went away ({error.Message}).", fatal: false, Id, source);
    }

    private void OnMicPcm(byte[] pcm)
    {
        lock (gate)
        {
            if (paused || stopping) return;
            micLevel?.Add(pcm);
            recorder?.Write("mic", pcm);
        }
    }

    private void OnSystemPcm(byte[] pcm)
    {
        lock (gate)
        {
            if (paused || stopping) return;
            systemLevel?.Add(pcm);
            WriteSystem(pcm);
        }
    }

    private void WriteSystem(byte[] pcm)
    {
        recorder?.Write("system", pcm);
        systemStream?.Push(pcm);
        systemBytes += pcm.Length;
    }

    /// <summary>Pads system audio with silence so it keeps time with the microphone.</summary>
    private void PadSystem(long threshold)
    {
        if (systemCapture == null) return;
        var expected = (long)(clock.AudioMs * Pcm.BytesPerMs) & ~1L;
        var missing = expected - systemBytes;
        if (missing > threshold) WriteSystem(new byte[missing]);
    }

    private void Tick()
    {
        try
        {
            lock (gate)
            {
                if (!paused && !stopping) PadSystem(GapBytes);
            }
        }
        catch
        {
            // Never take the timer thread down.
        }
    }

    private void Text(bool partial, string source, string text, double from, double to) => Out.Emit(new
    {
        type = partial ? "partial" : "final",
        session = Id,
        source,
        text,
        startMs = Math.Round(Math.Max(0, from)),
        endMs = Math.Round(Math.Max(from, to)),
    });

    private void Level(string source, double rms, double peak) =>
        Out.Emit(new { type = "level", session = Id, source, rms = Math.Round(rms, 4), peak = Math.Round(peak, 4) });

    private void Interruption(string source, bool lost) =>
        Out.Emit(new { type = lost ? "interrupted" : "restored", session = Id, source });

    public async Task PauseAsync()
    {
        lock (gate)
        {
            if (paused || stopping) return;
            paused = true;
            clock.Pause();
        }
        if (micRecognizer != null) await micRecognizer.PauseAsync();
        Out.Emit(new { type = "paused", session = Id });
    }

    public Task ResumeAsync()
    {
        lock (gate)
        {
            if (!paused || stopping) return Task.CompletedTask;
            paused = false;
            clock.Resume();
        }
        micRecognizer?.Resume();
        Out.Emit(new { type = "resumed", session = Id });
        return Task.CompletedTask;
    }

    /// <summary>Stops capture, lets recognition finish, saves the recording, prints `stopped`.</summary>
    public async Task StopAsync()
    {
        double durationMs;
        lock (gate)
        {
            if (stopping) return;
            // The tail of system audio up to now, so both sides end together.
            if (!paused) PadSystem(0);
            stopping = true;
            durationMs = clock.AudioMs;
        }
        tick?.Dispose();
        tick = null;
        if (micRecognizer != null) await micRecognizer.StopAsync();
        micCapture?.Stop();
        systemCapture?.Stop();
        if (systemRecognizer != null) await systemRecognizer.FinishAsync(TimeSpan.FromSeconds(10));
        if (cmd.Transcribe && micRecognizer?.Heard != true && systemRecognizer?.Heard != true)
            Out.Error("no-speech", "No speech was heard.", fatal: false, Id);

        object? audio = null;
        if (recorder != null)
        {
            try
            {
                var saved = await recorder.FinishAsync();
                if (saved is { } file) audio = new { path = file.Path, bytes = file.Bytes };
            }
            catch (Exception ex)
            {
                Out.Error(Errors.From(ex, "recording-failed"), Id);
            }
        }
        Out.Emit(new { type = "stopped", session = Id, durationMs = Math.Round(durationMs), audio });
        await DisposeAsync();
    }

    public async ValueTask DisposeAsync()
    {
        lock (gate) stopping = true;
        tick?.Dispose();
        tick = null;
        if (micRecognizer != null) await micRecognizer.DisposeAsync();
        micRecognizer = null;
        systemRecognizer?.Dispose();
        systemRecognizer = null;
        systemStream?.Dispose();
        systemStream = null;
        micCapture?.Dispose();
        micCapture = null;
        systemCapture?.Dispose();
        systemCapture = null;
        lock (gate)
        {
            recorder?.Dispose();
            recorder = null;
        }
    }
}
