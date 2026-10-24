# Go

How the standards land in Go: the module and function shape (`../shape.md`) with golangci-lint as the floor, and the barrel rule (`../structure.md`).

Readability and beauty come first: this rule yields where following it would read worse, and the deviation is said in a line. Languages and their tools move, and this page is a silver standard, not gold: a newer version's more beautiful, more readable way of writing a thing wins, even where the page has not caught up.

## The lint floor

In `.golangci.yml` (v2 layout):

```yaml
version: "2"
linters:
  enable:
    - gocognit
    - gocyclo
    - funlen
    - nestif
    - nakedret
    - revive
  settings:
    gocognit:
      min-complexity: 15
    gocyclo:
      min-complexity: 15
    funlen:
      lines: 80
      statements: 50
    nestif:
      min-complexity: 3
    nakedret:
      max-func-lines: 0
```

A violation is split, or the threshold is raised in `.golangci.yml` with its reason; never silenced with `//nolint`. A rule that fights the shape goes off in the same file the same way.

Specimen: a `run` that registers twelve subcommands in one table is one concept over eighty lines. `funlen` is raised for it in `.golangci.yml` with that reason, not cut into pieces nobody calls alone.

## File order, read

Go lets a function sit anywhere, and no linter reads the order, so the reviewer does. The reader still meets each function once when it sits above its callers. A finding is a place to look, not a verdict: the author who answers one with what reads better keeps the code and says so in a line.

## File layout

Top to bottom, every file:

```go
// Package asr transcribes a video through a segment cache.
package asr

import (
	"os"
	"path/filepath"
	"sync"
)

// Shared with the asr command line, which prunes it; nothing here deletes.
const cacheDirName = ".cache/asr"

// The one process-wide cache, keyed by video and model, and the mutex every reader and writer takes.
var (
	segments   = map[cacheKey][]Segment{}
	segmentsMu sync.Mutex
)

type Window struct{ Start, End float64 }

type cacheKey struct{ video, audio, model string }

// Segment is one timed span of transcribed text.
type Segment struct {
	Start float64
	Text  string
}

func readCache(cache string) ([]Segment, bool) { ... }

// Transcribe returns the segments of video in time order.
func Transcribe(video, model string, window *Window) ([]Segment, error) { ... }
```

- **`package`, imports, then every package-level `const` and `var` in one block** (grouped `const (...)` and `var (...)`), then types, then functions with the entry point (`main`, the exported constructor) last. `main` is the last function in `main.go`.
- **Files group by concern, not one type per file:** Go's unit is the package, so the one-type-per-module rule does not transfer. A file still carries one concern, is named after it (`gaussian_noise.go` in `package noise`), and its test sits beside it as `gaussian_noise_test.go`.
- **A package that only wraps another package's identifiers adds a hop.** Callers import the defining package.

## One concept per function

Before, one function holding three concepts (validate, cache, window):

```go
func Load(path, model string, window *Window) ([]Segment, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, err
	}
	if !audioSuffixes[filepath.Ext(path)] {
		return nil, fmt.Errorf("not audio: %s", filepath.Ext(path))
	}
	cache := cacheFile(path, model)
	segments, ok := readCache(cache)
	if !ok {
		var err error
		if segments, err = runASR(path, model); err != nil {
			return nil, err
		}
		writeCache(cache, segments)
	}
	if window != nil {
		return withinWindow(segments, *window), nil
	}
	return segments, nil
}
```

After, the caller is the list of steps:

```go
func Load(path, model string, window *Window) ([]Segment, error) {
	audio, err := requireAudio(path)
	if err != nil {
		return nil, err
	}

	segments, err := cachedSegments(audio, model)
	if err != nil {
		return nil, err
	}

	if window == nil {
		return segments, nil
	}

	return withinWindow(segments, *window), nil
}
```

The rule runs both ways: a step called from one place that is no concept of its own folds back into its caller. A `.golangci.yml` setting tighter than the floor above (complexity 15, 80 lines, 50 statements) is a defect, since it forces splits that read worse.

## Bodies and guards

Validation is a run of flat guards at the top, each its own paragraph, and they never count toward the one-concept rule:

```go
func requireAudio(path string) (string, error) {
	if _, err := os.Stat(path); err != nil {
		return "", err
	}

	if !audioSuffixes[filepath.Ext(path)] {
		return "", fmt.Errorf("not audio: %s", filepath.Ext(path))
	}

	return path, nil
}
```

The body unwrapped after its guards, a loop that `continue`s instead of nesting, and the paragraph specimen from `../shape.md`, in Go:

```go
key := cacheKey{videoKey(video), audioSig(video), model}

segmentsMu.Lock()
defer segmentsMu.Unlock()

if _, ok := segments[key]; !ok {
	cache := cacheFile(video, model)
	found, ok := readCache(cache)

	if !ok {
		wav, err := fullAudioWav(video)
		if err != nil {
			return nil, err
		}

		found, err = runASR(wav, model, audioStart(video))
		if err != nil {
			return nil, err
		}
		writeCache(cache, found)
	}

	segments[key] = found
}

result := segments[key]
if window != nil {
	result = withinWindow(result, *window)
}

return withMinWords(result, minWords), nil
```

## No ugly one-liners, in Go

The ugly-to-clear table of `../shape.md`, with each row as Go writes it:

| Ugly | Clear |
| --- | --- |
| `if err := f(); err != nil { ... } else { ... }` | `err := f()` then `if err != nil { return err }` then a straight line |
| a `for` body nested under `if ok {` | `if !ok { continue }` at the top of the body |
| a guard's body wrapped in `else` | return early, the body follows unwrapped |
| naked `return` with named results | explicit values (`nakedret`) |
| `New(0.0, 12.5, 0.2)` | an options struct once three values share a type |
| `func() T { ... }()` inline to compute a value | a named function |

`switch` over an `if`/`else if` chain on the same value.

## Cleanup

`defer` directly after the acquisition's error guard, so every return path from there releases it and a failed acquisition never reaches the `defer`. A cleanup call every return path must remember is the finding.

```go
f, err := os.Open(path)
if err != nil {
	return nil, err
}
defer f.Close()
```

```go
dir, err := os.MkdirTemp("", "asr-")
if err != nil {
	return nil, err
}
defer os.RemoveAll(dir) // best effort: a failed cleanup must not mask the real error
```

## Types and docs

- **A doc comment on every exported identifier,** starting with its name (revive's `exported` rule), carrying what the signature cannot say; an unexported helper whose name says what it does carries none.
- **Visibility is the capital letter;** nothing else marks it, and no name carries a prefix for it.

The doc shape, on the `Transcribe` specimen:

```go
// Transcribe returns the segments of video in time order, each with at least
// minWords words. A nil window keeps the whole video. It returns ErrNoAudio
// when the video has no audio track.
func Transcribe(video, model string, window *Window) ([]Segment, error) {
```
