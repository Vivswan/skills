# Rust

How the standards land in Rust: the module and function shape (`../shape.md`) with clippy as the floor, the barrel rule (`../structure.md`), and the `SAFETY:` comment (`../comments.md`).

Readability and beauty come first: this rule yields where following it would read worse, and the deviation is said in a line. Languages and their tools move, and this page is a silver standard, not gold: a newer version's more beautiful, more readable way of writing a thing wins, even where the page has not caught up.

## The lint floor

In `Cargo.toml` and `clippy.toml`:

```toml
# Cargo.toml
[lints.rust]
missing_docs = "deny"
unfulfilled_lint_expectations = "deny"  # an #[expect] whose lint stopped firing is stale, and the build says so

[lints.clippy]
too_many_arguments = "warn"
too_many_lines = "warn"
cognitive_complexity = "warn"
manual_let_else = "deny"
collapsible_if = "deny"
collapsible_else_if = "deny"
needless_return = "deny"
if_not_else = "deny"
missing_errors_doc = "deny"
missing_panics_doc = "deny"
module_name_repetitions = "allow"  # noise::GaussianNoise is the layout rule, the module named after its main thing
```

```toml
# clippy.toml
too-many-arguments-threshold = 8
too-many-lines-threshold = 100
cognitive-complexity-threshold = 15
```

The three thresholds warn: a threshold is a hint about readability, and a forced split can read worse. A finding is split, or the known case carries `#[expect(clippy::<lint>, reason = "...")]`, which fails when stale under the deny above.

The other rules deny: a violation is fixed, never silenced with `#[allow(...)]`. A rule that fights the shape goes to `allow` in `Cargo.toml` with its reason, as `module_name_repetitions` does above. `cognitive_complexity` is off in clippy's default set; naming it under `[lints.clippy]` turns it on by itself.

## Module order, read

Rust lets a function sit anywhere, and clippy has no rule for the order, so the reviewer reads it. The reader still meets each function once when it sits above its callers. A finding is a place to look, not a verdict: the author who answers one with what reads better keeps the code and says so in a line.

## Module layout

Top to bottom, every module:

```rust
//! Transcribe a video through the segment cache.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

const CACHE_DIR: &str = ".cache/asr";
static SEGMENTS: LazyLock<Mutex<HashMap<CacheKey, Vec<Segment>>>> = LazyLock::new(Default::default);

type Window = (f64, f64);
type CacheKey = (String, String, String);

#[derive(Debug, Clone)]
pub struct Segment {
    pub start: f64,
    pub text: String,
}

impl Segment { ... }

fn read_cache(cache: &Path) -> Option<Vec<Segment>> { ... }

pub fn transcribe(video: &Path, model: &str, window: Option<Window>) -> Result<Vec<Segment>, AsrError> { ... }
```

- **`use` lines, then every `const` and `static` in one block,** then types (structs, enums, aliases), then `impl` blocks, then free functions with the entry point last. A binary's `main` is the last function in `main.rs`.
- **One main thing per module, with its helpers,** a behaviour type or a stage's main function, the module named after it in snake case (`gaussian_noise.rs` holds `GaussianNoise`, which is why `module_name_repetitions` is allowed; `transcribe.rs` above centres on `transcribe` with its `Segment` type); a folder's siblings of one kind share a `records`, `constants`, or `util` module. The layout rules and the specimen tree: `../structure.md`, A predictable layout.
- **A `mod.rs` whose `pub use` fan only re-exports names is a barrel.** The exception is the crate root, where `lib.rs`'s `pub use` defines the public API. Importers name the defining module.

## One concept per function

Before, one function holding three concepts (validate, cache, window):

```rust
pub fn load(path: &Path, model: &str, window: Option<Window>) -> Result<Vec<Segment>, AsrError> {
    if !path.exists() {
        return Err(AsrError::Missing(path.to_owned()));
    }
    if !AUDIO_SUFFIXES.contains(&path.extension().and_then(|e| e.to_str()).unwrap_or("")) {
        return Err(AsrError::NotAudio(path.to_owned()));
    }
    let cache = cache_file(path, model);
    let segments = match read_cache(&cache) {
        Some(segments) => segments,
        None => {
            let segments = run_asr(path, model)?;
            write_cache(&cache, &segments)?;
            segments
        }
    };
    Ok(match window {
        Some(window) => within_window(segments, window),
        None => segments,
    })
}
```

After, the caller is the list of steps:

```rust
pub fn load(path: &Path, model: &str, window: Option<Window>) -> Result<Vec<Segment>, AsrError> {
    let audio = require_audio(path)?;
    let segments = cached_segments(audio, model)?;

    let Some(window) = window else {
        return Ok(segments);
    };

    Ok(within_window(segments, window))
}
```

The rule runs both ways: a step called from one place that is no concept of its own folds back into its caller. A `clippy.toml` threshold tighter than the floor above (8 arguments, 100 lines, complexity 15) is a defect, since it forces splits that read worse.

## Bodies and guards

Validation is a run of flat guards at the top, each its own paragraph, and they never count toward the one-concept rule:

```rust
fn require_audio(path: &Path) -> Result<&Path, AsrError> {
    if !path.exists() {
        return Err(AsrError::Missing(path.to_owned()));
    }

    let Some(suffix) = path.extension().and_then(|e| e.to_str()) else {
        return Err(AsrError::NotAudio(path.to_owned()));
    };

    if !AUDIO_SUFFIXES.contains(&suffix) {
        return Err(AsrError::NotAudio(path.to_owned()));
    }

    Ok(path)
}
```

The body unwrapped after its guards, a loop that `continue`s instead of nesting, and the paragraph specimen from `../shape.md`, in Rust:

```rust
let key = (video_key(video), audio_sig(video), model.to_owned());

let mut cache = SEGMENTS.lock().expect("the cache lock is never poisoned: no holder panics");
if !cache.contains_key(&key) {
    let file = cache_file(video, model);
    let segments = match read_cache(&file) {
        Some(segments) => segments,
        None => {
            let segments = run_asr(&full_audio_wav(video)?, model, audio_start(video))?;
            write_cache(&file, &segments)?;
            segments
        }
    };

    cache.insert(key.clone(), segments);
}

let mut segments = cache[&key].clone();
if let Some(window) = window {
    segments = within_window(segments, window);
}

Ok(with_min_words(segments, min_words))
```

## No ugly one-liners, in Rust

The ugly-to-clear table of `../shape.md`, with each row as Rust writes it:

| Ugly | Clear |
| --- | --- |
| `if let Some(x) = a { if let Some(y) = x.b { ... } }` | `let Some(x) = a else { return };` then a straight line, or `?` |
| `.map(...).unwrap_or_else(\|\| ...)` three deep | named intermediates, one computation per line |
| `.iter().find(\|r\| r.id == key).unwrap()` | a `HashMap` keyed by `id`, or a named `find_row` returning `Option` |
| `cond.then(\|\| do_thing())` as control flow | `if cond { do_thing() }` |
| a guard's body wrapped in `else` | `return` early, the body follows unwrapped |
| `new(0.0, 12.5, 0.2)` | a struct argument or builder once three values share a type |

`match` over an `if`/`else if` chain on the same value; `continue` at the top of a loop body instead of nesting the rest.

## Cleanup

`Drop` binds cleanup to the value, so every return path, `?` included, releases it. The standard library and the usual crates already own the common resources: `File`, `MutexGuard`, `tempfile::TempDir`. A manual cleanup call that every return path must remember is the finding, and so is a hand-written guard for a resource a crate already owns (the library rule).

```rust
let work = tempfile::tempdir()?;
let wav = full_audio_wav(video, work.path())?;
```

A resource no crate wraps gets its own guard struct, the only place `impl Drop` is written by hand:

```rust
struct PidFile(PathBuf);

impl Drop for PidFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0); // best effort: a failed cleanup must not mask the real error
    }
}
```

## Types and docs

- **A `///` doc comment on every `pub` item** (`missing_docs`): a one-line summary, then `# Errors` on a `Result` (`missing_errors_doc`), `# Panics` where it can (`missing_panics_doc`), `# Examples` where one helps, carrying what the signature cannot say. A private helper whose name says what it does carries none.
- **Visibility is the language's:** `pub` where another module uses it, nothing else. A private field or helper is what the module's user must never touch, so it carries no `_` prefix: a getter `fn x(&self)` sits beside a private field `x`. A leading underscore means "unused" to the compiler and stays only on a name a framework or linker fixes, commented as such.

The doc shape, on the `transcribe` specimen:

```rust
/// Transcribe a video through the segment cache.
///
/// `window` keeps that part of the video, in seconds; `None` keeps the whole video.
///
/// # Errors
///
/// `AsrError::NoAudio` when the video has no audio track.
pub fn transcribe(video: &Path, model: &str, window: Option<Window>) -> Result<Vec<Segment>, AsrError> {
```
