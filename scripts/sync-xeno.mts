#!/usr/bin/env bun
// Xeno skills are vendored copies: xeno/<name>/ is the whole
// folder of an upstream repository at the commit xeno/sources.yml
// pins. This script is the only writer of those folders.
//   sync-xeno.mts            refresh every copy to its ref's head and move the pins of the folders that changed
//   sync-xeno.mts --check    exit 1 when the folder at a ref's head differs from its copy, or a copy differs from its pin
// An upstream commit that leaves the folder byte-identical (a change elsewhere in that repository)
// moves nothing: the pin moves only when the vendored files differ between it and the ref's head,
// so a pin move is always an upstream diff to read.
// A source may declare frontmatter overrides (a key set or removed in the
// copy's SKILL.md) and a license_file copied in from the upstream root; the
// copy is then upstream plus exactly those, and the check compares against
// that. A copy whose body or other files differ from its pin is a hand edit,
// and the sync refuses to overwrite it; the frontmatter and the license file
// are sources.yml's. Fetches go through git (a depth-1 fetch of one commit),
// so a local file:// repository works as an upstream in tests.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { Document, isMap, parse, parseDocument } from "yaml";
import { ROOT, XENO_DIR } from "./lib";

export const SOURCES_FILE = join(XENO_DIR, "sources.yml");
const SHA = /^[0-9a-f]{40}$/;
/** spawnSync stops reading at 1 MiB by default; an upstream asset (a font index, a bundled script) is routinely larger. */
const BLOB_LIMIT = 256 * 1024 * 1024;

/** The commit a new entry carries before its first sync; nothing to compare a copy against. */
const PLACEHOLDER = /^0{40}$/;

export interface Source {
  /** Clone URL of the upstream repository. */
  readonly url: string;
  /** The skill folder inside it, repository-relative, no trailing slash. */
  readonly path: string;
  /** Branch or tag the sync follows; absent means the upstream's default branch. */
  readonly ref?: string;
  /** The commit the vendored copy was taken from. */
  readonly commit: string;
  /** SPDX id of the upstream license, or the words "none published". */
  readonly license: string;
  /** Repository-relative path of the upstream license text, when the folder itself carries none; copied in under its basename. */
  readonly licenseFile?: string;
  /** SKILL.md frontmatter keys to set (a string, number, or boolean) or remove (null) in the copy. */
  readonly frontmatter?: Readonly<Record<string, string | number | boolean | null>>;
}

export type Sources = Record<string, Source>;

/** A misspelled key (refs for ref) would otherwise be dropped and the copy would follow the wrong branch. */
const KNOWN_KEYS = new Set([
  "url",
  "path",
  "ref",
  "commit",
  "license",
  "license_file",
  "frontmatter",
]);

export function parseSources(text: string, where = "sources.yml"): Sources {
  const raw: unknown = parse(text);
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where}: must be an object of skill name -> source`);
  }
  const sources: Record<string, Source> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name))
      throw new Error(`${where}: '${name}' is not a kebab-case skill name starting with a letter`);
    if (typeof value !== "object" || value === null)
      throw new Error(`${where}: ${name} must be an object`);
    const entry = value as Record<string, unknown>;
    const unknown = Object.keys(entry).filter((key) => !KNOWN_KEYS.has(key));
    if (unknown.length > 0) {
      throw new Error(
        `${where}: ${name} has unknown key(s) ${unknown.join(", ")}; the schema is ${[...KNOWN_KEYS].join(", ")}`,
      );
    }
    for (const key of ["url", "path", "commit", "license"] as const) {
      if (typeof entry[key] !== "string" || entry[key] === "")
        throw new Error(`${where}: ${name}.${key} must be a non-empty string`);
    }
    if (entry.ref !== undefined && (typeof entry.ref !== "string" || entry.ref === "")) {
      throw new Error(`${where}: ${name}.ref must be a branch or tag name when present`);
    }
    const path = entry.path as string;
    if (path.startsWith("/") || path.endsWith("/") || path.split("/").includes("..")) {
      throw new Error(`${where}: ${name}.path must be repository-relative with no trailing slash`);
    }
    if (/[*?[\]\\]/.test(path)) {
      throw new Error(`${where}: ${name}.path names one folder; glob characters are not allowed`);
    }
    if (!SHA.test(entry.commit as string))
      throw new Error(`${where}: ${name}.commit must be a 40-hex commit sha`);
    if (entry.license_file !== undefined) {
      const file = entry.license_file;
      if (
        typeof file !== "string" ||
        file === "" ||
        file.startsWith("/") ||
        file.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
        /[*?[\]\\]/.test(file)
      ) {
        throw new Error(`${where}: ${name}.license_file must be a repository-relative file path`);
      }
      // A file inside the folder is already copied and pinned as upstream's; naming it here would make it registry-owned.
      if (file.startsWith(`${path}/`)) {
        throw new Error(
          `${where}: ${name}.license_file ${file} is inside ${path}/ and travels with the folder already`,
        );
      }
    }
    const source: Source = {
      url: entry.url as string,
      path,
      ...(typeof entry.ref === "string" ? { ref: entry.ref } : {}),
      commit: entry.commit as string,
      license: entry.license as string,
      ...(typeof entry.license_file === "string" ? { licenseFile: entry.license_file } : {}),
    };
    if (entry.frontmatter !== undefined) {
      if (
        typeof entry.frontmatter !== "object" ||
        entry.frontmatter === null ||
        Array.isArray(entry.frontmatter)
      ) {
        throw new Error(`${where}: ${name}.frontmatter must be an object of key -> scalar or null`);
      }
      for (const [key, value] of Object.entries(entry.frontmatter)) {
        if (!/^[A-Za-z][\w-]*$/.test(key))
          throw new Error(`${where}: ${name}.frontmatter key '${key}' is not a plain key`);
        const scalar =
          typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value));
        if (value !== null && !scalar) {
          throw new Error(
            `${where}: ${name}.frontmatter.${key} must be a string, finite number, boolean, or null`,
          );
        }
      }
      const frontmatter = entry.frontmatter as NonNullable<Source["frontmatter"]>;
      sources[name] = Object.keys(frontmatter).length > 0 ? { ...source, frontmatter } : source;
    } else {
      sources[name] = source;
    }
  }
  return sources;
}

/** The registry is a plain file; a link would make the sync read and write some other file. */
function assertPlainFile(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) {
    throw new Error(
      `${relative(ROOT, path) || path}: ${stat.isSymbolicLink() ? "a symlink" : "not a regular file"}; the registry is a plain file`,
    );
  }
}

export function loadSources(path = SOURCES_FILE): Sources {
  assertPlainFile(path);
  return parseSources(readFileSync(path, "utf8"), relative(ROOT, path));
}

/** The YAML shape of a source: the file spells license_file where the code says licenseFile. */
function toYaml(source: Source): Record<string, unknown> {
  const { licenseFile, ...rest } = source;
  return licenseFile === undefined ? rest : { ...rest, license_file: licenseFile };
}

export function renderSources(sources: Sources, header = SOURCES_HEADER): string {
  const doc = new Document(
    Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, toYaml(source)])),
  );
  doc.commentBefore = header
    .trimEnd()
    .split("\n")
    .map((line) => line.replace(/^#/, ""))
    .join("\n");
  return doc.toString({ lineWidth: 0 });
}

export const SOURCES_HEADER = `# Vendored external skills, one mapping per folder under xeno/.
#   url          clone URL of the upstream repository
#   path         the skill folder inside it (copied whole)
#   ref          branch or tag the nightly sync follows (absent: the upstream's default branch)
#   commit       the upstream commit the copy was taken from; the sync moves it, nobody edits it
#   license      SPDX id of the upstream license, or "none published"
#   license_file repository-relative path of the upstream license text, copied in under its basename when the folder carries none
#   frontmatter  SKILL.md keys set (scalar) or removed (null) in the copy; with license_file, the only allowed differences from upstream
`;

/** Updates the existing document in place, so its comments and scalar styles survive a pin move; a missing file is rendered fresh. */
export function writeSources(sources: Sources, path = SOURCES_FILE): void {
  assertPlainFile(path);
  if (!existsSync(path)) {
    writeFileSync(path, renderSources(sources));
    return;
  }
  const doc = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    writeFileSync(path, renderSources(sources));
    return;
  }
  for (const key of [...doc.contents.items].map((item) => String(item.key))) {
    if (!Object.hasOwn(sources, key)) doc.delete(key);
  }
  for (const [name, source] of Object.entries(sources)) {
    if (!doc.has(name)) {
      doc.set(name, toYaml(source));
      continue;
    }
    for (const [field, value] of Object.entries(toYaml(source))) {
      if (value !== undefined) doc.setIn([name, field], value);
    }
  }
  writeFileSync(path, doc.toString({ lineWidth: 0 }));
}

function git(args: readonly string[], cwd?: string): string {
  // The server-side allowance rides along in GIT_CONFIG_PARAMETERS, so a local
  // file:// upstream serves an unadvertised commit the way GitHub does.
  const proc = spawnSync("git", ["-c", "uploadpack.allowAnySHA1InWant=true", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: BLOB_LIMIT,
  });
  if (proc.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${proc.stderr.trim() || `exit ${proc.status}`}`);
  return proc.stdout;
}

/** The commit `ref` names at the upstream right now; HEAD is the upstream's default branch. */
export function resolveRef(url: string, ref = "HEAD"): string {
  // ls-remote takes its arguments as tail patterns ("main" matches refs/heads/feat/main too),
  // so the row is picked by its full ref name, never by position.
  const wanted = ref === "HEAD" ? ["HEAD"] : [`refs/heads/${ref}`, `refs/tags/${ref}`];
  const rows = git(["ls-remote", url, ...wanted])
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.split("\t") as [string, string]);
  const row = wanted.map((name) => rows.find(([, refName]) => refName === name)).find(Boolean);
  if (!row || !SHA.test(row[0])) throw new Error(`${url}: ref '${ref}' not found`);
  return row[0];
}

/** One vendored file: its bytes and whether git marks it executable (mode 100755), the two things a copy must keep. */
export interface Entry {
  readonly bytes: Buffer;
  readonly executable: boolean;
}

export type Files = ReadonlyMap<string, Entry>;

export interface Snapshot {
  readonly commit: string;
  /** Folder-relative path -> entry, for every blob under the source path. */
  readonly files: Files;
}

/**
 * The upstream folder at one commit, through a throwaway depth-1 fetch of that sha.
 * A pin may predate its license file (declared later, or added upstream in a commit that left the
 * folder alone), so the pinned snapshot takes the file "if-present": its absence there is a
 * difference the head resolves, never an error. The head itself always requires it.
 */
export function fetchSnapshot(
  source: Pick<Source, "url" | "path" | "licenseFile">,
  commit: string,
  license: "required" | "if-present" = "required",
): Snapshot {
  const work = mkdtempSync(join(tmpdir(), "sync-xeno-"));
  try {
    git(["init", "-q", work]);
    git(["fetch", "-q", "--depth", "1", source.url, commit], work);
    const fetched = git(["rev-parse", "FETCH_HEAD"], work).trim();
    if (fetched !== commit)
      throw new Error(`${source.url}: asked for ${commit}, fetched ${fetched}`);
    // A literal pathspec: a path with glob characters is refused by parseSources, and this keeps git from reading it as a pattern either way.
    // The license file rides along under its basename when the folder itself carries no notice.
    const pathspecs = [
      `:(literal)${source.path}/`,
      ...(source.licenseFile ? [`:(literal)${source.licenseFile}`] : []),
    ];
    const listing = git(["ls-tree", "-r", "-z", "FETCH_HEAD", "--", ...pathspecs], work);
    const licenseName = source.licenseFile ? basename(source.licenseFile) : undefined;
    if (
      license === "required" &&
      source.licenseFile &&
      !listing.split("\0").some((row) => row.endsWith(`\t${source.licenseFile}`))
    ) {
      throw new Error(`${source.url}@${commit}: license_file ${source.licenseFile} does not exist`);
    }
    const files = new Map<string, Entry>();
    // The folder's own files first, so a license file that collides with one is caught whatever git's listing order.
    const rows = listing
      .split("\0")
      .filter(Boolean)
      .sort(
        (a, b) => Number(b.includes(`\t${source.path}/`)) - Number(a.includes(`\t${source.path}/`)),
      );
    for (const row of rows) {
      // "<mode> <type> <sha>\t<path>"
      const [meta, path] = row.split("\t", 2) as [string, string];
      const inFolder = path.startsWith(`${source.path}/`);
      // The license pathspec also lists the descendants of a directory of that name; only the file itself is the license.
      if (!inFolder && path !== source.licenseFile) continue;
      const mode = meta.split(" ")[0];
      if (mode !== "100644" && mode !== "100755") {
        throw new Error(
          `${source.url}: ${path} has git mode ${mode} (a symlink or submodule); the copy carries plain files only`,
        );
      }
      const blob = spawnSync("git", ["show", `FETCH_HEAD:${path}`], {
        cwd: work,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: BLOB_LIMIT,
      });
      if (blob.status !== 0) throw new Error(`git show ${path}: ${blob.stderr.toString().trim()}`);
      const name = inFolder ? relative(source.path, path) : (licenseName as string);
      if (
        !inFolder &&
        (files.has(name) || [...files.keys()].some((k) => k.startsWith(`${name}/`)))
      ) {
        throw new Error(`${source.url}: the folder already carries ${name}; drop license_file`);
      }
      files.set(name, { bytes: blob.stdout, executable: mode === "100755" });
    }
    // The license row alone is not a folder: a mistyped path must not yield a copy holding only LICENSE.
    if (![...files.keys()].some((name) => name !== licenseName)) {
      throw new Error(`${source.url}@${commit}: no files under ${source.path}/`);
    }
    return { commit, files };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * SKILL.md with the declared overrides applied to its frontmatter; other files pass through.
 * The block is edited entry by entry (a top-level key and every continuation line under it),
 * so a folded description or a nested mapping is removed or kept whole, and the file's own line
 * ending is used throughout.
 */
export const MODIFIED_NOTICE = "Modified from upstream by the xeno sync of Vivswan/skills";

export function applyOverrides(files: Files, overrides: Source["frontmatter"]): Files {
  if (!overrides || Object.keys(overrides).length === 0) return files;
  const skill = files.get("SKILL.md");
  if (!skill) throw new Error("frontmatter overrides need a SKILL.md in the upstream folder");
  const split = splitFrontmatter(skill.bytes);
  if (!split) {
    throw new Error(
      "frontmatter overrides need a SKILL.md that opens with a --- frontmatter block",
    );
  }
  const eol =
    split.block.includes("\r\n") || split.rest.subarray(0, 2).equals(Buffer.from("\r\n"))
      ? "\r\n"
      : "\n";
  const doc = parseDocument(split.block);
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    throw new Error(
      `SKILL.md frontmatter is not a YAML mapping: ${doc.errors[0]?.message ?? "no mapping"}`,
    );
  }
  const changes: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) doc.delete(key);
    else doc.set(key, value);
    changes.push(`${key} ${value === null ? "removed" : "set"}`);
  }
  // Apache 2.0 section 4(b) wants a modified file to say so; every modified copy says so the same way.
  // Appended, so a comment upstream already keeps at the end of its frontmatter survives.
  const upstreamComment = doc.comment?.trimEnd();
  doc.comment = `${upstreamComment ? `${upstreamComment}\n` : ""} ${MODIFIED_NOTICE}: ${changes.join(", ")}`;
  const block = doc.toString({ lineWidth: 0 }).replace(/\n$/, "").replace(/\n/g, eol);
  const rewritten = Buffer.concat([Buffer.from(`---${eol}${block}${eol}---`, "utf8"), split.rest]);
  return new Map([...files, ["SKILL.md", { ...skill, bytes: rewritten }]]);
}

/**
 * The frontmatter block as text and everything after its closing delimiter as the bytes they are:
 * a body is copied, never decoded, so an upstream that is not UTF-8 survives an override.
 */
function splitFrontmatter(bytes: Buffer): { block: string; rest: Buffer } | null {
  const open = bytes.indexOf("\n");
  if (open === -1 || bytes.subarray(0, open).toString("latin1").replace(/\r$/, "") !== "---")
    return null;
  for (let at = open; at !== -1; at = bytes.indexOf("\n", at + 1)) {
    const lineEnd = bytes.indexOf("\n", at + 1);
    const line = bytes
      .subarray(at + 1, lineEnd === -1 ? bytes.length : lineEnd)
      .toString("latin1")
      .replace(/\r$/, "");
    if (line === "---") {
      const block = bytes
        .subarray(open + 1, at)
        .toString("utf8")
        .replace(/\r$/, "");
      return { block, rest: bytes.subarray(at + 1 + "---".length) };
    }
  }
  return null;
}

/**
 * A vendored SKILL.md's frontmatter belongs to sources.yml (its overrides are the only sanctioned
 * difference from upstream), so only the body and the executable bit can carry a hand edit.
 */
function sameOutsideFrontmatter(ours: Entry | undefined, theirs: Entry | undefined): boolean {
  if (!ours || !theirs || ours.executable !== theirs.executable) return false;
  const body = (entry: Entry) => splitFrontmatter(entry.bytes)?.rest ?? entry.bytes;
  return body(ours).equals(body(theirs));
}

/** Every entry under the copy, read without following links: a symlink or a device is refused, never silently absent. */
export function localSnapshot(dir: string): Files {
  const files = new Map<string, Entry>();
  const rootStat = lstatSync(dir, { throwIfNoEntry: false });
  if (!rootStat) return files;
  if (!rootStat.isDirectory()) {
    throw new Error(
      `${relative(ROOT, dir)}: ${rootStat.isSymbolicLink() ? "a symlink" : "not a directory"}; a copy is a plain folder`,
    );
  }
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const executable = (lstatSync(full).mode & 0o111) !== 0;
        files.set(relative(dir, full), { bytes: readFileSync(full), executable });
      } else {
        throw new Error(
          `${relative(ROOT, full)}: ${entry.isSymbolicLink() ? "a symlink" : "not a regular file"}; the copy carries plain files only`,
        );
      }
    }
  };
  walk(dir);
  return files;
}

export function differences(local: Files, upstream: Files): string[] {
  const paths = new Set([...local.keys(), ...upstream.keys()]);
  return [...paths]
    .filter((path) => {
      const ours = local.get(path);
      const theirs = upstream.get(path);
      if (ours === undefined || theirs === undefined) return true;
      return ours.executable !== theirs.executable || !ours.bytes.equals(theirs.bytes);
    })
    .sort();
}

export function replaceFolder(dir: string, files: Files): void {
  rmSync(dir, { recursive: true, force: true });
  for (const [path, entry] of files) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.bytes);
    if (entry.executable) chmodSync(target, 0o755);
  }
}

export interface Report {
  readonly name: string;
  readonly status: "current" | "updated" | "outdated" | "modified";
  readonly detail: string;
}

/**
 * The xeno folder and every copy root are plain directories or absent; a link at either level
 * (dangling included) is refused before anything is read or written through it.
 */
function assertPlainFolder(path: string, what: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new Error(
      `${relative(ROOT, path) || path}: ${what} is ${stat.isSymbolicLink() ? "a symlink" : "not a directory"}; a copy is a plain folder`,
    );
  }
}

export function check(sources: Sources, externalDir = XENO_DIR): Report[] {
  assertPlainFolder(externalDir, "the xeno folder");
  return Object.entries(sources).map(([name, source]) => {
    assertPlainFolder(join(externalDir, name), "the copy root");
    const head = resolveRef(source.url, source.ref);
    // A pin that is the head is the head: a license_file missing there is the error the sync would hit.
    const pinned = applyOverrides(
      fetchSnapshot(source, source.commit, head === source.commit ? "required" : "if-present")
        .files,
      source.frontmatter,
    );
    const drift = differences(localSnapshot(join(externalDir, name)), pinned);
    if (drift.length > 0)
      return {
        name,
        status: "modified",
        detail: `differs from ${short(source.commit)}: ${drift.join(", ")}`,
      };
    if (
      head !== source.commit &&
      differences(pinned, applyOverrides(fetchSnapshot(source, head).files, source.frontmatter))
        .length > 0
    ) {
      return {
        name,
        status: "outdated",
        detail: `${short(source.commit)} -> ${short(head)} on ${source.ref ?? "the default branch"}`,
      };
    }
    return { name, status: "current", detail: currentDetail(source, head) };
  });
}

/**
 * Every fetch and every hand-edit guard runs before the first folder is touched, so a failing
 * upstream leaves the tree and the pins exactly as they were; the caller writes the pins right after.
 */
export function update(
  sources: Sources,
  externalDir = XENO_DIR,
): { sources: Sources; reports: Report[] } {
  assertPlainFolder(externalDir, "the xeno folder");
  const staged = Object.entries(sources).map(([name, source]) => {
    const dir = join(externalDir, name);
    assertPlainFolder(dir, "the copy root");
    // A new entry (placeholder pin) has no snapshot to hold the copy against; it is taken whole.
    // The pin is judged against the head whether or not the folder is present, so restoring a
    // deleted copy moves it only when the folder itself changed.
    const pinned = PLACEHOLDER.test(source.commit)
      ? undefined
      : applyOverrides(
          fetchSnapshot(source, source.commit, "if-present").files,
          source.frontmatter,
        );
    if (pinned && existsSync(dir)) {
      const local = localSnapshot(dir);
      // sources.yml owns SKILL.md's frontmatter, so a changed override is not a hand edit; the body is.
      // sources.yml owns the frontmatter and the license file it names; a difference there is a registry change, not a hand edit.
      // The registry owns exactly the current license_file's copy; a renamed or dropped one leaves
      // its old copy behind as a difference, and the message below says what to do with it.
      const registryOwned = source.licenseFile ? basename(source.licenseFile) : undefined;
      const edited = differences(local, pinned).filter(
        (path) =>
          path !== registryOwned &&
          (path !== "SKILL.md" || !sameOutsideFrontmatter(local.get(path), pinned.get(path))),
      );
      if (edited.length > 0) {
        throw new Error(
          `${name}: ${relative(ROOT, dir)}/ differs from its pin ${short(source.commit)} (${edited.join(", ")});` +
            " the sync never overwrites a hand edit: restore the folder from git, send the change upstream," +
            " or, after renaming or removing license_file, delete its old copy first",
        );
      }
    }
    const head = fetchSnapshot(source, resolveRef(source.url, source.ref));
    const files = applyOverrides(head.files, source.frontmatter);
    // The pin follows the folder, judged pin against head the way --check judges it, so the two never
    // disagree; the copy is rewritten whenever it differs from head, which re-applies a changed
    // override or license file without a pin move.
    const pinMoves = pinned === undefined || differences(pinned, files).length > 0;
    const rewrite = pinMoves || differences(localSnapshot(dir), files).length > 0;
    return { name, source, dir, head, files, pinMoves, rewrite };
  });
  const next: Record<string, Source> = {};
  const reports: Report[] = [];
  for (const { name, source, dir, head, files, pinMoves, rewrite } of staged) {
    if (rewrite) replaceFolder(dir, files);
    next[name] = pinMoves ? { ...source, commit: head.commit } : source;
    const at = short(source.commit);
    const ref = source.ref ?? "the default branch";
    reports.push(
      pinMoves
        ? { name, status: "updated", detail: `${at} -> ${short(head.commit)} on ${ref}` }
        : rewrite
          ? { name, status: "updated", detail: `at ${at}; copy rewritten` }
          : { name, status: "current", detail: currentDetail(source, head.commit) },
    );
  }
  return { sources: next, reports };
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

/** A current copy whose ref has moved on says so, so the PR body and the log show the head that was looked at. */
function currentDetail(source: Source, head: string): string {
  return head === source.commit
    ? `at ${short(source.commit)}`
    : `at ${short(source.commit)}; ${short(head)} on ${source.ref ?? "the default branch"} leaves the folder as it is`;
}

const USAGE = [
  "usage: sync-xeno.mts [--check] [--report <file>]",
  "  (default)  refresh every xeno/<name>/ whose folder changed at its ref's head and move its pin in sources.yml; a copy hand-edited outside its frontmatter and license file stops the run",
  "  --check    fetch nothing into the tree; exit 1 when the folder at a ref's head differs from its copy, or a copy differs from its pin",
  "  --report   also write the per-skill lines to <file>, one markdown bullet each",
  "exit 0: every copy current (or refreshed); 1: --check found drift; 2: usage, an unreadable sources.yml, a hand-edited copy, or a failed fetch",
].join("\n");

if (import.meta.main) {
  const args = process.argv.slice(2);
  let checkOnly = false;
  let reportFile: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--check") checkOnly = true;
    else if (arg === "--report") {
      reportFile = args[++index];
      if (reportFile === undefined) {
        console.error(`--report needs a file\n${USAGE}`);
        process.exit(2);
      }
    } else {
      console.error(`unknown argument ${arg}\n${USAGE}`);
      process.exit(2);
    }
  }
  let reports: Report[];
  try {
    const sources = loadSources();
    if (checkOnly) {
      reports = check(sources);
    } else {
      const result = update(sources);
      writeSources(result.sources);
      reports = result.reports;
    }
  } catch (error) {
    console.error(`sync-xeno: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const lines = reports.map((report) => `- \`${report.name}\`: ${report.status}, ${report.detail}`);
  if (reportFile !== undefined) writeFileSync(reportFile, `${lines.join("\n")}\n`);
  const drift = reports.filter(
    (report) => report.status === "outdated" || report.status === "modified",
  );
  console.log(
    `sync-xeno: ${reports.length} xeno skill(s)${checkOnly ? `, ${drift.length} with drift` : ""}`,
  );
  for (const line of lines) console.log(`  ${line.slice(2)}`);
  process.exit(checkOnly && drift.length > 0 ? 1 : 0);
}
