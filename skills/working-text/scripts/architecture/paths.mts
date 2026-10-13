// Path readings the three commands share: how a message names a path, and
// whether a file sits inside the repository root.

import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function toPosix(path: string): string {
  return path.split("\\").join("/");
}

export function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** How messages name `path`: relative to `root` when it lives inside, absolute otherwise. Symlinked temp dirs compare by real path. */
export function pathLabel(root: string, path: string): string {
  const real = (candidate: string): string =>
    existsSync(candidate) ? realpathSync(candidate) : candidate;
  const rel = toPosix(relative(real(root), real(path)));
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? toPosix(path) : rel;
}

/** True when `file` is `root` or sits under it, judged by the relative path so the host's separator does not matter. */
export function withinRoot(root: string, file: string): boolean {
  const rel = relative(resolve(root), file);
  return !rel.startsWith("..") && !isAbsolute(rel);
}
