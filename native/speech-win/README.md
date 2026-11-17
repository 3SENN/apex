# apex-speech.exe, the Windows speech helper

Apex's speech helper for Windows. It does what
`native/speech` does on macOS, and speaks exactly the same JSON-lines protocol
v2: one command per line on stdin, one reply or event per
line on stdout, and nothing else on stdout. Main's parser
(`src/main/speech/protocol.ts`) cannot tell the two helpers apart;
`tests/speechProtocol.test.ts` runs a transcript from each
(`tests/fixtures/speech/*.jsonl`) through it to prove that.

## What runs where

| Source | How | `source` |
|---|---|---|
| Microphone | `Windows.Media.SpeechRecognition.SpeechRecognizer`, continuous dictation (`MicRecognizer.cs`) | `mic` |
| System audio | WASAPI loopback (NAudio.Wasapi), resampled to 16 kHz mono, into System.Speech's `SpeechRecognitionEngine` with a `DictationGrammar` through `SetInputToAudioStream` (`LoopbackRecognizer.cs`) | `system` |
| Files | System.Speech, from a decoded file (`FileTranscriber.cs`) | `mic` |

- `Session.cs` holds one session at a time: capture, levels, `pause` and
  `resume` (paused audio is neither transcribed nor recorded), and `stop`.
- `Recorder.cs` writes each source as a WAV part and mixes the parts into the
  AAC `.m4a` Apex asked for, through Media Foundation.
- `Devices.cs` lists capture devices and dictation languages; `Apps.cs` answers
  `frontmost`, `activate` and `authenticate` (Windows Hello).
- `Protocol.cs` reads commands strictly (anything malformed is an `invalid`
  error, never a crash) and maps Windows failures onto the speech helper's error codes
  (`mic-denied`, `speech-denied`, `mic-busy`, `device-missing`,
  `locale-unsupported`, `no-speech`, `recording-failed`, `failed`).

Commands: `hello`, `permissions`, `request`, `devices`, `locales`, `start`,
`pause`, `resume`, `stop`, `transcribe`, `authenticate`, `frontmost`,
`activate`. The lid line (`{"type":"lid"}`) is macOS-only; on Windows, Apex
pauses a meeting recording on Electron's `powerMonitor` `suspend` instead.

## Permissions

`permissions` maps Windows onto the macOS helper's three answers, and never
prompts:

- `microphone`: Windows' microphone switches (this PC, this user, desktop
  apps), then `AppCapability` `microphone`. `request` asks through
  AppCapability and opens Settings › Privacy › Microphone when Windows can't
  ask in place.
- `speech`: Settings › Privacy › Speech › Online speech recognition, which the
  dictation topic needs.
- `screen`: always `granted`. Loopback capture needs no permission, so
  `started.systemAudio` is true whenever an output device is there.

## On-device or not

System audio and files are transcribed on this PC. Microphone dictation goes
through Microsoft's online speech service, so the helper is honest about it:
`started.onDevice` is false while it transcribes (true for a recording that
only captures audio), and every `locales` item has `onDevice: false`. Apex's
privacy wording reads these flags, so it never claims on-device dictation on
Windows.

## Building

It needs the .NET 8 SDK and Windows, so it is built in CI (the
`windows-latest` release job), never on a Mac:

```sh
node scripts/build-speech-helper.mjs              # this machine's architecture
node scripts/build-speech-helper.mjs --arch=arm64 # or x64
```

`build.mjs` runs `dotnet publish` (self-contained, single file, not trimmed)
into `build/win-<arch>/` and copies the result to `build/apex-speech.exe`.
Apex runs that file in development (`speechHelperPath()` in
`src/main/speech/helper.ts`), and electron-builder packages it as
`resources/apex-speech.exe`. On Linux the helper is unavailable, and Apex
says so.

## Dependencies

- NAudio.Wasapi 2.2.1 (MIT): WASAPI capture and loopback, Media Foundation.
- System.Speech 8.0.0 (MIT): the desktop recogniser.
