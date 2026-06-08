"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildWhisperArgs,
  parseArgs,
  quoteForDisplay,
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
    input: "lecture.mp3",
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
    "--dry-run",
  ]);

  assert.equal(options.language, "English");
  assert.equal(options.model, "base");
  assert.equal(options.format, "json");
  assert.equal(options.outputDir, "results");
  assert.equal(options.task, "translate");
  assert.equal(options.dryRun, true);
});

test("parseArgs rejects unsupported options and formats", () => {
  assert.throws(() => parseArgs(["--wat"]), /Unknown option/);
  assert.throws(
    () => parseArgs(["lecture.mp3", "--format", "docx"]),
    /Unsupported format/,
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
  ]);
});

test("quoteForDisplay quotes paths containing spaces", () => {
  assert.equal(
    quoteForDisplay("C:\\Audio Files\\lecture.mp3"),
    '"C:\\Audio Files\\lecture.mp3"',
  );
  assert.equal(quoteForDisplay("small"), "small");
});
