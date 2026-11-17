/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-speech.exe: a session's recording. Each source is written as a 16 kHz
// WAV part beside the target (pauses are simply not written; system audio is
// padded to keep time, so every part starts at the session's start), and on
// stop the parts are mixed into the one AAC .m4a file Atelier asked for, through
// Media Foundation. The parts are removed once it is written; when it can't
// be, they stay, so `recover` can try again on Atelier's next run. A crash, a
// force quit or Windows ending the session leaves them too: their WAV headers
// still say empty (NAudio writes the sizes on close), so `recover` repairs
// them before it merges.
using NAudio.MediaFoundation;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace Atelier.Speech;

internal sealed class Recorder(string target) : IDisposable
{
    // Media Foundation's AAC encoder takes 44.1 or 48 kHz only.
    private const int EncodeRate = 48_000;
    private const int BitRate = 96_000;
    private const string PartSuffix = ".part.wav";
    private readonly Dictionary<string, WaveFileWriter> parts = [];
    private readonly List<string> files = [];
    private bool finished;

    private static string Folder(string target) => Path.GetDirectoryName(Path.GetFullPath(target)) ?? Path.GetTempPath();

    /// <summary>`.audio.m4a.mic.part.wav`, hidden beside the target.</summary>
    private static string PartPath(string target, string source) => Path.Combine(Folder(target), $".{Path.GetFileName(target)}.{source}{PartSuffix}");

    /// <summary>Called under the session's lock, from the capture threads.</summary>
    public void Write(string source, byte[] pcm)
    {
        if (finished) return;
        if (!parts.TryGetValue(source, out var writer))
        {
            var path = PartPath(target, source);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            writer = new WaveFileWriter(path, Pcm.Format);
            parts[source] = writer;
            files.Add(path);
        }
        writer.Write(pcm, 0, pcm.Length);
    }

    /// <summary>The finished file and its size, or null when nothing was recorded.</summary>
    public Task<(string Path, long Bytes)?> FinishAsync() => Task.Run(Finish);

    private (string Path, long Bytes)? Finish()
    {
        finished = true;
        CloseWriters();
        var withAudio = DropEmpty(files);
        files.Clear();
        return withAudio.Count == 0 ? null : Merge(withAudio, target);
    }

    private void CloseWriters()
    {
        foreach (var writer in parts.Values)
        {
            try
            {
                writer.Dispose();
            }
            catch
            {
                // A part that can't be closed is repaired by `recover`.
            }
        }
        parts.Clear();
    }

    /// <summary>The parts that hold audio; the empty ones (it stopped before the first frame) go.</summary>
    private static List<string> DropEmpty(IEnumerable<string> paths)
    {
        var keep = new List<string>();
        foreach (var path in paths)
        {
            if (!File.Exists(path)) continue;
            if (Wav.DataBytes(path) > 0) keep.Add(path);
            else TryDelete(path);
        }
        return keep;
    }

    /// <summary>Mixes `parts` into `target` (an .m4a) and reports its size. The parts go once it is written, and stay when it can't be.</summary>
    private static (string Path, long Bytes) Merge(List<string> parts, string target)
    {
        var readers = new List<WaveFileReader>();
        try
        {
            TryDelete(target);
            foreach (var part in parts) readers.Add(new WaveFileReader(part));
            MediaFoundationApi.Startup();
            var mixer = new MixingSampleProvider(readers.Select(r => r.ToSampleProvider()));
            var encoded = new WdlResamplingSampleProvider(mixer, EncodeRate).ToWaveProvider16();
            MediaFoundationEncoder.EncodeToAac(encoded, target, BitRate);
        }
        catch (Exception ex)
        {
            foreach (var reader in readers) reader.Dispose();
            readers.Clear();
            // A half-written target would pass for the recording; the parts are what's kept.
            TryDelete(target);
            throw new HelperException("recording-failed", $"The recording could not be saved: {ex.Message}", fatal: false);
        }
        finally
        {
            foreach (var reader in readers) reader.Dispose();
        }
        foreach (var part in parts) TryDelete(part);
        return (target, new FileInfo(target).Length);
    }

    /// <summary>
    /// A recording a session never finished: repairs the parts left beside
    /// `target`, merges the ones with audio into it, and reports it with its
    /// length; null when nothing was left. Throws (and keeps the parts) when
    /// they can't be merged.
    /// </summary>
    public static ((string Path, long Bytes) Audio, double DurationMs)? Recover(string target)
    {
        var folder = Folder(target);
        if (!Directory.Exists(folder)) return null;
        var prefix = $".{Path.GetFileName(target)}.";
        var found = Directory.EnumerateFiles(folder)
            .Where(p => Path.GetFileName(p) is var n && n.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && n.EndsWith(PartSuffix, StringComparison.OrdinalIgnoreCase))
            // The microphone's part first ("mic" sorts before "system").
            .OrderBy(p => Path.GetFileName(p), StringComparer.Ordinal)
            .ToList();
        foreach (var part in found) Wav.Repair(part);
        var parts = DropEmpty(found);
        if (parts.Count == 0) return null;
        var durationMs = parts.Max(Wav.DataBytes) / (double)Pcm.BytesPerMs;
        return (Merge(parts, target), durationMs);
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch
        {
            // Hidden and small; the next recover or recording tries again.
        }
    }

    public void Dispose()
    {
        finished = true;
        CloseWriters();
        // Parts with audio stay for `recover` (a save that failed); a stopped recording already merged them.
        DropEmpty(files);
        files.Clear();
    }
}

/// <summary>The RIFF bits a part needs: its data size, and a header put right after a crash.</summary>
internal static class Wav
{
    private static string Ascii(byte[] bytes) => System.Text.Encoding.ASCII.GetString(bytes);

    /// <summary>Where the data chunk's bytes start, and the size its header claims; null when there is none.</summary>
    private static (long Start, uint Declared)? DataChunk(FileStream stream)
    {
        var reader = new BinaryReader(stream);
        if (stream.Length < 12) return null;
        stream.Position = 0;
        if (Ascii(reader.ReadBytes(4)) != "RIFF") return null;
        reader.ReadUInt32();
        if (Ascii(reader.ReadBytes(4)) != "WAVE") return null;
        while (stream.Position + 8 <= stream.Length)
        {
            var id = Ascii(reader.ReadBytes(4));
            var size = reader.ReadUInt32();
            if (id == "data") return (stream.Position, size);
            // Chunks are padded to an even length.
            stream.Position += size + (size & 1);
        }
        return null;
    }

    /// <summary>The audio bytes a part holds (by its length on disk, which a crash leaves right where the header doesn't).</summary>
    public static long DataBytes(string path)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            return DataChunk(stream) is { } data ? Math.Max(0, stream.Length - data.Start) & ~1L : 0;
        }
        catch
        {
            return 0;
        }
    }

    /// <summary>Writes the RIFF and data sizes a part left by a crash never got (whole 16-bit samples).</summary>
    public static void Repair(string path)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            if (DataChunk(stream) is not { } data) return;
            var bytes = Math.Min(uint.MaxValue - 64, Math.Max(0, stream.Length - data.Start) & ~1L);
            if (data.Declared == bytes && stream.Length == data.Start + bytes) return;
            stream.SetLength(data.Start + bytes);
            var writer = new BinaryWriter(stream);
            stream.Position = 4;
            writer.Write((uint)(stream.Length - 8));
            stream.Position = data.Start - 4;
            writer.Write((uint)bytes);
            writer.Flush();
        }
        catch
        {
            // Unreadable: DataBytes reads it as empty, and it is left as it is.
        }
    }
}
