/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-speech.exe: microphones (WASAPI capture endpoints) and the languages
// Windows can dictate in.
using System.Globalization;
using NAudio.CoreAudioApi;
using Windows.Media.SpeechRecognition;

namespace Atelier.Speech;

internal static class Devices
{
    // PKEY_Device_EnumeratorName: "USB" and "BTHENUM" mean a plugged-in or Bluetooth microphone.
    private static readonly PropertyKey EnumeratorName = new(new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 24);

    public static string? DefaultCaptureId()
    {
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            using var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Console);
            return device.ID;
        }
        catch
        {
            return null;
        }
    }

    public static object Line()
    {
        var items = new List<object>();
        try
        {
            var defaultId = DefaultCaptureId();
            using var enumerator = new MMDeviceEnumerator();
            foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active))
            {
                using (device)
                {
                    if (items.Count >= 200) continue;
                    items.Add(new { id = device.ID, name = device.FriendlyName, builtIn = BuiltIn(device), isDefault = device.ID == defaultId });
                }
            }
        }
        catch
        {
            // No audio service: an empty list, and start reports device-missing.
        }
        return new { type = "devices", items };
    }

    private static bool BuiltIn(MMDevice device)
    {
        try
        {
            if (!device.Properties.Contains(EnumeratorName)) return true;
            var bus = device.Properties[EnumeratorName].Value as string ?? "";
            return !(bus.StartsWith("USB", StringComparison.OrdinalIgnoreCase) || bus.StartsWith("BTH", StringComparison.OrdinalIgnoreCase));
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Dictation languages. None is on-device: Windows sends dictation to its online service.</summary>
    public static object Locales()
    {
        var items = new List<object>();
        string system = CultureInfo.CurrentUICulture.Name;
        try
        {
            system = SpeechRecognizer.SystemSpeechLanguage?.LanguageTag ?? system;
            foreach (var language in SpeechRecognizer.SupportedTopicLanguages)
                items.Add(new { id = language.LanguageTag, name = language.DisplayName, onDevice = false });
        }
        catch
        {
            // Speech isn't installed; start reports locale-unsupported.
        }
        return new { type = "locales", system = string.IsNullOrEmpty(system) ? "en-US" : system, items };
    }
}
