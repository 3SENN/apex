/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-speech.exe: permissions, mapped onto the macOS helper's three.
//
//   microphone: Windows' microphone switches (machine, this user, desktop
//               apps), then AppCapability 'microphone'.
//   speech:     "Online speech recognition", which WinRT dictation needs.
//   screen:     always granted: loopback capture needs no permission.
//
// Like the macOS helper, reading never prompts; `request` asks AppCapability
// for the microphone, and opens the right Settings page when Windows can't
// ask in place.
using System.Diagnostics;
using Microsoft.Win32;
using Windows.Security.Authorization.AppCapabilityAccess;

namespace Atelier.Speech;

internal static class Permissions
{
    private const string MicrophoneStore = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    private const string OnlineSpeech = @"Software\Microsoft\Speech_OneCore\Settings\OnlineSpeechPrivacy";

    public static string Microphone()
    {
        if (Denied(Registry.LocalMachine, MicrophoneStore)) return "restricted";
        if (Denied(Registry.CurrentUser, MicrophoneStore) || Denied(Registry.CurrentUser, MicrophoneStore + @"\NonPackaged")) return "denied";
        try
        {
            return AppCapability.Create("microphone").CheckAccess() switch
            {
                AppCapabilityAccessStatus.DeniedByUser => "denied",
                AppCapabilityAccessStatus.DeniedBySystem => "restricted",
                AppCapabilityAccessStatus.UserPromptRequired => "not-determined",
                // Allowed, or NotDeclaredByApp: an unpackaged app has no manifest, and the switches above govern it.
                _ => "granted",
            };
        }
        catch
        {
            return "granted";
        }
    }

    public static string Speech()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(OnlineSpeech);
            return (key?.GetValue("HasAccepted") as int?) switch
            {
                1 => "granted",
                0 => "denied",
                _ => "not-determined",
            };
        }
        catch
        {
            return "not-determined";
        }
    }

    public static object Line() => new { type = "permissions", microphone = Microphone(), speech = Speech(), screen = "granted" };

    public static async Task<object> RequestAsync(string what)
    {
        if (what == "microphone")
        {
            try
            {
                await AppCapability.Create("microphone").RequestAccessAsync();
            }
            catch
            {
                // Unpackaged apps often can't be asked in place.
            }
            if (Microphone() != "granted") OpenSettings("ms-settings:privacy-microphone");
        }
        else if (what == "speech" && Speech() != "granted")
        {
            OpenSettings("ms-settings:privacy-speech");
        }
        return Line();
    }

    private static bool Denied(RegistryKey hive, string path)
    {
        try
        {
            using var key = hive.OpenSubKey(path);
            return string.Equals(key?.GetValue("Value") as string, "Deny", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static void OpenSettings(string uri)
    {
        try
        {
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true })?.Dispose();
        }
        catch
        {
            // No Settings app (Server Core); the checklist still explains.
        }
    }
}
