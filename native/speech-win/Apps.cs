/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-speech.exe: the launcher's fallbacks (frontmost, activate) and the
// device-owner check (authenticate) through Windows Hello.
using System.Diagnostics;
using System.Runtime.InteropServices;
using Windows.Security.Credentials.UI;

namespace Atelier.Speech;

internal static class Apps
{
    private const int SwRestore = 9;

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindowAsync(IntPtr window, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr window);

    public static IntPtr ForegroundWindow() => GetForegroundWindow();

    /// <summary>The foreground app; Windows has no bundle ids, so its process name stands in.</summary>
    public static object Frontmost()
    {
        int? pid = null;
        string? name = null;
        var window = GetForegroundWindow();
        if (window != IntPtr.Zero && GetWindowThreadProcessId(window, out var id) != 0 && id != 0)
        {
            pid = (int)id;
            try
            {
                using var process = Process.GetProcessById((int)id);
                name = process.ProcessName;
            }
            catch
            {
                // It quit in between.
            }
        }
        return new { type = "frontmost", pid, bundleId = name };
    }

    public static void Activate(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            var window = process.MainWindowHandle;
            if (window == IntPtr.Zero) return;
            if (IsIconic(window)) ShowWindowAsync(window, SwRestore);
            SetForegroundWindow(window);
        }
        catch
        {
            // Gone, or Windows refused the focus change; nothing to report (the protocol has no reply for this).
        }
    }

    /// <summary>Windows Hello, parented to the foreground window (Atelier's, when it asks).</summary>
    public static async Task<string> AuthenticateAsync(string reason)
    {
        try
        {
            if (await UserConsentVerifier.CheckAvailabilityAsync() != UserConsentVerifierAvailability.Available) return "unavailable";
            var result = await UserConsentVerifierInterop.RequestVerificationForWindowAsync(GetForegroundWindow(), reason);
            return result switch
            {
                UserConsentVerificationResult.Verified => "ok",
                UserConsentVerificationResult.Canceled or UserConsentVerificationResult.RetriesExhausted => "cancelled",
                _ => "unavailable",
            };
        }
        catch
        {
            return "unavailable";
        }
    }
}
