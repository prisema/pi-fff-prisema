import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { FileFinder } from "@ff-labs/fff-node";
import type { GrepCursor, GrepMode, GrepResult, SearchResult } from "@ff-labs/fff-node";
import { Type } from "typebox";

const DEFAULT_FIND_LIMIT = 200;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_MAX_MATCHES_PER_FILE = 50;
const DEFAULT_SCAN_TIMEOUT_MS = 15_000;
const DEFAULT_GREP_TIME_BUDGET_MS = 5_000;
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
};

type SafeOptions = {
  aiMode: boolean;
  disableMmapCache: boolean;
  disableContentIndexing: boolean;
  disableWatch: boolean;
  scanTimeoutMs: number;
  grepTimeBudgetMs: number;
};

type ToolNames = {
  find: string;
  grep: string;
  multiGrep: string;
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
  };
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

  function destroyFinder() {
    if (state?.finder && !state.finder.isDestroyed) {
      state.finder.destroy();
    }
    state = null;
    initPromise = null;
    cursorCache.clear();
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
          scanTimedOut: false,
          scanPromise: Promise.resolve(),
        };

        runtime.scanPromise = finder
          .waitForScan(safeOptions.scanTimeoutMs)
          .then((result) => {
            runtime.scanTimedOut = result.ok ? !result.value : true;
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
      optionsLine,
      `tools=${tools.find}, ${tools.grep}, ${tools.multiGrep}`,
    ];
  }

  pi.on("session_start", async (_event, ctx) => {
    activeCwd = ctx.cwd;
    void ensureFinder(activeCwd).catch((error) => {
      ctx.ui.notify(`pi-fff-prisema init failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    });
  });

  pi.on("session_shutdown", async () => {
    destroyFinder();
  });

  pi.registerCommand("fff-prisema-status", {
    description: "Show pi-fff-prisema status and safe FFF options",
    handler: async (_args, ctx) => {
      await ensureFinder(activeCwd);
      ctx.ui.setWidget("fff-prisema-status", statusLines());
    },
  });

  pi.registerCommand("fff-prisema-reindex", {
    description: "Rescan current project with the existing safe FFF runtime",
    handler: async (_args, ctx) => {
      const runtime = await ensureFinder(activeCwd);
      const result = runtime.finder.scanFiles();
      if (!result.ok) {
        ctx.ui.notify(`FFF rescan failed: ${result.error}`, "error");
        return;
      }
      await runtime.finder.waitForScan(safeOptions.scanTimeoutMs);
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
      const result = runtime.finder.fileSearch(query, { pageSize: Math.max(limit, 100) });
      if (!result.ok) throw new Error(result.error);
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
      const result = runtime.finder.grep(buildGrepQuery(params.pattern, params.path, runtime.cwd), {
        mode,
        smartCase: true,
        cursor: cursor ?? null,
        maxMatchesPerFile: Math.min(limit, DEFAULT_MAX_MATCHES_PER_FILE),
        beforeContext: params.context ?? 0,
        afterContext: params.context ?? 0,
        timeBudgetMs: safeOptions.grepTimeBudgetMs,
      });

      if (!result.ok) throw new Error(result.error);
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
      const result = runtime.finder.multiGrep({
        patterns: params.patterns,
        constraints: params.constraints,
        smartCase: true,
        cursor: cursor ?? null,
        maxMatchesPerFile: Math.min(limit, DEFAULT_MAX_MATCHES_PER_FILE),
        beforeContext: params.context ?? 0,
        afterContext: params.context ?? 0,
        timeBudgetMs: safeOptions.grepTimeBudgetMs,
      });

      if (!result.ok) throw new Error(result.error);
      return content(formatGrepOutput(result.value, limit));
    },
  });
}
