#!/usr/bin/env bun
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileFinder } from "@ff-labs/fff-node";
import piFffPrisema from "../src/index.ts";

const basePath = process.argv[2] ?? process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertOk(result, message) {
  assert(result.ok, result.ok ? "" : `${message}: ${result.error}`);
}

function toolText(result) {
  return result.content.map((part) => part.text).join("\n");
}

async function smokeRawFff(path) {
  const created = FileFinder.create({
    basePath: path,
    aiMode: false,
    disableMmapCache: true,
    disableContentIndexing: true,
    disableWatch: true,
  });

  assertOk(created, "init failed");

  const finder = created.value;
  try {
    const scan = await finder.waitForScan(15_000);
    assertOk(scan, "scan failed");
    assert(scan.value, "scan did not complete before timeout");

    const health = finder.healthCheck();
    assertOk(health, "health failed");
    assert((health.value.filePicker.indexedFiles ?? 0) > 0, "expected at least one indexed file");

    const files = finder.fileSearch("package", { pageSize: 5 });
    assertOk(files, "fileSearch failed");

    return {
      basePath: path,
      scanCompleted: scan.value,
      indexedFiles: health.value.filePicker.indexedFiles ?? 0,
      sampleFiles: files.value.items.map((item) => item.relativePath),
      safety: {
        aiMode: false,
        disableMmapCache: true,
        disableContentIndexing: true,
        disableWatch: true,
      },
    };
  } finally {
    finder.destroy();
  }
}

async function createFixture() {
  const fixture = await mkdtemp(join(tmpdir(), "pi-fff-prisema-smoke-"));
  await mkdir(join(fixture, "src"), { recursive: true });
  await writeFile(join(fixture, "package.json"), '{"name":"pi-fff-prisema-smoke"}\n');
  await writeFile(join(fixture, "README.md"), "# Fixture\n\nFileFinder.create appears in README too.\n");
  await writeFile(
    join(fixture, "src", "index.ts"),
    [
      'import { FileFinder } from "@ff-labs/fff-node";',
      "const created = FileFinder.create({ basePath: process.cwd() });",
      "function truncateOutput(text: string) { return text.trim(); }",
      "function buildGrepQuery(pattern: string) { return pattern.trim(); }",
      "pi.registerTool({ name: 'ffgrep' });",
      "",
    ].join("\n"),
  );
  await writeFile(join(fixture, "src", "other.ts"), "const unrelated = true;\n");
  return fixture;
}

function createPiHarness(cwd) {
  const tools = new Map();
  const commands = new Map();
  const flags = new Map();
  const handlers = new Map();
  const uiEvents = [];

  piFffPrisema({
    registerFlag(name, spec) {
      flags.set(name, spec);
    },
    getFlag() {
      return "";
    },
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  });

  const ctx = {
    cwd,
    ui: {
      notify(message, type) {
        uiEvents.push({ kind: "notify", message, type });
      },
      setWidget(name, lines) {
        uiEvents.push({ kind: "widget", name, lines });
      },
    },
  };

  return { tools, commands, flags, handlers, ctx, uiEvents };
}

async function smokePiTools(fixture) {
  const harness = createPiHarness(fixture);
  await harness.handlers.get("session_start")?.({}, harness.ctx);

  async function runTool(name, params) {
    const tool = harness.tools.get(name);
    assert(tool, `missing registered tool: ${name}`);
    const result = await tool.execute(`smoke-${name}`, params, new AbortController().signal);
    return toolText(result);
  }

  try {
    const findOutput = await runTool("fffind", { pattern: "index", path: "src/", limit: 5 });
    assert(findOutput.includes("src/index.ts"), `fffind path search failed:\n${findOutput}`);

    const grepDirSlash = await runTool("ffgrep", { pattern: "FileFinder.create", path: "src/", literal: true, limit: 10 });
    assert(grepDirSlash.includes("src/index.ts"), `ffgrep src/ constraint failed:\n${grepDirSlash}`);

    const grepDirNoSlash = await runTool("ffgrep", { pattern: "FileFinder.create", path: "src", literal: true, limit: 10 });
    assert(grepDirNoSlash.includes("src/index.ts"), `ffgrep existing dir without slash failed:\n${grepDirNoSlash}`);

    const grepExactFile = await runTool("ffgrep", { pattern: "registerTool", path: "src/index.ts", literal: true, limit: 10 });
    assert(grepExactFile.includes("src/index.ts"), `ffgrep exact file constraint failed:\n${grepExactFile}`);

    const grepRootFile = await runTool("ffgrep", { pattern: "FileFinder.create", path: "README.md", literal: true, limit: 10 });
    assert(grepRootFile.includes("README.md"), `ffgrep root file constraint failed:\n${grepRootFile}`);
    assert(!grepRootFile.includes("src/index.ts"), `ffgrep root file leaked other files:\n${grepRootFile}`);

    const grepGlob = await runTool("ffgrep", { pattern: "registerTool", path: "*.ts", literal: true, limit: 10 });
    assert(grepGlob.includes("src/index.ts"), `ffgrep glob constraint failed:\n${grepGlob}`);

    const grepRegex = await runTool("ffgrep", { pattern: "function .*Output", path: "src/", literal: false, limit: 10 });
    assert(grepRegex.includes("truncateOutput"), `ffgrep regex dir constraint failed:\n${grepRegex}`);

    const multiOutput = await runTool("fff-multi-grep", {
      patterns: ["registerTool", "buildGrepQuery"],
      constraints: "src/",
      limit: 10,
    });
    assert(multiOutput.includes("registerTool"), `fff-multi-grep constraint failed:\n${multiOutput}`);

    const doctor = harness.commands.get("fff-prisema-doctor");
    assert(doctor, "missing registered command: fff-prisema-doctor");
    await doctor.handler("", harness.ctx);
    const doctorWidget = harness.uiEvents.find((event) => event.kind === "widget" && event.name === "fff-prisema-doctor");
    assert(doctorWidget?.lines?.some((line) => line.includes("pi-fff-prisema doctor")), "fff-prisema-doctor widget missing");

    return {
      registeredTools: [...harness.tools.keys()],
      findOutput,
      grepDirSlash,
      grepDirNoSlash,
      grepExactFile,
      grepRootFile,
      grepGlob,
      grepRegex,
      multiOutput,
      doctorOutput: doctorWidget.lines,
    };
  } finally {
    await harness.handlers.get("session_shutdown")?.();
  }
}

let fixture;
try {
  const raw = await smokeRawFff(basePath);
  fixture = await createFixture();
  const tools = await smokePiTools(fixture);

  console.log(JSON.stringify({ ok: true, raw, tools }, null, 2));
} finally {
  if (fixture) await rm(fixture, { recursive: true, force: true });
}
