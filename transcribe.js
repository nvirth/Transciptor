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
  ["--parallel", "parallel"],
  ["--parallel-count", "parallel"],
  ["-j", "parallel"],
]);

const VALID_FORMATS = new Set(["txt", "vtt", "srt", "tsv", "json", "all"]);
const VALID_TASKS = new Set(["transcribe", "translate"]);
const ALL_OUTPUT_FORMATS = ["txt", "vtt", "srt", "tsv", "json"];

function parseFileArrayArgument(rawArg) {
  try {
    const parsed = JSON.parse(rawArg);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Windows shells may remove the quotes inside a JSON-like array.
  }

  return rawArg
    .slice(1, -1)
    .split(",")
    .map((value) => value.trim().replace(/^(["'])(.*)\1$/, "$2"));
}

function parseArgs(argv) {
  const options = {
    ...DEFAULTS,
    outputDir: null,
    install: false,
    dryRun: false,
    help: false,
    parallel: 1,
    inputs: [],
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

    if (rawArg.startsWith("[") && rawArg.endsWith("]")) {
      const parsed = parseFileArrayArgument(rawArg);

      if (
        !Array.isArray(parsed) ||
        parsed.length === 0 ||
        parsed.some((value) => typeof value !== "string" || !value)
      ) {
        throw new Error("The file array must contain one or more file names.");
      }

      options.inputs.push(...parsed);
      continue;
    }

    options.inputs.push(rawArg);
  }

  if (!VALID_FORMATS.has(options.format)) {
    throw new Error(
      `Unsupported format "${options.format}". Use: ${[...VALID_FORMATS].join(", ")}.`,
    );
  }

  if (!VALID_TASKS.has(options.task)) {
    throw new Error(`Unsupported task "${options.task}". Use: transcribe or translate.`);
  }

  const parallel = Number(options.parallel);
  if (!Number.isInteger(parallel) || parallel < 1) {
    throw new Error('Parallel count must be a positive integer, for example "--parallel 2".');
  }
  options.parallel = parallel;

  return options;
}

function buildWhisperArgs(options, inputPath, outputDir, resumeSeconds = 0) {
  const args = [
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

  if (resumeSeconds > 0) {
    args.push("--clip_timestamps", resumeSeconds.toFixed(3));
  }

  return args;
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

function parseSrtTimestamp(timestamp) {
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(timestamp.trim());
  if (!match) {
    throw new Error(`Invalid SRT timestamp: ${timestamp}`);
  }

  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  );
}

function formatSecondsAsSrt(seconds) {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const afterHours = totalMilliseconds - hours * 3_600_000;
  const minutes = Math.floor(afterHours / 60_000);
  const afterMinutes = afterHours - minutes * 60_000;
  const wholeSeconds = Math.floor(afterMinutes / 1000);
  const milliseconds = afterMinutes - wholeSeconds * 1000;

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    `${String(wholeSeconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`,
  ].join(":");
}

function formatSrtCueFromSeconds(index, start, end, text) {
  return [
    index,
    `${formatSecondsAsSrt(start)} --> ${formatSecondsAsSrt(end)}`,
    text.trim(),
    "",
    "",
  ].join("\n");
}

function parseSrtCues(content) {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) {
      continue;
    }

    const lines = trimmed.split("\n");
    if (!/^\d+$/.test(lines[0] ?? "")) {
      break;
    }

    const timing = /^(\d+:\d{2}:\d{2}[,.]\d{3})\s+-->\s+(\d+:\d{2}:\d{2}[,.]\d{3})/.exec(
      lines[1] ?? "",
    );
    const text = lines.slice(2).join("\n").trim();
    if (!timing || !text) {
      break;
    }

    const start = parseSrtTimestamp(timing[1]);
    const end = parseSrtTimestamp(timing[2]);
    if (end < start || (cues.length > 0 && end <= cues.at(-1).end)) {
      break;
    }

    cues.push({ start, end, text });
  }

  return cues;
}

function serializeSrtCues(cues) {
  return cues
    .map((cue, index) =>
      formatSrtCueFromSeconds(index + 1, cue.start, cue.end, cue.text),
    )
    .join("");
}

function readResumeState(srtPath) {
  if (!fs.existsSync(srtPath)) {
    return { cues: [], resumeSeconds: 0 };
  }

  const cues = parseSrtCues(fs.readFileSync(srtPath, "utf8"));
  return {
    cues,
    resumeSeconds: cues.length > 0 ? cues.at(-1).end : 0,
  };
}

function createSrtStreamParser(onCue, startIndex = 0) {
  let buffer = "";
  let cueIndex = startIndex;
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

function runWhisperStreaming(command, args, liveSrtPath, startIndex = 0) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    const parser = createSrtStreamParser((cue) => {
      fs.appendFileSync(liveSrtPath, cue, "utf8");
    }, startIndex);
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

function runAsyncInherited(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      windowsHide: false,
    });

    child.on("error", (error) => {
      reject(new Error(`Could not start ${command}: ${error.message}`));
    });
    child.on("close", (status) => {
      resolve(status ?? 1);
    });
  });
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      try {
        results[currentIndex] = {
          status: "fulfilled",
          value: await worker(items[currentIndex], currentIndex),
        };
      } catch (error) {
        results[currentIndex] = {
          status: "rejected",
          reason: error,
        };
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, runNext));
  return results;
}

function outputPath(outputDir, inputPath, extension) {
  return path.join(outputDir, `${path.parse(inputPath).name}.${extension}`);
}

function promoteWhisperOutputs(
  tempDir,
  outputDir,
  inputPath,
  format,
  existingCues = [],
) {
  const formats = format === "all" ? ALL_OUTPUT_FORMATS : [format];

  for (const extension of formats) {
    const source = outputPath(tempDir, inputPath, extension);
    const destination = outputPath(outputDir, inputPath, extension);

    if (!fs.existsSync(source)) {
      throw new Error(`Whisper did not create the expected file: ${source}`);
    }

    if (extension === "srt") {
      const resumedCues = parseSrtCues(fs.readFileSync(source, "utf8"));
      const resumeSeconds = existingCues.length > 0
        ? existingCues.at(-1).end
        : 0;
      const newCues = resumedCues.filter(
        (cue) => cue.end > resumeSeconds + 0.001,
      );
      fs.writeFileSync(
        destination,
        serializeSrtCues([...existingCues, ...newCues]),
        "utf8",
      );
    } else {
      fs.copyFileSync(source, destination);
    }
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
  node transcribe.js <audio-file...> [options]
  transcribe.bat <audio-file...> [options]
  transcribe.bat '["file1.mp3","file2.mp3"]' [options]
  transcribe.bat --install

Options:
  -l, --language <name>    Spoken language (default: Hungarian)
  -m, --model <name>       Whisper model (default: small)
  -f, --format <format>    txt, vtt, srt, tsv, json, or all (default: srt)
  -o, --output-dir <path>  Output folder (default: next to the audio file)
  -j, --parallel <count>   Maximum simultaneous files (default: 1)
      --task <task>        transcribe or translate (default: transcribe)
      --install            Install/update Whisper and install FFmpeg if needed
      --dry-run            Print the Whisper command without running it
  -h, --help               Show this help

Examples:
  transcribe.bat "C:\\Audio\\lecture.mp3"
  transcribe.bat "part 1.mp3" "part 2.mp3" --parallel 2
  transcribe.bat "lecture.mp3" --model base --format srt
  transcribe.bat "lecture.mp3" -l English -o "C:\\Transcripts"
`.trim());
}

function resolveInputPaths(inputs) {
  return inputs.map((input) => {
    const inputPath = path.resolve(input);
    if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
      throw new Error(`Input file does not exist: ${inputPath}`);
    }
    return inputPath;
  });
}

function validateOutputPaths(options, inputPaths) {
  const claimedPaths = new Map();
  const formats = options.format === "all"
    ? ALL_OUTPUT_FORMATS
    : [options.format];

  for (const inputPath of inputPaths) {
    const outputDir = options.outputDir
      ? path.resolve(options.outputDir)
      : path.dirname(inputPath);

    for (const extension of formats) {
      const destination = outputPath(outputDir, inputPath, extension);
      const normalized = path.normalize(destination).toLowerCase();
      const previousInput = claimedPaths.get(normalized);

      if (previousInput) {
        throw new Error(
          `Output collision: "${previousInput}" and "${inputPath}" would both write "${destination}".`,
        );
      }
      claimedPaths.set(normalized, inputPath);
    }
  }
}

async function transcribeFile(options, python, inputPath, position, total) {
  const outputDir = options.outputDir
    ? path.resolve(options.outputDir)
    : path.dirname(inputPath);
  const writesSrt = options.format === "srt" || options.format === "all";
  const liveSrtPath = writesSrt
    ? outputPath(outputDir, inputPath, "srt")
    : null;
  const resumeState = liveSrtPath
    ? readResumeState(liveSrtPath)
    : { cues: [], resumeSeconds: 0 };
  if (resumeState.resumeSeconds > 0 && options.format === "all") {
    throw new Error(
      'Resuming an existing transcript supports "--format srt" only. Use --format srt, or delete the existing SRT to rebuild all formats.',
    );
  }
  const whisperArgs = [
    ...python.prefix,
    ...buildWhisperArgs(
      options,
      inputPath,
      outputDir,
      resumeState.resumeSeconds,
    ),
  ];
  const label = `[${position + 1}/${total}]`;

  if (options.dryRun) {
    process.stdout.write(`${label} `);
    printCommand(python.command, whisperArgs);
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`${label} Starting: ${inputPath}`);
  console.log(`${label} Output:   ${outputDir}`);

  let tempOutputDir = null;

  try {
    if (writesSrt) {
      tempOutputDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "transciptor-"),
      );
      const streamingArgs = [
        ...python.prefix,
        ...buildWhisperArgs(
          options,
          inputPath,
          tempOutputDir,
          resumeState.resumeSeconds,
        ),
      ];

      fs.writeFileSync(
        liveSrtPath,
        serializeSrtCues(resumeState.cues),
        "utf8",
      );
      console.log(`${label} Live SRT: ${liveSrtPath}`);
      if (resumeState.resumeSeconds > 0) {
        console.log(
          `${label} Resuming after ${formatSecondsAsSrt(resumeState.resumeSeconds)}`,
        );
      }

      const status = await runWhisperStreaming(
        python.command,
        streamingArgs,
        liveSrtPath,
        resumeState.cues.length,
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
        resumeState.cues,
      );
    } else {
      const status = await runAsyncInherited(python.command, whisperArgs);
      if (status !== 0) {
        throw new Error(`Whisper exited with code ${status}.`);
      }
    }
  } finally {
    if (tempOutputDir) {
      fs.rmSync(tempOutputDir, { recursive: true, force: true });
    }
  }

  console.log(`${label} Completed: ${inputPath}`);
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
      if (options.inputs.length === 0) {
        console.log("Dependencies are ready.");
        return 0;
      }
    }

    if (options.inputs.length === 0) {
      printHelp();
      return 2;
    }

    const inputPaths = resolveInputPaths(options.inputs);
    validateOutputPaths(options, inputPaths);

    if (!options.dryRun && !hasWhisper(python)) {
      throw new Error(
        "OpenAI Whisper is not installed. Run transcribe.bat --install first.",
      );
    }

    if (!options.dryRun && !hasFfmpeg()) {
      throw new Error(
        "FFmpeg is not installed or not on PATH. Run transcribe.bat --install first.",
      );
    }

    console.log(`Files: ${inputPaths.length}`);
    console.log(`Parallel processes: ${options.parallel}`);
    console.log(`Model: ${options.model}`);
    console.log(`Language: ${options.language}`);
    console.log("");

    const results = await runWithConcurrency(
      inputPaths,
      options.parallel,
      (inputPath, index) =>
        transcribeFile(options, python, inputPath, index, inputPaths.length),
    );
    const failures = results
      .map((result, index) => ({ result, inputPath: inputPaths[index] }))
      .filter(({ result }) => result.status === "rejected");

    for (const { result, inputPath } of failures) {
      console.error(`Failed: ${inputPath}`);
      console.error(`  ${result.reason.message}`);
    }

    const summaryVerb = options.dryRun ? "Prepared" : "Completed";
    console.log(
      `\n${summaryVerb} ${inputPaths.length - failures.length}/${inputPaths.length} file(s).`,
    );
    return failures.length === 0 ? 0 : 1;
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
  formatSecondsAsSrt,
  formatSrtCue,
  main,
  normalizeSrtTimestamp,
  parseArgs,
  parseSrtCues,
  parseSrtTimestamp,
  quoteForDisplay,
  readResumeState,
  runWithConcurrency,
  serializeSrtCues,
};
