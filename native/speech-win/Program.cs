/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex-speech.exe: Apex's Windows speech helper.
// It speaks protocol v2 exactly as the macOS helper does
// (native/speech), so src/main/speech runs it unchanged:
//
//   stdin:  hello, permissions, request, devices, locales, start, pause,
//           resume, stop, transcribe, authenticate, frontmost, activate,
//           recover
//   stdout: ready, permissions, devices, locales, started, partial, final,
//           level, paused, resumed, interrupted, restored, progress, error,
//           stopped, auth, frontmost, recovered
//
// Commands run one at a time, in order. One session (a recording or a file
// transcription) runs at a time; `stop` ends either. Closing stdin stops the
// session cleanly (its recording is saved) and exits. The helper never
// prompts on its own: `start` fails fast with an error code.
using System.Text;
using NAudio.MediaFoundation;

namespace Apex.Speech;

internal static class Program
{
    private static async Task<int> Main()
    {
        Out.Init();
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Out.Error("failed", $"The speech helper crashed: {(e.ExceptionObject as Exception)?.Message ?? "unknown error"}", fatal: true);
        TaskScheduler.UnobservedTaskException += (_, e) => e.SetObserved();
        try
        {
            MediaFoundationApi.Startup();
        }
        catch
        {
            // Windows N without the Media Feature Pack: recordings and file transcription fail with their own errors.
        }

        var controller = new Controller();
        using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string? line;
        while ((line = await stdin.ReadLineAsync()) != null)
        {
            if (!string.IsNullOrWhiteSpace(line)) await controller.HandleAsync(line);
        }
        await controller.ShutdownAsync();
        return 0;
    }
}

internal sealed class Controller
{
    private Session? session;
    private Task? transcription;
    private CancellationTokenSource? transcriptionCancel;

    private bool Busy => session != null || transcription is { IsCompleted: false };

    public async Task HandleAsync(string line)
    {
        string cmd;
        System.Text.Json.JsonElement root;
        try
        {
            root = Commands.Parse(line);
            cmd = Commands.Name(root);
        }
        catch (Exception ex)
        {
            Out.Error(Errors.From(ex, "invalid"));
            return;
        }

        string? sessionId = null;
        try
        {
            switch (cmd)
            {
                case "hello":
                    Out.Emit(new { type = "ready", version = Protocol.Version });
                    break;
                case "permissions":
                    Out.Emit(Permissions.Line());
                    break;
                case "request":
                    Out.Emit(await Permissions.RequestAsync(Commands.OneOf(root, "what", "microphone", "speech", "screen")));
                    break;
                case "devices":
                    Out.Emit(Devices.Line());
                    break;
                case "locales":
                    Out.Emit(Devices.Locales());
                    break;
                case "start":
                {
                    sessionId = Commands.OptStr(root, "session", 100);
                    var start = Commands.Start(root);
                    if (Busy) throw new HelperException("busy", "Another session is running.");
                    session = await Session.StartAsync(start);
                    break;
                }
                case "pause":
                    await Current().PauseAsync();
                    break;
                case "resume":
                    await Current().ResumeAsync();
                    break;
                case "stop":
                    await StopAsync();
                    break;
                case "transcribe":
                {
                    sessionId = Commands.OptStr(root, "session", 100);
                    var job = Commands.Transcribe(root);
                    if (Busy) throw new HelperException("busy", "Another session is running.");
                    Transcribe(job);
                    break;
                }
                case "authenticate":
                {
                    var id = Commands.Str(root, "id", 100);
                    var reason = Commands.Str(root, "reason", 500);
                    // Windows Hello waits for the person; other commands carry on meanwhile.
                    _ = Task.Run(async () => Out.Emit(new { type = "auth", id, result = await Apps.AuthenticateAsync(reason) }));
                    break;
                }
                case "frontmost":
                    Out.Emit(Apps.Frontmost());
                    break;
                case "activate":
                    Apps.Activate(Commands.Int(root, "pid", 1, int.MaxValue));
                    break;
                case "recover":
                {
                    var id = Commands.Str(root, "id", 200);
                    var path = Commands.Str(root, "path", 4096);
                    // Beside any session: the parts belong to none that is running. Encoding a long one takes a while.
                    _ = Task.Run(() => Recover(id, path));
                    break;
                }
                default:
                    throw Commands.Invalid($"Unknown command {cmd}.");
            }
        }
        catch (Exception ex)
        {
            var e = Errors.From(ex);
            // A start or transcribe that failed never began: fatal for that session id.
            var opening = cmd is "start" or "transcribe";
            Out.Error(e.Code, e.Message, fatal: opening, opening ? sessionId : null);
        }
    }

    private Session Current() => session ?? throw Commands.Invalid("Nothing is recording.");

    /// <summary>A recording a session never finished (Apex crashed, was force quit, or Windows ended the session): put back together from its parts.</summary>
    private static void Recover(string id, string path)
    {
        try
        {
            var result = Recorder.Recover(path);
            Out.Emit(new
            {
                type = "recovered",
                id,
                audio = result is { } r ? new { path = r.Audio.Path, bytes = r.Audio.Bytes } : null,
                durationMs = result is { } d ? Math.Round(d.DurationMs) : 0,
            });
        }
        catch (Exception ex)
        {
            Out.Emit(new { type = "recovered", id, audio = (object?)null, durationMs = 0, error = Errors.From(ex, "recording-failed").Message });
        }
    }

    private void Transcribe(TranscribeCommand job)
    {
        var cancel = new CancellationTokenSource();
        transcriptionCancel = cancel;
        transcription = Task.Run(async () =>
        {
            try
            {
                await FileTranscriber.RunAsync(job, cancel.Token);
            }
            catch (Exception ex)
            {
                var e = Errors.From(ex);
                Out.Error(e.Code, e.Message, fatal: true, job.Session);
            }
        });
    }

    private async Task StopAsync()
    {
        if (transcription is { IsCompleted: false })
        {
            transcriptionCancel?.Cancel();
            return;
        }
        var current = Current();
        session = null;
        await current.StopAsync();
    }

    public async Task ShutdownAsync()
    {
        transcriptionCancel?.Cancel();
        if (session != null)
        {
            var current = session;
            session = null;
            try
            {
                await current.StopAsync();
            }
            catch
            {
                // Exiting anyway.
            }
        }
        if (transcription != null) await Task.WhenAny(transcription, Task.Delay(2_000));
    }
}
