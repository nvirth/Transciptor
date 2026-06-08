#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const DEFAULTS = Object.freeze({
  language: "Hungarian",
  model: "small",
  format: "srt",
  task: "transcribe",
});

const VALUE_OPTIONS = new Map([
  ["--language", "language"],
  ["-l", "language"],
  ["--model", "model"],
  ["-m", "model"],
  ["--format", "format"],
  ["-f", "format"],
  ["--output-dir", "outputDir"],
  ["-o", "outputDir"],
  ["--task", "task"],
]);

const VALID_FORMATS = new Set(["txt", "vtt", "srt", "tsv", "json", "all"]);
const VALID_TASKS = new Set(["transcribe", "translate"]);
const ALL_OUTPUT_FORMATS = ["txt", "vtt", "srt", "tsv", "json"];

function parseArgs(argv) {
  const options = {
    ...DEFAULTS,
    outputDir: null,
    install: false,
    dryRun: false,
    help: false,
    input: null,
  };

  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index];

    if (!positionalOnly && rawArg === "--") {
      positionalOnly = true;
      continue;
    }

    if (!positionalOnly && (rawArg === "--help" || rawArg === "-h")) {
      options.help = true;
      continue;
    }

    if (!positionalOnly && rawArg === "--install") {
      options.install = true;
      continue;
    }

    if (!positionalOnly && rawArg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (!positionalOnly && rawArg.startsWith("--") && rawArg.includes("=")) {
      const separator = rawArg.indexOf("=");
      const optionName = rawArg.slice(0, separator);
      const optionValue = rawArg.slice(separator + 1);
      const propertyName = VALUE_OPTIONS.get(optionName);

      if (!propertyName) {
        throw new Error(`Unknown option: ${optionName}`);
      }
      if (!optionValue) {
        throw new Error(`Missing value for ${optionName}`);
      }

      options[propertyName] = optionValue;
      continue;
    }

    if (!positionalOnly && rawArg.startsWith("-")) {
      const propertyName = VALUE_OPTIONS.get(rawArg);

      if (!propertyName) {
        throw new Error(`Unknown option: ${rawArg}`);
      }

      const optionValue = argv[index + 1];
      if (!optionValue || optionValue.startsWith("-")) {
        throw new Error(`Missing value for ${rawArg}`);
      }

      options[propertyName] = optionValue;
      index += 1;
      continue;
    }

    if (options.input) {
      throw new Error("Only one input audio file can be transcribed at a time.");
    }
    options.input = rawArg;
  }

  if (!VALID_FORMATS.has(options.format)) {
    throw new Error(
      `Unsupported format "${options.format}". Use: ${[...VALID_FORMATS].join(", ")}.`,
    );
  }

  if (!VALID_TASKS.has(options.task)) {
    throw new Error(`Unsupported task "${options.task}". Use: transcribe or translate.`);
  }

  return options;
}

function buildWhisperArgs(options, inputPath, outputDir) {
  return [
    "-u",
    "-m",
    "whisper",
    inputPath,
    "--language",
    options.language,
    "--model",
    options.model,
    "--output_format",
    options.format,
    "--output_dir",
    outputDir,
    "--task",
    options.task,
    "--verbose",
    "True",
  ];
}

function normalizeSrtTimestamp(timestamp) {
  const withHours = timestamp.split(":").length === 2
    ? `00:${timestamp}`
    : timestamp;
  return withHours.replace(".", ",");
}

function formatSrtCue(index, start, end, text) {
  return [
    index,
    `${normalizeSrtTimestamp(start)} --> ${normalizeSrtTimestamp(end)}`,
    text.trim(),
    "",
    "",
  ].join("\n");
}

function createSrtStreamParser(onCue) {
  let buffer = "";
  let cueIndex = 0;
  const timestamp = "(?:\\d{2}:)?\\d{2}:\\d{2}\\.\\d{3}";
  const segmentPattern = new RegExp(
    `^\\[(${timestamp}) --> (${timestamp})\\]\\s*(.*)$`,
  );

  function consumeLine(rawLine) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = segmentPattern.exec(line);
    if (!match) {
      return;
    }

    cueIndex += 1;
    onCue(formatSrtCue(cueIndex, match[1], match[2], match[3]));
  }

  return {
    push(text) {
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(consumeLine);
    },
    end(text = "") {
      this.push(text);
      if (buffer) {
        consumeLine(buffer);
      }
      buffer = "";
    },
  };
}

function quoteForDisplay(value) {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

function printCommand(command, args) {
  console.log([command, ...args].map(quoteForDisplay).join(" "));
}

function tryCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
  });

  return !result.error && result.status === 0;
}

function findPython() {
  const candidates = process.env.PYTHON
    ? [{ command: process.env.PYTHON, prefix: [] }]
    : [
        { command: "py", prefix: ["-3"] },
        { command: "python", prefix: [] },
        { command: "python3", prefix: [] },
      ];

  return candidates.find(({ command, prefix }) =>
    tryCommand(command, [...prefix, "--version"]),
  );
}

function hasWhisper(python) {
  return tryCommand(python.command, [
    ...python.prefix,
    "-c",
    "import whisper",
  ]);
}

function hasFfmpeg() {
  return tryCommand("ffmpeg", ["-version"]);
}

function runInherited(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    windowsHide: false,
  });

  if (result.error) {
    throw new Error(`Could not start ${command}: ${result.error.message}`);
  }

  return result.status ?? 1;
}

function runWhisperStreaming(command, args, liveSrtPath) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    const parser = createSrtStreamParser((cue) => {
      fs.appendFileSync(liveSrtPath, cue, "utf8");
    });
    const child = spawn(command, args, {
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: false,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
      },
    });
    let streamError = null;

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      if (streamError) {
        return;
      }

      try {
        parser.push(decoder.write(chunk));
      } catch (error) {
        streamError = error;
        child.kill();
      }
    });

    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      reject(new Error(`Could not start ${command}: ${error.message}`));
    });

    child.on("close", (status) => {
      try {
        parser.end(decoder.end());
      } catch (error) {
        streamError ??= error;
      }

      if (streamError) {
        reject(streamError);
        return;
      }

      resolve(status ?? 1);
    });
  });
}

function outputPath(outputDir, inputPath, extension) {
  return path.join(outputDir, `${path.parse(inputPath).name}.${extension}`);
}

function promoteWhisperOutputs(tempDir, outputDir, inputPath, format) {
  const formats = format === "all" ? ALL_OUTPUT_FORMATS : [format];

  for (const extension of formats) {
    const source = outputPath(tempDir, inputPath, extension);
    const destination = outputPath(outputDir, inputPath, extension);

    if (!fs.existsSync(source)) {
      throw new Error(`Whisper did not create the expected file: ${source}`);
    }

    fs.copyFileSync(source, destination);
  }
}

function installDependencies(python) {
  console.log("Installing/updating OpenAI Whisper...");
  const pipStatus = runInherited(python.command, [
    ...python.prefix,
    "-m",
    "pip",
    "install",
    "--upgrade",
    "openai-whisper",
  ]);

  if (pipStatus !== 0) {
    throw new Error(`Whisper installation failed with exit code ${pipStatus}.`);
  }

  if (hasFfmpeg()) {
    console.log("FFmpeg is already installed.");
    return;
  }

  if (!tryCommand("winget", ["--version"])) {
    throw new Error(
      "FFmpeg is missing and winget is unavailable. Install FFmpeg, then run this script again.",
    );
  }

  console.log("Installing FFmpeg with winget...");
  const ffmpegStatus = runInherited("winget", [
    "install",
    "--id",
    "Gyan.FFmpeg",
    "--exact",
    "--accept-package-agreements",
    "--accept-source-agreements",
  ]);

  if (ffmpegStatus !== 0) {
    throw new Error(`FFmpeg installation failed with exit code ${ffmpegStatus}.`);
  }

  if (!hasFfmpeg()) {
    console.warn(
      "FFmpeg was installed, but this terminal cannot see it yet. Open a new terminal before transcribing.",
    );
  }
}

function printHelp() {
  console.log(`
Transciptor - create timestamped transcripts with local OpenAI Whisper

Usage:
  node transcribe.js <audio-file> [options]
  transcribe.bat <audio-file> [options]
  transcribe.bat --install

Options:
  -l, --language <name>    Spoken language (default: Hungarian)
  -m, --model <name>       Whisper model (default: small)
  -f, --format <format>    txt, vtt, srt, tsv, json, or all (default: srt)
  -o, --output-dir <path>  Output folder (default: next to the audio file)
      --task <task>        transcribe or translate (default: transcribe)
      --install            Install/update Whisper and install FFmpeg if needed
      --dry-run            Print the Whisper command without running it
  -h, --help               Show this help

Examples:
  transcribe.bat "C:\\Audio\\lecture.mp3"
  transcribe.bat "lecture.mp3" --model base --format srt
  transcribe.bat "lecture.mp3" -l English -o "C:\\Transcripts"
`.trim());
}

async function main(argv = process.argv.slice(2)) {
  let options;

  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error('Run "transcribe.bat --help" for usage.');
    return 2;
  }

  if (options.help) {
    printHelp();
    return 0;
  }

  const python = findPython();
  if (!python) {
    console.error(
      "Error: Python 3 was not found. Install Python 3, then run transcribe.bat --install.",
    );
    return 1;
  }

  try {
    if (options.install) {
      installDependencies(python);
      if (!options.input) {
        console.log("Dependencies are ready.");
        return 0;
      }
    }

    if (!options.input) {
      printHelp();
      return 2;
    }

    const inputPath = path.resolve(options.input);
    if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
      throw new Error(`Input file does not exist: ${inputPath}`);
    }

    const outputDir = options.outputDir
      ? path.resolve(options.outputDir)
      : path.dirname(inputPath);
    const whisperArgs = [
      ...python.prefix,
      ...buildWhisperArgs(options, inputPath, outputDir),
    ];

    if (options.dryRun) {
      printCommand(python.command, whisperArgs);
      return 0;
    }

    if (!hasWhisper(python)) {
      throw new Error(
        "OpenAI Whisper is not installed. Run transcribe.bat --install first.",
      );
    }

    if (!hasFfmpeg()) {
      throw new Error(
        "FFmpeg is not installed or not on PATH. Run transcribe.bat --install first.",
      );
    }

    fs.mkdirSync(outputDir, { recursive: true });

    console.log(`Input:  ${inputPath}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Model:  ${options.model}`);
    console.log(`Language: ${options.language}`);
    console.log("");

    const writesSrt = options.format === "srt" || options.format === "all";
    let tempOutputDir = null;

    try {
      if (writesSrt) {
        const liveSrtPath = outputPath(outputDir, inputPath, "srt");
        tempOutputDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "transciptor-"),
        );
        const streamingArgs = [
          ...python.prefix,
          ...buildWhisperArgs(options, inputPath, tempOutputDir),
        ];

        fs.writeFileSync(liveSrtPath, "", "utf8");
        console.log(`Live SRT: ${liveSrtPath}`);
        console.log("");

        const status = await runWhisperStreaming(
          python.command,
          streamingArgs,
          liveSrtPath,
        );
        if (status !== 0) {
          throw new Error(
            `Whisper exited with code ${status}. Partial SRT kept at: ${liveSrtPath}`,
          );
        }

        promoteWhisperOutputs(
          tempOutputDir,
          outputDir,
          inputPath,
          options.format,
        );
      } else {
        const status = runInherited(python.command, whisperArgs);
        if (status !== 0) {
          throw new Error(`Whisper exited with code ${status}.`);
        }
      }
    } finally {
      if (tempOutputDir) {
        fs.rmSync(tempOutputDir, { recursive: true, force: true });
      }
    }

    console.log(`\nTranscript created in: ${outputDir}`);
    return 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULTS,
  buildWhisperArgs,
  createSrtStreamParser,
  formatSrtCue,
  main,
  normalizeSrtTimestamp,
  parseArgs,
  quoteForDisplay,
};
