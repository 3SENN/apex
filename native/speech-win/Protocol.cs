/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex-speech.exe: the JSON-lines protocol v2, the same
// one the macOS helper speaks. Commands arrive on stdin, one JSON object per
// line; replies and session events leave on stdout the same way. Nothing
// else is ever written to stdout, so main's parser sees only protocol lines.
using System.Text.Json;

namespace Apex.Speech;

internal static class Protocol
{
    public const int Version = 2;
}

/// <summary>A failure with one of the speech helper's error codes (HelperErrorCode).</summary>
internal sealed class HelperException(string code, string message, bool fatal = true) : Exception(message)
{
    public string Code { get; } = code;
    public bool Fatal { get; } = fatal;
}

/// <summary>Writes protocol lines. Capture and recognition threads all print through here.</summary>
internal static class Out
{
    private static readonly object Gate = new();
    private static readonly JsonSerializerOptions Options = new() { PropertyNamingPolicy = null };
    private static Stream? stdout;

    public static void Init() => stdout = Console.OpenStandardOutput();

    public static void Emit(object line)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(line, line.GetType(), Options);
        lock (Gate)
        {
            try
            {
                stdout ??= Console.OpenStandardOutput();
                stdout.Write(bytes);
                stdout.WriteByte((byte)'\n');
                stdout.Flush();
            }
            catch (IOException)
            {
                // Apex went away; the stdin loop ends on its own.
            }
        }
    }

    public static void Error(string code, string message, bool fatal, string? session = null, string? source = null)
    {
        var line = new Dictionary<string, object?> { ["type"] = "error" };
        if (session != null) line["session"] = session;
        if (source != null) line["source"] = source;
        line["code"] = code;
        line["message"] = message;
        line["fatal"] = fatal;
        Emit(line);
    }

    public static void Error(HelperException e, string? session = null, string? source = null) => Error(e.Code, e.Message, e.Fatal, session, source);
}

/// <summary>Maps platform failures onto the helper's error codes.</summary>
internal static class Errors
{
    public static HelperException From(Exception ex, string fallback = "failed")
    {
        if (ex is HelperException h) return h;
        if (ex is AggregateException { InnerException: { } inner }) return From(inner, fallback);
        var code = unchecked((uint)ex.HResult) switch
        {
            0x80070005 => "mic-denied", // E_ACCESSDENIED: microphone access is off
            0x80045509 => "speech-denied", // SPERR_SPEECH_PRIVACY_POLICY_NOT_ACCEPTED: online speech recognition is off
            0x8889000A => "mic-busy", // AUDCLNT_E_DEVICE_IN_USE: another app holds it exclusively
            0x88890004 or 0x80070490 or 0x8889000F => "device-missing", // invalidated, not found, endpoint failed
            _ => ex is UnauthorizedAccessException ? "mic-denied" : fallback,
        };
        return new HelperException(code, ex.Message);
    }
}

internal sealed record StartCommand(
    string Session,
    string Mode,
    string Locale,
    string? DeviceId,
    string[] ContextualStrings,
    double MicGain,
    double SystemGain,
    bool Transcribe,
    bool Levels,
    string? RecordPath);

internal sealed record TranscribeCommand(string Session, string Path, string Locale, string[] ContextualStrings);

/// <summary>Reads and checks commands. Anything malformed is an `invalid` error, never a crash.</summary>
internal static class Commands
{
    public const int MaxLine = 256 * 1024;

    public static HelperException Invalid(string message) => new("invalid", message, fatal: false);

    public static JsonElement Parse(string line)
    {
        if (line.Length > MaxLine) throw Invalid("That command is too long.");
        try
        {
            using var doc = JsonDocument.Parse(line);
            return doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            throw Invalid("That command isn't JSON.");
        }
    }

    public static string Name(JsonElement root) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty("cmd", out var c) && c.ValueKind == JsonValueKind.String
            ? c.GetString()!
            : throw Invalid("A command needs a cmd.");

    public static string Str(JsonElement o, string name, int max) => OptStr(o, name, max) ?? throw Invalid($"{name} is missing.");

    public static string? OptStr(JsonElement o, string name, int max)
    {
        if (!o.TryGetProperty(name, out var v) || v.ValueKind == JsonValueKind.Null) return null;
        if (v.ValueKind != JsonValueKind.String) throw Invalid($"{name} must be a string.");
        var s = v.GetString()!;
        if (s.Length == 0 || s.Length > max) throw Invalid($"{name} is empty or too long.");
        return s;
    }

    public static string OneOf(JsonElement o, string name, params string[] allowed)
    {
        var s = Str(o, name, 32);
        return Array.IndexOf(allowed, s) >= 0 ? s : throw Invalid($"{name} must be one of {string.Join(", ", allowed)}.");
    }

    public static double Num(JsonElement o, string name, double min, double max, double fallback)
    {
        if (!o.TryGetProperty(name, out var v) || v.ValueKind == JsonValueKind.Null) return fallback;
        if (v.ValueKind != JsonValueKind.Number || !v.TryGetDouble(out var d) || !double.IsFinite(d)) throw Invalid($"{name} must be a number.");
        return Math.Clamp(d, min, max);
    }

    public static int Int(JsonElement o, string name, int min, int max)
    {
        if (!o.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var i)) throw Invalid($"{name} must be a whole number.");
        return i >= min && i <= max ? i : throw Invalid($"{name} is out of range.");
    }

    public static bool Bool(JsonElement o, string name, bool fallback)
    {
        if (!o.TryGetProperty(name, out var v)) return fallback;
        return v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Null => fallback,
            _ => throw Invalid($"{name} must be true or false."),
        };
    }

    public static string[] Strs(JsonElement o, string name, int maxItems, int maxLength)
    {
        if (!o.TryGetProperty(name, out var v) || v.ValueKind == JsonValueKind.Null) return [];
        if (v.ValueKind != JsonValueKind.Array) throw Invalid($"{name} must be a list.");
        var list = new List<string>();
        foreach (var item in v.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String) throw Invalid($"{name} must hold strings.");
            var s = item.GetString()!;
            if (s.Length > 0 && s.Length <= maxLength && list.Count < maxItems) list.Add(s);
        }
        return [.. list];
    }

    public static StartCommand Start(JsonElement o)
    {
        string? record = null;
        if (o.TryGetProperty("record", out var r) && r.ValueKind == JsonValueKind.Object) record = Str(r, "path", 4096);
        else if (r.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined)) throw Invalid("record must be {path} or null.");
        return new StartCommand(
            Session: Str(o, "session", 100),
            Mode: OneOf(o, "mode", "dictation", "meeting"),
            Locale: Str(o, "locale", 64),
            DeviceId: OptStr(o, "deviceId", 512),
            ContextualStrings: Strs(o, "contextualStrings", 100, 60),
            MicGain: Num(o, "micGain", 0.25, 4, 1),
            SystemGain: Num(o, "systemGain", 0.25, 4, 1),
            Transcribe: Bool(o, "transcribe", true),
            Levels: Bool(o, "levels", false),
            RecordPath: record);
    }

    public static TranscribeCommand Transcribe(JsonElement o) => new(
        Session: Str(o, "session", 100),
        Path: Str(o, "path", 4096),
        Locale: Str(o, "locale", 64),
        ContextualStrings: Strs(o, "contextualStrings", 100, 60));
}
