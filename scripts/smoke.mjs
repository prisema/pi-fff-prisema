#!/usr/bin/env node
import { FileFinder } from "@ff-labs/fff-node";

const basePath = process.argv[2] ?? process.cwd();

const created = FileFinder.create({
  basePath,
  aiMode: false,
  disableMmapCache: true,
  disableContentIndexing: true,
  disableWatch: true,
});

if (!created.ok) {
  console.error(`init failed: ${created.error}`);
  process.exit(1);
}

const finder = created.value;
try {
  const scan = await finder.waitForScan(15_000);
  if (!scan.ok) {
    console.error(`scan failed: ${scan.error}`);
    process.exit(1);
  }

  const health = finder.healthCheck();
  if (!health.ok) {
    console.error(`health failed: ${health.error}`);
    process.exit(1);
  }

  const files = finder.fileSearch("package", { pageSize: 5 });
  if (!files.ok) {
    console.error(`fileSearch failed: ${files.error}`);
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    basePath,
    scanCompleted: scan.value,
    indexedFiles: health.value.filePicker.indexedFiles ?? 0,
    sampleFiles: files.value.items.map((item) => item.relativePath),
    safety: {
      aiMode: false,
      disableMmapCache: true,
      disableContentIndexing: true,
      disableWatch: true,
    },
  }, null, 2));
} finally {
  finder.destroy();
}
