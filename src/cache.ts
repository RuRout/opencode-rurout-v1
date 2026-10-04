import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LEGACY_FILE_CACHE_DIR = join(homedir(), ".cache", "opencode-rurout");
export const LEGACY_FILE_CACHE_PATTERN = /^models-[0-9a-f]+\.json$/i;

export async function purgeLegacyFileCache(log?: (message: string) => void): Promise<number> {
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(LEGACY_FILE_CACHE_DIR);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!LEGACY_FILE_CACHE_PATTERN.test(entry)) continue;
    try {
      await fs.unlink(join(LEGACY_FILE_CACHE_DIR, entry));
      removed += 1;
    } catch {
      // Best-effort: a locked or already-removed file must not break startup.
    }
  }
  if (removed > 0) {
    log?.(`[rurout] removed ${removed} stale model cache file(s) from ~/.cache/opencode-rurout`);
  }
  return removed;
}
