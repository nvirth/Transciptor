# Transciptor

A small Windows wrapper around
[OpenAI Whisper](https://github.com/openai/whisper) that creates timestamped
transcripts from audio or video files.

The defaults match the original use case:

- language: Hungarian
- model: `small`
- output: `.srt`
- output location: next to the input file

Audio is processed locally. The script does not upload it anywhere.

## Requirements

- Windows
- Node.js 18 or newer
- Python 3

FFmpeg and the Python Whisper package can be installed by the setup command.

## First setup

Open PowerShell in this folder and run:

```powershell
.\transcribe.bat --install
```

This installs or updates `openai-whisper` with `pip`. If FFmpeg is missing, it
also installs `Gyan.FFmpeg` with `winget`.

Whisper downloads the selected speech model the first time that model is used.
The `small` model is more accurate than `base`, but it is slower and has a
larger download.

## Create a transcript

Drag an audio file onto `transcribe.bat`, or run:

```powershell
.\transcribe.bat "F:\Audio\lecture.mp3"
```

For `F:\Audio\lecture.mp3`, the default result is:

```text
F:\Audio\lecture.srt
```

The SRT file is created when transcription starts and is appended after each
recognized segment. You can open it during a long run to inspect the partial
transcript. When Whisper finishes successfully, the partial file is replaced
with Whisper's finalized SRT. If processing fails or is interrupted, the
partial SRT remains available.

The SRT file includes timestamps and can be searched for phrases such as
`elhárító mechanizmusok`.

## Options

```text
-l, --language <name>    Spoken language (default: Hungarian)
-m, --model <name>       Whisper model (default: small)
-f, --format <format>    txt, vtt, srt, tsv, json, or all
-o, --output-dir <path>  Output folder
    --task <task>        transcribe or translate
    --install            Install/update Whisper and FFmpeg
    --dry-run            Print the command without running it
-h, --help               Show help
```

Examples:

```powershell
# Faster model
.\transcribe.bat "lecture.mp3" --model base

# English audio, saved to a separate folder
.\transcribe.bat "lecture.mp3" --language English --output-dir ".\transcripts"

# Inspect the generated Whisper command
.\transcribe.bat "lecture.mp3" --dry-run
```

## Troubleshooting

If setup installs FFmpeg but the script still cannot find it, close PowerShell,
open a new one, and run the transcription command again.

Long recordings can take a while on a CPU. Use `--model base` for a faster,
less accurate first pass.

Run the automated tests with:

```powershell
npm test
```
