import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { FileFinder } from "@ff-labs/fff-node";
import type { GrepCursor, GrepMode, GrepResult, SearchResult } from "@ff-labs/fff-node";
import { Type } from "typebox";

const DEFAULT_FIND_LIMIT = 200;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_MAX_MATCHES_PER_FILE = 50;
const DEFAULT_SCAN_TIMEOUT_MS = 15_000;
const DEFAULT_GREP_TIME_BUDGET_MS = 5_000;
const DEFAULT_AUTO_REINDEX_MIN_INTERVAL_MS = 30_000;
const MAX_OUTPUT_CHARS = 48_000;
const MAX_OUTPUT_LINES = 1_500;
const MAX_CURSOR_CACHE = 200;

type Finder = FileFinder;

type RuntimeState = {
  cwd: string;
  finder: Finder;
  scanPromise: Promise<void>;
  scanTimedOut: boolean;
  initializedAt: Date;
  lastScanAt: Date;
};

type SafeOptions = {
  aiMode: boolean;
  disableMmapCache: boolean;
  disableContentIndexing: boolean;
  disableWatch: boolean;
  scanTimeoutMs: number;
  grepTimeBudgetMs: number;
  autoReindex: boolean;
  autoReindexMinIntervalMs: number;
};

type ToolNames = {
  find: string;
  grep: string;
  multiGrep: string;
};

type PackageMatch = {
  scope: "global" | "project";
  kind: "prisema" | "legacy";
  source: string;
};

type DoctorReport = {
  lines: string[];
  warnings: string[];
};

const cursorCache = new Map<string, GrepCursor>();
let cursorCounter = 0;

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  return fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function storeCursor(cursor: GrepCursor): string {
  const id = `prisema_fff_c${++cursorCounter}`;
  cursorCache.set(id, cursor);
  if (cursorCache.size > MAX_CURSOR_CACHE) {
    const first = cursorCache.keys().next().value;
    if (first) cursorCache.delete(first);
  }
  return id;
}

function getCursor(id: string | undefined): GrepCursor | undefined {
  return id ? cursorCache.get(id) : undefined;
}

function normalizeDirPath(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function pathMatches(relativePath: string, path: string | undefined): boolean {
  if (!path) return true;
  const normalized = normalizeDirPath(path);
  if (!normalized || normalized === ".") return true;
  if (normalized.includes("*")) return true;
  return relativePath === normalized || relativePath.startsWith(`${normalized}/`);
}

function buildFindQuery(pattern: string, path?: string): string {
  const normalizedPattern = pattern.trim();
  const normalizedPath = path ? normalizeDirPath(path) : "";
  if (!normalizedPath || normalizedPath === "." || normalizedPath.includes("*")) {
    return normalizedPath ? `${normalizedPath} ${normalizedPattern}` : normalizedPattern;
  }
  return `${normalizedPath} ${normalizedPattern}`;
}

function normalizeGrepPath(path: string): string {
  const trimmed = path.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  if (!trimmed || trimmed === ".") return "";
  if (trimmed.includes("*")) return trimmed.replace(/\/+$/, "");

  const hadTrailingSlash = /\/+$/u.test(trimmed);
  const normalized = trimmed.replace(/\/+$/, "");
  return hadTrailingSlash ? `${normalized}/` : normalized;
}

function pathStat(cwd: string, relativePath: string) {
  if (!relativePath || relativePath.includes("*")) return null;
  try {
    const fullPath = resolve(cwd, relativePath.replace(/\/+$/, ""));
    return existsSync(fullPath) ? statSync(fullPath) : null;
  } catch {
    return null;
  }
}

function extensionGlob(relativePath: string): string | null {
  const filename = relativePath.split("/").pop() ?? "";
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === filename.length - 1) return null;
  return `*.${filename.slice(dotIndex + 1)}`;
}

function buildGrepQuery(pattern: string, path?: string, cwd = process.cwd()): string {
  const normalizedPattern = pattern.trim();
  const normalizedPath = path ? normalizeGrepPath(path) : "";
  if (!normalizedPath || normalizedPath === ".") return normalizedPattern;
  if (normalizedPath.includes("*")) return `${normalizedPath} ${normalizedPattern}`;

  const stat = pathStat(cwd, normalizedPath);
  if (normalizedPath.endsWith("/") || stat?.isDirectory()) {
    return `${normalizedPath.replace(/\/+$/, "")}/ ${normalizedPattern}`;
  }

  if (stat?.isFile()) {
    const broadConstraint = normalizedPath.includes("/") ? `${normalizedPath}*` : extensionGlob(normalizedPath);
    return broadConstraint ? `${broadConstraint} ${normalizedPattern}` : normalizedPattern;
  }

  return `${normalizedPath} ${normalizedPattern}`;
}

function truncateOutput(text: string): string {
  const lines = text.split("\n");
  let truncated = false;
  let output = lines.slice(0, MAX_OUTPUT_LINES).join("\n");

  if (lines.length > MAX_OUTPUT_LINES) {
    truncated = true;
  }

  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS);
    truncated = true;
  }

  return truncated
    ? `${output}\n\n[Output truncated by pi-fff-prisema. Narrow query or lower limit.]`
    : output;
}

function formatFindOutput(result: SearchResult, limit: number, path?: string): string {
  const items = result.items.filter((item) => pathMatches(item.relativePath, path)).slice(0, limit);
  if (items.length === 0) return "No files found matching pattern";
  return truncateOutput(items.map((item) => item.relativePath).join("\n"));
}

function truncateLine(line: string, max = 500): string {
  const trimmed = line.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

function formatGrepOutput(result: GrepResult, limit: number, path?: string): string {
  const shouldFilterPath = path ? !normalizeGrepPath(path).includes("*") : false;
  const items = (shouldFilterPath ? result.items.filter((item) => pathMatches(item.relativePath, path)) : result.items).slice(0, limit);
  if (items.length === 0) return "No matches found";

  const lines: string[] = [];
  let currentFile = "";

  for (const match of items) {
    if (match.relativePath !== currentFile) {
      currentFile = match.relativePath;
      if (lines.length > 0) lines.push("");
    }

    match.contextBefore?.forEach((line, index) => {
      const lineNumber = match.lineNumber - (match.contextBefore?.length ?? 0) + index;
      lines.push(`${match.relativePath}-${lineNumber}- ${truncateLine(line)}`);
    });

    lines.push(`${match.relativePath}:${match.lineNumber}: ${truncateLine(match.lineContent)}`);

    match.contextAfter?.forEach((line, index) => {
      lines.push(`${match.relativePath}-${match.lineNumber + index + 1}- ${truncateLine(line)}`);
    });
  }

  const notices: string[] = [];
  if (result.nextCursor) {
    notices.push(`More results available. Use cursor=\"${storeCursor(result.nextCursor)}\" to continue`);
  }
  if (result.regexFallbackError) {
    notices.push(`Regex failed: ${result.regexFallbackError}; FFF used literal fallback`);
  }
  if (result.items.length >= limit) {
    notices.push(`${limit} matches limit reached. Raise limit for more`);
  }

  const body = notices.length > 0 ? `${lines.join("\n")}\n\n[${notices.join(". ")}]` : lines.join("\n");
  return truncateOutput(body);
}

function content(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function parseSafeOptions(): SafeOptions {
  return {
    aiMode: envBool("PI_FFF_PRISEMA_AI_MODE", false),
    disableMmapCache: envBool("PI_FFF_PRISEMA_DISABLE_MMAP_CACHE", true),
    disableContentIndexing: envBool("PI_FFF_PRISEMA_DISABLE_CONTENT_INDEXING", true),
    disableWatch: envBool("PI_FFF_PRISEMA_DISABLE_WATCH", true),
    scanTimeoutMs: envNumber("PI_FFF_PRISEMA_SCAN_TIMEOUT_MS", DEFAULT_SCAN_TIMEOUT_MS),
    grepTimeBudgetMs: envNumber("PI_FFF_PRISEMA_GREP_TIME_BUDGET_MS", DEFAULT_GREP_TIME_BUDGET_MS),
    autoReindex: envBool("PI_FFF_PRISEMA_AUTO_REINDEX", true),
    autoReindexMinIntervalMs: envNumber("PI_FFF_PRISEMA_AUTO_REINDEX_MIN_INTERVAL_MS", DEFAULT_AUTO_REINDEX_MIN_INTERVAL_MS),
  };
}

function commandMayMutateFiles(command: string): boolean {
  const startsMutatingCommand = /(^|[;&|]\s*)(touch|mkdir|mv|cp|rm|git\s+(pull|checkout|switch|merge|reset|clean|clone|apply)|bun\s+(install|add|remove)|npm\s+(install|i|add|remove)|pnpm\s+(install|add|remove)|yarn\s+(install|add|remove))\b/u;
  const writesToFile = /(^|[^2])>\s*\S|\btee\s+/u;
  return startsMutatingCommand.test(command) || writesToFile.test(command);
}

function toolNamesFromPrefix(prefix: string): ToolNames {
  const normalized = prefix.trim().replace(/-+$/, "");
  const p = normalized ? `${normalized}-` : "";
  return {
    find: `${p}fffind`,
    grep: `${p}ffgrep`,
    multiGrep: `${p}fff-multi-grep`,
  };
}

function settingsPackages(settingsPath: string): string[] {
  if (!existsSync(settingsPath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    const packages = parsed && typeof parsed === "object" && "packages" in parsed ? parsed.packages : null;
    if (!Array.isArray(packages)) return [];

    return packages
      .map((entry: unknown) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && "source" in entry && typeof entry.source === "string") return entry.source;
        return null;
      })
      .filter((source): source is string => source !== null);
  } catch {
    return [];
  }
}

function sourceLooksLocal(source: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/iu.test(source);
}

function resolveSourcePath(source: string, settingsPath: string): string | null {
  if (!sourceLooksLocal(source)) return null;
  return isAbsolute(source) ? resolve(source) : resolve(dirname(settingsPath), source);
}

function findPackageMatches(settingsPath: string, scope: PackageMatch["scope"]): PackageMatch[] {
  const matches: PackageMatch[] = [];

  for (const source of settingsPackages(settingsPath)) {
    const resolvedSource = resolveSourcePath(source, settingsPath);
    const haystack = `${source}\n${resolvedSource ?? ""}`;

    if (source.startsWith("npm:@ff-labs/pi-fff")) {
      matches.push({ scope, kind: "legacy", source });
    } else if (haystack.includes("pi-fff-prisema") || haystack.includes("pi-pff-prisema")) {
      matches.push({ scope, kind: "prisema", source });
    }
  }

  return matches;
}

function doctorReport(cwd: string, safeOptions: SafeOptions, state: RuntimeState | null, tools: ToolNames): DoctorReport {
  const globalSettings = join(homedir(), ".pi", "agent", "settings.json");
  const projectSettings = join(cwd, ".pi", "settings.json");
  const matches = [
    ...findPackageMatches(globalSettings, "global"),
    ...findPackageMatches(projectSettings, "project"),
  ];
  const prisemaSources = matches.filter((match) => match.kind === "prisema");
  const legacySources = matches.filter((match) => match.kind === "legacy");

  const warnings: string[] = [];
  if (legacySources.length > 0) warnings.push("legacy npm:@ff-labs/pi-fff installed; remove to avoid fffind/ffgrep collisions");
  if (prisemaSources.length > 1) warnings.push("multiple pi-fff-prisema sources installed; keep only GitHub/global or local-dev source");
  if (prisemaSources.some((match) => match.scope === "project")) warnings.push("project-local pi-fff-prisema source overrides global source");
  if (!safeOptions.disableWatch) warnings.push("PI_FFF_PRISEMA_DISABLE_WATCH=0; native watcher enabled");
  if (!safeOptions.disableMmapCache) warnings.push("PI_FFF_PRISEMA_DISABLE_MMAP_CACHE=0; mmap cache enabled");
  if (!safeOptions.disableContentIndexing) warnings.push("PI_FFF_PRISEMA_DISABLE_CONTENT_INDEXING=0; content index enabled");
  if (safeOptions.aiMode) warnings.push("PI_FFF_PRISEMA_AI_MODE=1; frecency/history mode enabled");
  if (safeOptions.disableWatch && !safeOptions.autoReindex) warnings.push("watch disabled and auto reindex disabled; new files require manual /fff-prisema-reindex");
  if (state?.scanTimedOut) warnings.push("initial FFF scan timed out; results may be incomplete until /fff-prisema-reindex");

  const lines = [
    warnings.length === 0 ? "pi-fff-prisema doctor: ok" : "pi-fff-prisema doctor: warnings",
    `cwd=${cwd}`,
    `globalSettings=${globalSettings}${existsSync(globalSettings) ? "" : " (missing)"}`,
    `projectSettings=${projectSettings}${existsSync(projectSettings) ? "" : " (missing)"}`,
    `tools=${tools.find}, ${tools.grep}, ${tools.multiGrep}`,
    "package sources:",
    ...(matches.length === 0 ? ["  none found in settings; ok if loaded via -e/autodiscovery"] : matches.map((match) => `  [${match.scope}] ${match.kind}: ${match.source}`)),
    "safe options:",
    `  aiMode=${safeOptions.aiMode}`,
    `  disableMmapCache=${safeOptions.disableMmapCache}`,
    `  disableContentIndexing=${safeOptions.disableContentIndexing}`,
    `  disableWatch=${safeOptions.disableWatch}`,
    `  autoReindex=${safeOptions.autoReindex}`,
    `  autoReindexMinIntervalMs=${safeOptions.autoReindexMinIntervalMs}`,
  ];

  if (warnings.length > 0) {
    lines.push("warnings:", ...warnings.map((warning) => `  - ${warning}`));
    lines.push("fix:", "  normal: bash scripts/install-global.sh", "  dev: bash scripts/install-local.sh", "  restart Pi after install");
  }

  return { lines, warnings };
}

export default function piFffPrisema(pi: ExtensionAPI) {
  pi.registerFlag("fff-prisema-prefix", {
    description: "Prefix for pi-fff-prisema tools. Empty registers fffind/ffgrep/fff-multi-grep.",
    type: "string",
  });

  let activeCwd = process.cwd();
  let state: RuntimeState | null = null;
  let initPromise: Promise<RuntimeState> | null = null;
  const safeOptions = parseSafeOptions();
  const prefix = (pi.getFlag("fff-prisema-prefix") as string | undefined) ?? process.env.PI_FFF_PRISEMA_PREFIX ?? "";
  const tools = toolNamesFromPrefix(prefix);
  let filesystemMayBeDirty = false;

  function destroyFinder() {
    if (state?.finder && !state.finder.isDestroyed) {
      state.finder.destroy();
    }
    state = null;
    initPromise = null;
    cursorCache.clear();
  }

  function markScanFinished(runtime: RuntimeState, scanCompleted: boolean) {
    runtime.lastScanAt = new Date();
    runtime.scanTimedOut = !scanCompleted;
    filesystemMayBeDirty = false;
  }

  async function rescanRuntime(runtime: RuntimeState): Promise<boolean> {
    const result = runtime.finder.scanFiles();
    if (!result.ok) return false;
    const scan = await runtime.finder.waitForScan(safeOptions.scanTimeoutMs);
    const completed = scan.ok ? scan.value : false;
    markScanFinished(runtime, completed);
    return completed;
  }

  async function maybeAutoReindex(runtime: RuntimeState, reason: "dirty" | "miss"): Promise<boolean> {
    if (!safeOptions.disableWatch || !safeOptions.autoReindex) return false;
    if (reason === "dirty" && !filesystemMayBeDirty) return false;
    if (reason === "miss" && Date.now() - runtime.lastScanAt.getTime() < safeOptions.autoReindexMinIntervalMs) return false;
    return rescanRuntime(runtime);
  }

  async function ensureFinder(cwd = activeCwd): Promise<RuntimeState> {
    if (initPromise) return initPromise;
    if (state && !state.finder.isDestroyed && state.cwd === cwd) return state;

    if (state && !state.finder.isDestroyed && state.cwd !== cwd) {
      destroyFinder();
    }

    initPromise = (async () => {
      try {
        const created = FileFinder.create({
          basePath: cwd,
          aiMode: safeOptions.aiMode,
          disableMmapCache: safeOptions.disableMmapCache,
          disableContentIndexing: safeOptions.disableContentIndexing,
          disableWatch: safeOptions.disableWatch,
        });

        if (!created.ok) {
          throw new Error(`FFF init failed: ${created.error}`);
        }

        const finder = created.value;
        const runtime: RuntimeState = {
          cwd,
          finder,
          initializedAt: new Date(),
          lastScanAt: new Date(),
          scanTimedOut: false,
          scanPromise: Promise.resolve(),
        };

        runtime.scanPromise = finder
          .waitForScan(safeOptions.scanTimeoutMs)
          .then((result) => {
            markScanFinished(runtime, result.ok ? result.value : false);
          })
          .catch(() => {
            runtime.scanTimedOut = true;
          });

        state = runtime;
        await runtime.scanPromise;
        return runtime;
      } catch (error) {
        destroyFinder();
        throw error;
      } finally {
        initPromise = null;
      }
    })();

    return initPromise;
  }

  function statusLines(): string[] {
    const optionsLine = [
      `aiMode=${safeOptions.aiMode}`,
      `disableMmapCache=${safeOptions.disableMmapCache}`,
      `disableContentIndexing=${safeOptions.disableContentIndexing}`,
      `disableWatch=${safeOptions.disableWatch}`,
    ].join(" ");

    if (!state || state.finder.isDestroyed) {
      return ["pi-fff-prisema: not initialized", `cwd=${activeCwd}`, optionsLine];
    }

    const health = state.finder.healthCheck();
    const progress = state.finder.getScanProgress();
    const indexedFiles = health.ok ? health.value.filePicker.indexedFiles ?? 0 : 0;
    const scanning = progress.ok ? progress.value.isScanning : health.ok ? Boolean(health.value.filePicker.isScanning) : false;

    return [
      "pi-fff-prisema: ready",
      `cwd=${state.cwd}`,
      `indexedFiles=${indexedFiles}`,
      `isScanning=${scanning}`,
      `scanTimedOut=${state.scanTimedOut}`,
      `initializedAt=${state.initializedAt.toISOString()}`,
      `lastScanAt=${state.lastScanAt.toISOString()}`,
      `filesystemMayBeDirty=${filesystemMayBeDirty}`,
      optionsLine,
      `autoReindex=${safeOptions.autoReindex} autoReindexMinIntervalMs=${safeOptions.autoReindexMinIntervalMs}`,
      `tools=${tools.find}, ${tools.grep}, ${tools.multiGrep}`,
    ];
  }

  pi.on("session_start", async (_event, ctx) => {
    activeCwd = ctx.cwd;
    void ensureFinder(activeCwd)
      .then((runtime) => {
        const report = doctorReport(activeCwd, safeOptions, runtime, tools);
        if (report.warnings.length > 0) {
          ctx.ui.notify(`pi-fff-prisema doctor found ${report.warnings.length} warning(s). Run /fff-prisema-doctor.`, "warning");
        }
      })
      .catch((error) => {
        ctx.ui.notify(`pi-fff-prisema init failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      });
  });

  pi.on("session_shutdown", async () => {
    destroyFinder();
  });

  pi.on("tool_result", async (event) => {
    if (event.isError) return;
    if (event.toolName === "edit" || event.toolName === "write") {
      filesystemMayBeDirty = true;
      return;
    }

    if (event.toolName === "bash" && typeof event.input?.command === "string" && commandMayMutateFiles(event.input.command)) {
      filesystemMayBeDirty = true;
    }
  });

  pi.registerCommand("fff-prisema-status", {
    description: "Show pi-fff-prisema status and safe FFF options",
    handler: async (_args, ctx) => {
      await ensureFinder(activeCwd);
      ctx.ui.setWidget("fff-prisema-status", statusLines());
    },
  });

  pi.registerCommand("fff-prisema-doctor", {
    description: "Validate pi-fff-prisema package sources and safe runtime options",
    handler: async (_args, ctx) => {
      const runtime = await ensureFinder(activeCwd);
      const report = doctorReport(activeCwd, safeOptions, runtime, tools);
      ctx.ui.setWidget("fff-prisema-doctor", report.lines);
      const ok = report.warnings.length === 0;
      ctx.ui.notify(ok ? "pi-fff-prisema doctor ok" : `pi-fff-prisema doctor found ${report.warnings.length} warning(s)`, ok ? "info" : "warning");
    },
  });

  pi.registerCommand("fff-prisema-reindex", {
    description: "Rescan current project with the existing safe FFF runtime",
    handler: async (_args, ctx) => {
      const runtime = await ensureFinder(activeCwd);
      const completed = await rescanRuntime(runtime);
      if (!completed) ctx.ui.notify("FFF rescan did not complete before timeout", "warning");
      ctx.ui.setWidget("fff-prisema-status", statusLines());
    },
  });

  pi.registerCommand("fff-prisema-dispose", {
    description: "Destroy current FFF runtime and clear cursors",
    handler: async (_args, ctx) => {
      destroyFinder();
      ctx.ui.notify("pi-fff-prisema runtime disposed. Next search will reinitialize.", "info");
    },
  });

  pi.registerTool({
    name: tools.find,
    label: tools.find,
    description: "Fuzzy file search using FFF with Prisema-safe runtime options (no watcher, no mmap, no content index by default).",
    promptSnippet: "Find files by fuzzy path/name using safe FFF",
    promptGuidelines: [
      "Use for approximate file/path discovery before reading.",
      "Prefer short queries: 1-2 terms or a path fragment.",
      "Use path for directory constraints when known.",
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "Fuzzy file/path query" }),
      path: Type.Optional(Type.String({ description: "Optional directory constraint, e.g. src/" })),
      limit: Type.Optional(Type.Number({ description: `Maximum results (default ${DEFAULT_FIND_LIMIT})` })),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const runtime = await ensureFinder(activeCwd);
      if (signal?.aborted) throw new Error("Operation aborted");

      const limit = Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);
      const query = buildFindQuery(params.pattern, params.path);
      await maybeAutoReindex(runtime, "dirty");
      let result = runtime.finder.fileSearch(query, { pageSize: Math.max(limit, 100) });
      if (!result.ok) throw new Error(result.error);
      if (result.value.items.length === 0 && await maybeAutoReindex(runtime, "miss")) {
        result = runtime.finder.fileSearch(query, { pageSize: Math.max(limit, 100) });
        if (!result.ok) throw new Error(result.error);
      }
      return content(formatFindOutput(result.value, limit, params.path));
    },
  });

  pi.registerTool({
    name: tools.grep,
    label: tools.grep,
    description: "Search file contents using FFF with Prisema-safe runtime options (no watcher, no mmap, no content index by default).",
    promptSnippet: "Search file contents with safe FFF",
    promptGuidelines: [
      "Search bare identifiers or exact strings first.",
      "Plain text is default and faster than regex.",
      "Use path to constrain by directory or file glob.",
      "Use cursor from previous output to continue pagination.",
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "Text or regex to search" }),
      path: Type.Optional(Type.String({ description: "Directory/file constraint, e.g. src/ or *.ts" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string. Default true. false enables regex mode." })),
      context: Type.Optional(Type.Number({ description: "Context lines before/after matches" })),
      limit: Type.Optional(Type.Number({ description: `Maximum matches (default ${DEFAULT_GREP_LIMIT})` })),
      cursor: Type.Optional(Type.String({ description: "Cursor from previous result" })),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const runtime = await ensureFinder(activeCwd);
      if (signal?.aborted) throw new Error("Operation aborted");

      const limit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
      const mode: GrepMode = params.literal === false ? "regex" : "plain";
      const cursor = getCursor(params.cursor);
      const query = buildGrepQuery(params.pattern, params.path, runtime.cwd);
      const grepOptions = {
        mode,
        smartCase: true,
        cursor: cursor ?? null,
        maxMatchesPerFile: Math.min(limit, DEFAULT_MAX_MATCHES_PER_FILE),
        beforeContext: params.context ?? 0,
        afterContext: params.context ?? 0,
        timeBudgetMs: safeOptions.grepTimeBudgetMs,
      };
      await maybeAutoReindex(runtime, "dirty");
      let result = runtime.finder.grep(query, grepOptions);

      if (!result.ok) throw new Error(result.error);
      if (result.value.items.length === 0 && await maybeAutoReindex(runtime, "miss")) {
        result = runtime.finder.grep(query, grepOptions);
        if (!result.ok) throw new Error(result.error);
      }
      return content(formatGrepOutput(result.value, limit, params.path));
    },
  });

  pi.registerTool({
    name: tools.multiGrep,
    label: tools.multiGrep,
    description: "Search for lines matching any literal pattern using FFF Aho-Corasick multi-pattern search.",
    promptSnippet: "Search multiple literal patterns with safe FFF",
    promptGuidelines: [
      "Use for OR searches across naming variants.",
      "Patterns are literal strings; do not escape regex characters.",
      "Use constraints for file/path filtering, e.g. *.ts src/ !test/.",
    ],
    parameters: Type.Object({
      patterns: Type.Array(Type.String(), { description: "Literal patterns; OR logic" }),
      constraints: Type.Optional(Type.String({ description: "FFF constraints, e.g. *.ts src/ !test/" })),
      context: Type.Optional(Type.Number({ description: "Context lines before/after matches" })),
      limit: Type.Optional(Type.Number({ description: `Maximum matches (default ${DEFAULT_GREP_LIMIT})` })),
      cursor: Type.Optional(Type.String({ description: "Cursor from previous result" })),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      if (!params.patterns || params.patterns.length === 0) {
        throw new Error("patterns must contain at least one string");
      }

      const runtime = await ensureFinder(activeCwd);
      if (signal?.aborted) throw new Error("Operation aborted");

      const limit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
      const cursor = getCursor(params.cursor);
      const multiGrepOptions = {
        patterns: params.patterns,
        constraints: params.constraints,
        smartCase: true,
        cursor: cursor ?? null,
        maxMatchesPerFile: Math.min(limit, DEFAULT_MAX_MATCHES_PER_FILE),
        beforeContext: params.context ?? 0,
        afterContext: params.context ?? 0,
        timeBudgetMs: safeOptions.grepTimeBudgetMs,
      };
      await maybeAutoReindex(runtime, "dirty");
      let result = runtime.finder.multiGrep(multiGrepOptions);

      if (!result.ok) throw new Error(result.error);
      if (result.value.items.length === 0 && await maybeAutoReindex(runtime, "miss")) {
        result = runtime.finder.multiGrep(multiGrepOptions);
        if (!result.ok) throw new Error(result.error);
      }
      return content(formatGrepOutput(result.value, limit));
    },
  });
}
