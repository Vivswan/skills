# TypeScript

How the standards land in TypeScript: the module and function shape (`../shape.md`), with biome as the floor and ESLint for the order rule, and the barrel rule (`../structure.md`).

Readability and beauty come first: this rule yields where following it would read worse, and the deviation is said in a line. Languages and their tools move, and this page is a silver standard, not gold: a newer version's more beautiful, more readable way of writing a thing wins, even where the page has not caught up.

## The lint floor

In `biome.json`:

```json
{
  "linter": {
    "rules": {
      "complexity": {
        "noExcessiveCognitiveComplexity": { "level": "error", "options": { "maxAllowedComplexity": 15 } },
        "noExcessiveLinesPerFunction": { "level": "error", "options": { "maxLines": 80 } },
        "useMaxParams": { "level": "error", "options": { "max": 6 } }
      },
      "style": {
        "noNestedTernary": "error",
        "noUselessElse": "error",
        "noNegationElse": "error",
        "noParameterAssign": "error",
        "useBlockStatements": "error"
      },
      "suspicious": {
        "noAssignInExpressions": "error",
        "noUnusedExpressions": "error"
      },
      "performance": {
        "noBarrelFile": "error",
        "noReExportAll": "error"
      }
    }
  }
}
```

A violation is split, or the threshold is raised in `biome.json` with its reason; never silenced with `biome-ignore`. A rule whose fix would change behaviour goes off in the same file the same way.

Specimen: `useLiteralKeys` rewrites `record["name"]` to `record.name`, which `tsc` rejects under `noPropertyAccessFromIndexSignature`. The rule is off in `biome.json` with that comment, not ignored line by line.

## Module order, read

Biome has no rule for function order (`noInvalidUseBeforeDeclaration` lets a hoisted function through). Where ESLint runs, one rule carries define-before-use, in its typescript-eslint form so enums, types, and interfaces count too:

```json
{
  "rules": {
    "no-use-before-define": "off",
    "@typescript-eslint/no-use-before-define": ["error", { "functions": true, "classes": true, "variables": true, "enums": true, "typedefs": true }]
  }
}
```

Without ESLint the reviewer reads it. A finding is a place to look, not a verdict: the author who answers one with what reads better keeps the code and says so in a line.

## Module layout

Top to bottom, every module:

```ts
#!/usr/bin/env bun
// One or two lines on what the module is for and what the code cannot show.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const CACHE_DIR = join(process.env.HOME ?? ".", ".cache", "asr");
const SEGMENTS = new Map<string, Segment[]>(); // the one process-wide cache, keyed by video and model
const USAGE = "usage: transcribe.mts <video>...";

type Window = readonly [start: number, end: number];

interface Segment {
  readonly start: number;
  readonly text: string;
}

function readCache(cache: string): Segment[] | undefined { ... }

export function transcribe(video: string, model: string): Segment[] { ... }

if (import.meta.main) { ... }
```

- **Imports, then every module constant in one block** (`const` at module level, caches, regexes, and a command's `USAGE` block included), then types and interfaces, then functions, the exported entry point last. The `import.meta.main` block is the last statement, as the Python main guard is.
- **One exported concept per file,** the file named after it in the repository's casing (`gaussian-noise.ts`, or `GaussianNoise.tsx` where components are PascalCase). The layout rules and the specimen tree: `../structure.md`, A predictable layout.
- **Named exports from the defining module.** An `index.ts` that only re-exports is a barrel (`noBarrelFile`), and an `export * from` line a re-export shim (`noReExportAll`). Importers name the defining file.

## One concept per function

Before, one function holding three concepts (validate, cache, window):

```ts
export function load(path: string, model: string, window?: Window): Segment[] {
  if (!existsSync(path)) {
    throw new Error(`missing: ${path}`);
  }
  if (!AUDIO_SUFFIXES.has(extname(path))) {
    throw new Error(`not audio: ${extname(path)}`);
  }
  const cache = cacheFile(path, model);
  let segments = readCache(cache);
  if (segments === undefined) {
    segments = runAsr(path, model);
    writeCache(cache, segments);
  }
  return window ? withinWindow(segments, window) : segments;
}
```

After, the caller is the list of steps:

```ts
export function load(path: string, model: string, window?: Window): Segment[] {
  const audio = requireAudio(path);
  const segments = cachedSegments(audio, model);

  if (window === undefined) {
    return segments;
  }

  return withinWindow(segments, window);
}
```

## Bodies and guards

Validation is a run of flat guards at the top, each its own paragraph, and they never count toward the one-concept rule:

```ts
function requireAudio(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`missing: ${path}`);
  }

  if (!AUDIO_SUFFIXES.has(extname(path))) {
    throw new Error(`not audio: ${extname(path)}`);
  }

  return path;
}
```

The body unwrapped after its guards (`noUselessElse`), a loop that `continue`s instead of nesting, and the paragraph specimen from `../shape.md`, in TypeScript:

```ts
const key = `${videoKey(video)}:${audioSig(video)}:${model}`;

if (!SEGMENTS.has(key)) {
  const cache = cacheFile(video, model);
  let segments = readCache(cache);

  if (segments === undefined) {
    segments = runAsr(fullAudioWav(video), model, { offset: audioStart(video) });
    writeCache(cache, segments);
  }

  SEGMENTS.set(key, segments);
}

let segments = SEGMENTS.get(key) as Segment[];
if (window !== undefined) {
  segments = withinWindow(segments, window);
}

return withMinWords(segments, minWords);
```

## No ugly one-liners, in TypeScript

The ugly-to-clear table of `../shape.md`, with each row as TypeScript writes it:

| Ugly | Clear |
| --- | --- |
| `a ? b : c ? d : e` | an `if`/`else if` chain, or early returns |
| `[...base, ...(flag ? extra : [])]` | `const items = [...base];` then `if (flag) { items.push(...extra); }` |
| `rows.find((r) => r.id === key)!` | a `Map` keyed by `id`, or a named `findRow` that handles the miss |
| `if ((n = rows.length) > 3)` | `const count = rows.length;` on its own line |
| `ok && doThing()` | `if (ok) { doThing(); }` |
| a guard's body wrapped in `else` | return early, the body follows unwrapped (`noUselessElse`) |
| `f(0.0, 12.5, 0.2)` | `f({ start: 0.0, end: 12.5, pad: 0.2 })`, an options object once three values share a type |

`Array.prototype.find` on a small array is idiomatic, not ugly; the finding is a `find` used as a lookup table, or a `find` whose miss is silenced with `!`.

## Cleanup

`using` (TypeScript 5.2 and later, supported by bun) binds cleanup to the acquisition where the resource exposes `Symbol.dispose`, and more of the platform does every release: a `ChildProcess` disposes by killing itself. Without a disposer, the `try`/`finally` sits directly after the acquisition it cleans, with nothing between them.

```ts
using child = spawn("ffmpeg", args);   // killed when the block ends, on every path
return await collect(child.stdout);
```

```ts
const fd = openSync(path, "r");        // a bare descriptor has no disposer: the finally sits right here
try {
  return readHeader(fd);
} finally {
  closeSync(fd);
}
```

## Types and docs

- **Strict mode, no `any`, an explicit return type on every exported function.** biome's `useExplicitType` (nursery) carries the last where it is enabled; otherwise the reviewer reads it.
- **A JSDoc block on every exported function and type,** carrying what the signature cannot say (the comments standard): the one-line summary, `@param` only where the name does not say it, `@returns` only where the type does not, `@throws` always. A helper whose name says what it does carries none.
- **No underscore-prefixed exports or module names.** An unexported `const` is already private to the module.

The doc shape, on the `transcribe` specimen:

```ts
/**
 * Transcribe a video through the segment cache.
 *
 * @param window - the part of the video to keep, in seconds; the whole video when absent
 * @returns the segments in time order, each with at least `minWords` words
 * @throws {Error} the video has no audio track
 */
export function transcribe(video: string, model: string, window?: Window): Segment[] {
```
