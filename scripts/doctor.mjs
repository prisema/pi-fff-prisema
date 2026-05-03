#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const root = resolve(join(import.meta.dirname, ".."));
const args = new Set(process.argv.slice(2));
const expectSource = [...args].find((arg) => arg.startsWith("--expect-source="))?.split("=", 2)[1] ?? "any";
const strict = args.has("--strict");

const globalSettings = join(homedir(), ".pi", "agent", "settings.json");
const projectSettings = join(root, ".pi", "settings.json");

function readSettings(file) {
  if (!existsSync(file)) return { exists: false, packages: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { exists: true, packages: Array.isArray(parsed.packages) ? parsed.packages : [] };
  } catch (error) {
    return { exists: true, error: error instanceof Error ? error.message : String(error), packages: [] };
  }
}

function packageSource(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry.source === "string") return entry.source;
  return null;
}

function isUrlLike(source) {
  return /^[a-z][a-z0-9+.-]*:/iu.test(source);
}

function resolvedLocalPath(source, settingsFile) {
  if (!source || isUrlLike(source)) return null;
  return isAbsolute(source) ? resolve(source) : resolve(dirname(settingsFile), source);
}

function classify(source, settingsFile) {
  const localPath = resolvedLocalPath(source, settingsFile);
  if (source.startsWith("npm:@ff-labs/pi-fff")) return "legacy-fff";
  if (source.includes("github.com/prisema/pi-fff-prisema")) return "git";
  if (localPath === root) return "local";
  return "other";
}

function collectPackages(file, scope) {
  const settings = readSettings(file);
  return settings.packages.flatMap((entry) => {
    const source = packageSource(entry);
    if (!source) return [];
    const kind = classify(source, file);
    if (!["legacy-fff", "git", "local"].includes(kind)) return [];
    return [{ scope, settingsFile: file, source, kind, resolvedPath: resolvedLocalPath(source, file) }];
  });
}

function dependencyStatus() {
  const paths = [
    ["@ff-labs/fff-node", "node_modules/@ff-labs/fff-node"],
    ["typescript", "node_modules/typescript"],
    ["@mariozechner/pi-coding-agent", "node_modules/@mariozechner/pi-coding-agent"],
    ["typebox", "node_modules/typebox"],
  ];

  return paths.map(([name, relative]) => ({ name, ok: existsSync(join(root, relative)) }));
}

const packages = [...collectPackages(globalSettings, "global"), ...collectPackages(projectSettings, "project")];
const active = packages.filter((pkg) => pkg.kind === "git" || pkg.kind === "local");
const legacy = packages.filter((pkg) => pkg.kind === "legacy-fff");
const deps = dependencyStatus();

const warnings = [];
if (legacy.length > 0) {
  warnings.push("legacy npm:@ff-labs/pi-fff still installed; remove it to avoid fffind/ffgrep tool collisions");
}
if (active.length === 0) {
  warnings.push("pi-fff-prisema is not installed in global or project Pi settings");
}
if (active.length > 1) {
  warnings.push("multiple pi-fff-prisema package sources installed; Pi may load duplicate tools");
}
if (packages.some((pkg) => pkg.scope === "project" && (pkg.kind === "git" || pkg.kind === "local"))) {
  warnings.push("project-local pi-fff-prisema entry exists; project settings win over global settings");
}
if (expectSource === "git" && active.some((pkg) => pkg.kind === "local")) {
  warnings.push("expected GitHub/global source, but local checkout source is installed");
}
if (expectSource === "local" && active.some((pkg) => pkg.kind === "git")) {
  warnings.push("expected local development source, but GitHub source is also installed");
}
for (const dep of deps) {
  if (!dep.ok) warnings.push(`missing local dependency ${dep.name}; run bun install before local smoke/typecheck`);
}

console.log("PFFPrisema doctor");
console.log(`root=${root}`);
console.log(`globalSettings=${globalSettings}${existsSync(globalSettings) ? "" : " (missing)"}`);
console.log(`projectSettings=${projectSettings}${existsSync(projectSettings) ? "" : " (missing)"}`);
console.log("");
console.log("matching packages:");
if (packages.length === 0) {
  console.log("  none");
} else {
  for (const pkg of packages) {
    const pathSuffix = pkg.resolvedPath ? ` -> ${pkg.resolvedPath}` : "";
    console.log(`  [${pkg.scope}] ${pkg.kind}: ${pkg.source}${pathSuffix}`);
  }
}
console.log("");
console.log("local dependencies:");
for (const dep of deps) {
  console.log(`  ${dep.ok ? "ok" : "missing"}: ${dep.name}`);
}
console.log("");

if (warnings.length === 0) {
  console.log("status=ok");
} else {
  console.log("warnings:");
  for (const warning of warnings) console.log(`  - ${warning}`);
  console.log("");
  console.log("suggested fixes:");
  console.log("  - local dev source: bash scripts/install-local.sh");
  console.log("  - GitHub/global source: bash scripts/install-global.sh");
  console.log("  - after install: restart Pi, then run /fff-prisema-status");
}

if (strict && warnings.length > 0) process.exit(1);
