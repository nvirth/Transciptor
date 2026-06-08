"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildWhisperArgs,
  createSrtStreamParser,
  formatSrtCue,
  normalizeSrtTimestamp,
  parseArgs,
  quoteForDisplay,
  runWithConcurrency,
} = require("../transcribe");

test("parseArgs uses Hungarian, small, and SRT defaults", () => {
  assert.deepEqual(parseArgs(["lecture.mp3"]), {
    language: "Hungarian",
    model: "small",
    format: "srt",
    task: "transcribe",
    outputDir: null,
    install: false,
    dryRun: false,
    help: false,
    parallel: 1,
    inputs: ["lecture.mp3"],
  });
});

test("parseArgs accepts short and long option forms", () => {
  const options = parseArgs([
    "lecture.mp3",
    "-l",
    "English",
    "--model=base",
    "-f",
    "json",
    "-o",
    "results",
    "--task",
    "translate",
    "--parallel",
    "3",
    "--dry-run",
  ]);

  assert.equal(options.language, "English");
  assert.equal(options.model, "base");
  assert.equal(options.format, "json");
  assert.equal(options.outputDir, "results");
  assert.equal(options.task, "translate");
  assert.equal(options.parallel, 3);
  assert.equal(options.dryRun, true);
});

test("parseArgs rejects unsupported options and formats", () => {
  assert.throws(() => parseArgs(["--wat"]), /Unknown option/);
  assert.throws(
    () => parseArgs(["lecture.mp3", "--format", "docx"]),
    /Unsupported format/,
  );
  assert.throws(
    () => parseArgs(["lecture.mp3", "--parallel", "0"]),
    /positive integer/,
  );
});

test("parseArgs accepts multiple positional files and a JSON array", () => {
  assert.deepEqual(
    parseArgs(["one.mp3", "two.mp3", "-j", "2"]).inputs,
    ["one.mp3", "two.mp3"],
  );
  assert.deepEqual(
    parseArgs(['["one.mp3","two.mp3"]']).inputs,
    ["one.mp3", "two.mp3"],
  );
  assert.deepEqual(
    parseArgs(["[one.mp3,two.mp3]"]).inputs,
    ["one.mp3", "two.mp3"],
  );
});

test("buildWhisperArgs creates the expected Python module arguments", () => {
  const options = parseArgs(["lecture.mp3"]);
  const args = buildWhisperArgs(
    options,
    "C:\\Audio Files\\lecture.mp3",
    "C:\\Audio Files",
  );

  assert.deepEqual(args, [
    "-u",
    "-m",
    "whisper",
    "C:\\Audio Files\\lecture.mp3",
    "--language",
    "Hungarian",
    "--model",
    "small",
    "--output_format",
    "srt",
    "--output_dir",
    "C:\\Audio Files",
    "--task",
    "transcribe",
    "--verbose",
    "True",
  ]);
});

test("quoteForDisplay quotes paths containing spaces", () => {
  assert.equal(
    quoteForDisplay("C:\\Audio Files\\lecture.mp3"),
    '"C:\\Audio Files\\lecture.mp3"',
  );
  assert.equal(quoteForDisplay("small"), "small");
});

test("normalizeSrtTimestamp adds hours and uses a comma", () => {
  assert.equal(normalizeSrtTimestamp("02:03.456"), "00:02:03,456");
  assert.equal(normalizeSrtTimestamp("01:02:03.456"), "01:02:03,456");
});

test("formatSrtCue creates a valid SRT block", () => {
  assert.equal(
    formatSrtCue(4, "02:03.456", "02:07.890", "  Hello world  "),
    "4\n00:02:03,456 --> 00:02:07,890\nHello world\n\n",
  );
});

test("SRT stream parser handles split chunks and ignores other output", () => {
  const cues = [];
  const parser = createSrtStreamParser((cue) => cues.push(cue));

  parser.push("Loading model...\r\n[00:00.000 --> 00:02.");
  parser.push("500] First sentence.\r\n[01:02:03.004 --> 01:02:05.006] ");
  parser.end("Second sentence.\r\n");

  assert.deepEqual(cues, [
    "1\n00:00:00,000 --> 00:00:02,500\nFirst sentence.\n\n",
    "2\n01:02:03,004 --> 01:02:05,006\nSecond sentence.\n\n",
  ]);
});

test("runWithConcurrency never exceeds the requested worker count", async () => {
  let active = 0;
  let maximumActive = 0;

  const results = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return item * 2;
  });

  assert.equal(maximumActive, 2);
  assert.deepEqual(
    results.map((result) => result.value),
    [2, 4, 6, 8, 10],
  );
});

test("runWithConcurrency continues after an individual job fails", async () => {
  const visited = [];
  const results = await runWithConcurrency([1, 2, 3], 2, async (item) => {
    visited.push(item);
    if (item === 2) {
      throw new Error("failed");
    }
    return item;
  });

  assert.deepEqual(visited.sort(), [1, 2, 3]);
  assert.equal(results[1].status, "rejected");
  assert.equal(results[2].status, "fulfilled");
});
