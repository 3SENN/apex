/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-speech.exe: audio plumbing. Every source is turned into 16 kHz mono
// 16-bit PCM, which is what System.Speech reads, what the level meters
// measure and what a recording keeps.
using System.Buffers.Binary;
using System.Diagnostics;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace Atelier.Speech;

internal static class Pcm
{
    public const int Rate = 16_000;
    public const int BytesPerMs = Rate * 2 / 1000;
    public static readonly WaveFormat Format = new(Rate, 16, 1);

    private static readonly Guid FloatSubtype = new("00000003-0000-0010-8000-00aa00389b71");
    private static readonly Guid PcmSubtype = new("00000001-0000-0010-8000-00aa00389b71");

    /// <summary>WASAPI reports its mix format as WAVE_FORMAT_EXTENSIBLE; the plain equivalent reads the same bytes.</summary>
    public static WaveFormat Plain(WaveFormat format)
    {
        if (format is not WaveFormatExtensible ext) return format;
        if (ext.SubFormat == FloatSubtype) return WaveFormat.CreateIeeeFloatWaveFormat(format.SampleRate, format.Channels);
        if (ext.SubFormat == PcmSubtype) return new WaveFormat(format.SampleRate, format.BitsPerSample, format.Channels);
        return format;
    }

    /// <summary>Floats in -1..1 to little-endian 16-bit samples, with a gain.</summary>
    public static void ToPcm16(ReadOnlySpan<float> samples, float gain, Stream into)
    {
        Span<byte> two = stackalloc byte[2];
        foreach (var s in samples)
        {
            var v = Math.Clamp(s * gain, -1f, 1f);
            BinaryPrimitives.WriteInt16LittleEndian(two, (short)(v * short.MaxValue));
            into.Write(two);
        }
    }
}

/// <summary>Averages every channel into one.</summary>
internal sealed class DownmixToMono : ISampleProvider
{
    private readonly ISampleProvider source;
    private readonly int channels;
    private float[] buffer = [];

    public DownmixToMono(ISampleProvider source)
    {
        this.source = source;
        channels = source.WaveFormat.Channels;
        WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(source.WaveFormat.SampleRate, 1);
    }

    public WaveFormat WaveFormat { get; }

    public int Read(float[] dest, int offset, int count)
    {
        var needed = count * channels;
        if (buffer.Length < needed) buffer = new float[needed];
        var frames = source.Read(buffer, 0, needed) / channels;
        for (var f = 0; f < frames; f++)
        {
            float sum = 0;
            for (var c = 0; c < channels; c++) sum += buffer[f * channels + c];
            dest[offset + f] = sum / channels;
        }
        return frames;
    }
}

/// <summary>Turns one capture's buffers, whatever their format, into 16 kHz mono PCM.</summary>
internal sealed class PcmConverter
{
    private readonly BufferedWaveProvider buffered;
    private readonly ISampleProvider chain;
    private readonly float[] floats = new float[4096];

    public PcmConverter(WaveFormat input)
    {
        buffered = new BufferedWaveProvider(Pcm.Plain(input)) { ReadFully = false, DiscardOnBufferOverflow = true, BufferDuration = TimeSpan.FromSeconds(10) };
        ISampleProvider samples = buffered.ToSampleProvider();
        if (samples.WaveFormat.Channels != 1) samples = new DownmixToMono(samples);
        chain = samples.WaveFormat.SampleRate == Pcm.Rate ? samples : new WdlResamplingSampleProvider(samples, Pcm.Rate);
    }

    public byte[] Convert(byte[] buffer, int count, float gain)
    {
        buffered.AddSamples(buffer, 0, count);
        using var pcm = new MemoryStream(count / 2);
        int read;
        while ((read = chain.Read(floats, 0, floats.Length)) > 0) Pcm.ToPcm16(floats.AsSpan(0, read), gain, pcm);
        return pcm.ToArray();
    }
}

/// <summary>RMS and peak for one source, at most 15 times a second (the protocol's `level`).</summary>
internal sealed class LevelMeter(Action<double, double> emit)
{
    private const double IntervalMs = 1000.0 / 15;
    private double sumSquares;
    private double peak;
    private long count;
    private long last = Stopwatch.GetTimestamp();

    public void Add(ReadOnlySpan<byte> pcm16)
    {
        for (var i = 0; i + 1 < pcm16.Length; i += 2)
        {
            var s = BinaryPrimitives.ReadInt16LittleEndian(pcm16[i..]) / 32768.0;
            sumSquares += s * s;
            peak = Math.Max(peak, Math.Abs(s));
            count++;
        }
        var now = Stopwatch.GetTimestamp();
        if (count == 0 || Stopwatch.GetElapsedTime(last, now).TotalMilliseconds < IntervalMs) return;
        emit(Math.Min(1, Math.Sqrt(sumSquares / count)), Math.Min(1, peak));
        sumSquares = 0;
        peak = 0;
        count = 0;
        last = now;
    }
}

/// <summary>
/// The time the recording has run, pauses excluded: segment startMs and
/// endMs, durationMs and the system-audio gap filler all read it.
/// </summary>
internal sealed class AudioClock
{
    private readonly object gate = new();
    private readonly DateTimeOffset startedAt = DateTimeOffset.Now;
    private readonly Stopwatch watch = Stopwatch.StartNew();
    private readonly List<(double Start, double End)> pauses = [];
    private double? pausedAt;

    public double AudioMs
    {
        get { lock (gate) return ToAudio(watch.Elapsed.TotalMilliseconds); }
    }

    /// <summary>A wall-clock instant (WinRT's PhraseStartTime) on the audio timeline.</summary>
    public double AudioMsAt(DateTimeOffset t)
    {
        lock (gate) return ToAudio(Math.Clamp((t - startedAt).TotalMilliseconds, 0, watch.Elapsed.TotalMilliseconds));
    }

    public void Pause()
    {
        lock (gate) pausedAt ??= watch.Elapsed.TotalMilliseconds;
    }

    public void Resume()
    {
        lock (gate)
        {
            if (pausedAt is not double p) return;
            pauses.Add((p, watch.Elapsed.TotalMilliseconds));
            pausedAt = null;
        }
    }

    private double ToAudio(double wall)
    {
        double paused = 0;
        foreach (var (start, end) in pauses) if (start < wall) paused += Math.Min(end, wall) - start;
        if (pausedAt is double p && wall > p) paused += wall - p;
        return Math.Max(0, wall - paused);
    }
}

/// <summary>
/// A stream System.Speech reads from while audio is still arriving. Read
/// blocks until there is audio (returning 0 would end recognition), and
/// returns 0 only after Complete(). Live audio never waits: when the reader
/// falls behind, the oldest audio is dropped. A file transcription waits
/// instead, so nothing is lost.
/// </summary>
internal sealed class BlockingAudioStream(int capacityBytes, bool blockWhenFull) : Stream
{
    private readonly byte[] ring = new byte[capacityBytes];
    private readonly object gate = new();
    private int head;
    private int count;
    private bool completed;

    public void Push(ReadOnlySpan<byte> data)
    {
        lock (gate)
        {
            while (data.Length > 0 && !completed)
            {
                if (count == ring.Length)
                {
                    if (blockWhenFull)
                    {
                        Monitor.Wait(gate);
                        continue;
                    }
                    var drop = Math.Min(data.Length, ring.Length);
                    head = (head + drop) % ring.Length;
                    count -= drop;
                }
                var tail = (head + count) % ring.Length;
                var n = Math.Min(data.Length, Math.Min(ring.Length - count, ring.Length - tail));
                data[..n].CopyTo(ring.AsSpan(tail, n));
                count += n;
                data = data[n..];
                Monitor.PulseAll(gate);
            }
        }
    }

    public void Complete()
    {
        lock (gate)
        {
            completed = true;
            Monitor.PulseAll(gate);
        }
    }

    public override int Read(byte[] buffer, int offset, int length)
    {
        lock (gate)
        {
            while (count == 0 && !completed) Monitor.Wait(gate);
            if (count == 0) return 0;
            var n = Math.Min(length, Math.Min(count, ring.Length - head));
            Array.Copy(ring, head, buffer, offset, n);
            head = (head + n) % ring.Length;
            count -= n;
            Monitor.PulseAll(gate);
            return n;
        }
    }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    // SAPI asks for these on a live stream; unknown length, position 0.
    public override long Length => -1;
    public override long Position { get => 0; set { } }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        Complete();
        base.Dispose(disposing);
    }
}

/// <summary>
/// One WASAPI capture as 16 kHz mono PCM chunks: the default microphone, or
/// system audio through loopback on the default output. When the device goes
/// away (unplugged, or the default output changes), Failed fires and the
/// session starts it again on the new default.
/// </summary>
internal sealed class CaptureSource(bool loopback, Func<float> gain) : IDisposable
{
    private MMDevice? device;
    private WasapiCapture? capture;
    private volatile bool stopping;

    public event Action<byte[]>? Pcm;
    public event Action<Exception>? Failed;

    public void Start()
    {
        Release();
        stopping = false;
        using var enumerator = new MMDeviceEnumerator();
        device = enumerator.GetDefaultAudioEndpoint(loopback ? DataFlow.Render : DataFlow.Capture, Role.Console);
        capture = loopback ? new WasapiLoopbackCapture(device) : new WasapiCapture(device, false, 100);
        var converter = new PcmConverter(capture.WaveFormat);
        capture.DataAvailable += (_, e) =>
        {
            if (e.BytesRecorded == 0 || stopping) return;
            try
            {
                var pcm = converter.Convert(e.Buffer, e.BytesRecorded, gain());
                if (pcm.Length > 0) Pcm?.Invoke(pcm);
            }
            catch (Exception ex)
            {
                Failed?.Invoke(ex);
            }
        };
        capture.RecordingStopped += (_, e) =>
        {
            if (e.Exception != null && !stopping) Failed?.Invoke(e.Exception);
        };
        capture.StartRecording();
    }

    public void Stop()
    {
        stopping = true;
        try
        {
            capture?.StopRecording();
        }
        catch
        {
            // Already stopped with its device.
        }
    }

    private void Release()
    {
        capture?.Dispose();
        capture = null;
        device?.Dispose();
        device = null;
    }

    public void Dispose()
    {
        Stop();
        Release();
    }
}
