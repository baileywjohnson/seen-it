import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Walk up from this file until we find the monorepo root (package.json with "workspaces"). */
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, "utf8"));
        if (json.workspaces) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const REPO_ROOT = findRepoRoot();
export const DATA_DIR = process.env.DATA_DIR ?? path.join(REPO_ROOT, "data");
export const CACHE_DIR = path.join(DATA_DIR, "cache");
export const CLIENT_DIST = path.join(REPO_ROOT, "client", "dist");

export async function readJsonCache<T>(file: string, maxAgeMs: number): Promise<T | null> {
  try {
    const stat = await fs.promises.stat(file);
    if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
    return JSON.parse(await fs.promises.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJsonCache(file: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(value, null, 2));
}
