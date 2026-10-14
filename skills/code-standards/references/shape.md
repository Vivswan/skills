# Module and Function Shape: Full Detail

The deep version of one standard: a module reads top to bottom with nothing to scroll back for, and a function reads as the list of its steps. The rules are language-neutral. Python is the worked language, since the specimens that set the shape are Python; how each rule lands in Python, TypeScript, Rust, and Go, with the lint that holds it, is one page per language under `languages/`.

Every rule on this page is a default to start from, not a law. The concept at hand decides: a deviation that reads better in its case stands, and the reviewer who questions it says what would read better. The lint floors are backstops with the same standing.

The page is a silver standard, not gold. Languages and their tools move faster than it does: when a newer version has a more beautiful, more readable way of writing a thing, use it, and bring the page up to it afterwards.

The specimens are three repositories by this skill's author: [AnalogVNN](https://github.com/Vivswan/AnalogVNN) (`analogvnn/fn/train.py`, `analogvnn/fn/reduce_precision.py`), [DeDuplicationDict](https://github.com/Vivswan/DeDuplicationDict) (`deduplicationdict/__init__.py`), and [AnalogLayers](https://github.com/Vivswan/AnalogLayers) (`finetune.py`, `equations/helper_fn.py`). They pre-date modern typing: keep the shape, modernise the syntax.

## Module layout

Top to bottom, every module:

```python
"""Transcribe a video through a segment cache."""

import json
from dataclasses import dataclass
from pathlib import Path

__all__ = ["transcribe"]

# Module constants, one block, grouped; a reason comment only where the value is not self-evident.
CACHE_DIR = Path.home() / ".cache" / "asr"
SEGMENTS: dict[tuple[str, str], list[str]] = {}  # the one process-wide cache, keyed by video and model

Window = tuple[float, float]


@dataclass(frozen=True)
class Segment:
    start: float
    text: str


def read_cache(cache: Path) -> list[Segment] | None:
    ...


def transcribe(video: Path, model: str) -> list[Segment]:
    ...
```

- **Constants sit in one block after the imports,** caches included. A constant placed mid-file beside its one use is a finding: the reader meets module state in one place or hunts for it.
- **A table that names functions** (a dispatch dict, a handler list) cannot sit in that block without breaking the order rule below. It is built inside the function that uses it.
- **Types before functions:** aliases, data classes, and the one class a module is named after come after the constants and before the first function. One public thing per module, the module named after it in that thing's own case (`structure.md`, A predictable layout), where the language's package model allows (`languages/go.md` is the exception).
- **Section separators mark a small, clearly bounded group only.** A module that wants `# ----- section` comments is usually two modules: split it, one module per concern.

Readability and beauty come first: this rule yields where following it would read worse, and the deviation is said in a line.

## Define before use

Every function sits above the functions that call it. The top functions depend on nothing, and the entry point (`main`, the public parse function, the exported command) is the last definition in the module. The guard that calls it (`if __name__ == "__main__":`, `import.meta.main`) is the last statement. A reader going top to bottom has already met every name a body uses.

Why this order and not the other: with the entry point first, every call is a forward reference the reader resolves by scrolling down and back. With it last, the module is read once. Languages that hoist (TypeScript, Rust, Go) make the other order legal, not readable.

The order yields when it cannot be had or reads worse: mutual recursion, a table of handlers, a module whose story reads better told from its entry point down. Readability and beauty come first, the order serves them, and a deviation is stated in a line where it happens rather than forced.

The Python checker reads both module rules through the interpreter's own `ast` and `symtable`; `languages/python.md` carries its usage. TypeScript has ESLint's `no-use-before-define` for the order rule (`languages/typescript.md`); Rust and Go have no lint for it, and the reviewer reads it.

Readability and beauty come first: this rule yields where following it would read worse, and the deviation is said in a line.

## One concept per function

A function does one thing a reader can name in a few words: train the model, read the cache, apply the window. It may be long when the thing is long: the `train` specimen is sixty lines and one concept. The guards at its top never count as a second concept.

A function doing two nameable things, or whose raises serve two different concepts, is split into named steps, and the caller reads like the list of those steps. A complexity lint is the backstop, not the definition (the thresholds are on each language page). A violation is split, or the threshold is raised at config level with its reason; it is never silenced inline.

Before, one function holding three concepts:

```python
def load(path: Path, model: str, window: Window | None) -> list[Segment]:
    if not path.exists():
        raise FileNotFoundError(path)
    if path.suffix not in AUDIO_SUFFIXES:
        raise ValueError(f"not audio: {path.suffix}")
    cache = cache_file(path, model)
    if cache.exists():
        segments = read_cache(cache)
    else:
        segments = run_asr(path, model)
        write_cache(cache, segments)
    return within_window(segments, window) if window else segments
```

After, the caller is the list of steps:

```python
def load(path: Path, model: str, window: Window | None) -> list[Segment]:
    audio = require_audio(path)
    segments = cached_segments(audio, model)

    if window is None:
        return segments

    return within_window(segments, window)
```

Readability and beauty come first: this rule yields where following it would read worse, and the deviation is said in a line.

## Guards first, then a straight line

- **Validation is a run of flat guards at the top of the function,** each `if ...: raise` its own paragraph, and they never count toward the one-concept rule. They may still move into a `require_*` function (`require_audio` above) when the caller reads better as a list.
- **A guard clause returns early,** and the body follows unwrapped, never inside an `else`.
- **A loop bails out with `continue`** instead of nesting the rest of its body.

```python
for entry in entries:
    if entry.skipped:
        continue

    total += entry.size
```

Readability and beauty come first: this rule yields where following it would read worse, and the deviation is said in a line.

## No ugly one-liners

Each ugly one-liner has a clear form that reads once, and the clear form is the clever one. The table is in Python; each language page repeats it in its own syntax.

| Ugly | Clear |
| --- | --- |
| `a if x else (b if y else c)` | an `if`/`elif`/`else` block, or early returns |
| `[*base, *(extra if flag else [])]` | `items = list(base)` then `if flag: items.extend(extra)` |
| `next(s for s in rows if s.id == key)` | a dict keyed by `id`, or a named `find_row` function |
| `if (n := len(rows)) > 3:` | `count = len(rows)` on its own line |
| `ok and do_thing()` | `if ok:` then the call |
| nested `if` inside `if` | early returns, the happy path at the left margin |
| `try: ... finally: shutil.rmtree(tmp)` | `with tempfile.TemporaryDirectory() as tmp:` |
| `try: ... except KeyError: pass` | `with contextlib.suppress(KeyError):` |

The last two rows are one rule: cleanup is bound to its acquisition by the language's construct (`with`, `defer`, `Drop`, `using`), never by a hand-written cleanup block that sits apart from what it cleans.

Three more that are shape, not syntax:

- **One computation per line,** its result under a plain-noun name (`segments`, `cache`, never `tmp`, `res`, `x`).
- **Named arguments** once a call passes three or more values of the same type: `clip(start=0.0, end=12.5, pad=0.2)`, never `clip(0.0, 12.5, 0.2)`. A language without keyword arguments passes an options object or struct.
- **A long signature puts one parameter per line.**

Readability and beauty come first: this rule yields where following it would read worse, and the deviation is said in a line.

## Bodies read as paragraphs

A blank line after the docstring, after the setup lines (grouped by topic, a blank line between groups), between decision blocks (each `if` that decides something stands alone), between the branches of an `if`/`elif`/`else`, and before the final return. No blank line inside a two-line pair that is one thought: an `if` and its single consequence.

A short step comment opens a block only when its names do not already say what the block does.

The specimen that set the rule, as approved:

```python
key = (video_key(video), audio_sig(video), model)

if key not in SEGMENTS:
    cache = cache_file(video, model)
    segments = read_cache(cache)

    if segments is None and window is not None:
        return with_min_words(transcribe_window(video, model, window), min_words)

    if segments is None:
        segments = run_asr(full_audio_wav(video), model, offset=audio_start(video))
        write_cache(cache, segments)

    SEGMENTS[key] = segments

segments = SEGMENTS[key]
if window is not None:
    segments = within_window(segments, window)

return with_min_words(segments, min_words)
```

Read the blank lines: setup, then the cache decision as its own paragraph with two inner decisions, then the window pair kept together because it is one thought, then the return.

Readability and beauty come first: this rule yields where following it would read worse, and the deviation is said in a line.

## Typed, documented, public

- **Every signature is typed,** parameters and return, where the language lets a signature go untyped.
- **A doc comment on every public function and type,** in the language's doc form (a Google-style docstring, JSDoc, `///`, a Go doc comment), carrying what the signature cannot say: the comments standard applies to it. A small helper whose name says what it does carries none.
- **No underscore-prefixed names** at module level beyond what the language's visibility model means: not functions, not constants, not caches. A module's names are its interface, and a reader should not meet two visibilities. The one exception is a third-party hook whose name the framework fixes, commented as such.

Readability and beauty come first: this rule yields where following it would read worse, and the deviation is said in a line.

## How to apply

- Writing a module: lay the constants block down first, then write the leaves, then the function that uses them, so the order falls out of the writing.
- A complexity finding: name the concepts the function holds and split along them. The names are the design. One nameable concept over the threshold raises the threshold, with the reason beside it.
- Sweeping a tree: enable the lint floor first, then split what it finds. One tree enabled the floor after a shape sweep and found dozens of multi-concept functions the sweep had passed.
- Reviewing: the checker runs before the review, and its empty output is a verified line in the review prompt. Then read every body for its paragraphs, its guards, and the ugly one-liners in the table.
- A review prompt that asks for correctness alone reviews half the standard. Many correctness rounds on one tool found real defects every time and passed every nested conditional, splice, and a sixteen-argument call; the shape criteria in SKILL.md go into the prompt.
