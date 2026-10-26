# Python

How the standards land in Python: the module and function shape (`../shape.md`), with ruff as the floor and a checker for the module order, and the barrel rule (`../structure.md`).

Readability and beauty come first: this rule yields where following it would read worse, and the deviation is said in a line. Languages and their tools move, and this page is a silver standard, not gold: a newer version's more beautiful, more readable way of writing a thing wins, even where the page has not caught up.

## The lint floor

In `pyproject.toml`:

```toml
[tool.ruff.lint]
extend-select = ["C90", "PLR", "PLW", "RET", "PIE", "C4", "PERF", "ERA", "N", "ARG", "PTH", "RUF", "ANN", "D"]
ignore = [
  "PLR2004",  # a literal beside its comparison reads better than a one-use constant
  "D1",       # presence is the reviewer's call (a helper whose name says what it does carries none); ruff holds the shape
  "D202",     # the body starts after a blank line, so the docstring reads as its own paragraph
]

[tool.ruff.lint.mccabe]
max-complexity = 12

[tool.ruff.lint.pylint]
max-branches = 12
max-statements = 50
max-args = 8
max-returns = 6

[tool.ruff.lint.pydocstyle]
convention = "google"
```

`C901` and the pylint counts (`PLR0904`, `PLR0911`, `PLR0912`, `PLR0913`, `PLR0914`, `PLR0915`, `PLR0916`, `PLR0917`) are advisory: a threshold is a hint about readability, and a forced split can read worse. Ruff has no per-rule severity, so a gate runs them as a separate exit-zero pass (the fleet's does), and the other families block:

```bash
ruff check . --select C901,PLR0904,PLR0911,PLR0912,PLR0913,PLR0914,PLR0915,PLR0916,PLR0917 --exit-zero   # the thresholds: findings print, the job stays green
ruff check . --ignore C901,PLR0904,PLR0911,PLR0912,PLR0913,PLR0914,PLR0915,PLR0916,PLR0917               # everything else blocks
```

`PLR0904`, `PLR0914`, and `PLR0916` are preview rules, so they fire only under `preview = true`. A threshold finding is read, then the function is split, or the known case is a scoped `per-file-ignores` entry here with its reason. The thresholds in the block are the numbers, none set tighter:

```toml
[tool.ruff.lint.per-file-ignores]
"src/train.py" = ["PLR0915"]  # train is one concept, and it is long
```

A blocking violation is fixed, never silenced with `noqa`. A rule whose fix would change behaviour goes off here in the `ignore` list with its reason, never inline. Without that exit, an agent re-implements a library's semantics to satisfy a lint.

Specimen: `PTH207` asks for `Path.glob` in place of `glob.glob`, but `glob.glob` accepts absolute patterns and skips dotfiles and `Path.glob` does neither, so the rule is ignored in `pyproject.toml` with that comment.

## Module order, checked

Ruff has no rule for module order (`E402` covers imports alone, and ruff takes no plugins), so the checker reads the order rules through Python's own `ast` and `symtable`, and a reviewer never scrolls for them. The path is relative to the installed skill folder:

```bash
bun "<skill-dir>/scripts/python-order.mts" src/
```

```text usage=skills/code-standards/scripts/python-order.mts
usage: python-order.mts [--python <exe>] <path>...
  <path>    a .py file, or a directory walked for .py files (hidden directories, node_modules, venv, and __pycache__ skipped)
  --python  the interpreter that parses the files (default: python3)
prints: findings one per line as file:line: message, then one stderr line that readability outranks the order
exits: 0 every module is in order; 1 findings; 2 usage, no interpreter, or a file Python cannot parse
```

```text
$ bun "<skill-dir>/scripts/python-order.mts" tools/
tools/transcribe.py:14: main uses transcribe, defined below it; a function sits above its callers
tools/transcribe.py:88: SEGMENTS is assigned below the first def; module constants sit in one block after the imports
```

A finding is a place to look, not a verdict. The author who answers one with what reads better keeps the code and says so in a line; the checker exists so the order is a choice made on purpose, never an accident of writing.

What it reads, exactly:

- An assignment anywhere at module level below the first `def`, inside an `if`, `try`, or `with` included, a walrus included. The one exception is the body of an exact `if __name__ == "__main__":`, whose assignments are the script's own setup; its `else` branch and any other test on `__name__` are read.
- A dispatch table naming functions is such an assignment: it has to sit below the functions it names, which puts it below the first `def`. It is built inside the function that uses it (`../shape.md`, Module layout).
- A module function (a top-level `def`, or one inside a module-level `if` or `try`) that reads a module function defined below it, through every scope nested in it. Python's own scope rules decide what is a read: a parameter, a local, a comprehension variable, or a local import of the same name is not one; a nested `global` declaration is. The finding sits at the reading function's `def` line.
- A statement after the `if __name__ == "__main__":` block. The guard calls the entry point and closes the module.
- Not read: a class body (the layout puts classes above the functions, and the reviewer judges that by eye) and a decorator or default value, which run at module level.

## Module layout

- **`__all__` only in a module with a name to keep out of its interface,** right after the imports, naming what other modules import. A module where every name is public carries none. Specimen: a tree where every name was public carried an `__all__` in every module, all removed.
- **One main thing per module, with its helpers,** the file named after it in its own case: `GaussianNoise.py` holds the class `GaussianNoise`, `reduce_precision.py` the function `reduce_precision`. A stage's records, constants, and small functions share its `records.py`, `constants.py`, and `util.py`. The layout rules and the specimen tree: `../structure.md`, A predictable layout.
- **`__init__.py` stays empty** unless absolutely necessary; the package root's carries only the package's name, author, and version. Re-exporting from it builds a barrel: the real dependency graph hides behind the package name and import cycles become easy to mint. Importers name the defining module (`from pkg.user import User`, never `from pkg import User`).

## Cleanup and ugly one-liners

A `with` block wherever a native context manager exists: `open`, `tempfile.TemporaryDirectory`, `subprocess.Popen`, `contextlib.suppress` for an ignored exception. A hand-written `try`/`finally` for cleanup, or a `try`/`except ...: pass`, is a finding.

The ugly-to-clear table in `../shape.md` is written in Python; nothing is added here.

## Docstrings and names

- **A Google-style docstring on every public function and class:** a one-line summary, then the Google sections that apply (`Attributes:`, `Args:`, `Returns:` or `Yields:`, `Raises:`, `Examples:`), one line per item, and a blank line after the docstring before the body. ruff's `D` family under the google convention holds the shape; `D1` stays ignored so a small helper whose name says what it does carries none.
- **An `Args:` line reads `name: what it is`;** annotated code may omit the parenthesised type, and `name (type): what it is` is fine too. Pick one per repository and stop flipping.
- **A docstring says what the function returns and what the arguments mean.** One over three short paragraphs, or one narrating the function's behaviour, is a sign the function does too much. Specimen: a four-paragraph cache narrative on a `transcribe` function, replaced by a split of the function and one-line docstrings.
- **Every signature annotated,** held by ruff's `ANN` family.
- **No underscore-prefixed names,** module level or attribute: not functions, constants, caches, or fields. The underscore marks only what the module's user must never touch (the common case: the value behind a property and its setter) and a third-party hook whose name the framework fixes, commented as such. Specimen: classes with `self._x` fields and no accessor, all made public.

The docstring shape, from the `train` specimen with its syntax modernised:

```python
def train(
    model: nn.Module,
    train_loader: DataLoader,
    epoch: int | None = None,
    test_run: bool = False,
) -> tuple[float, float]:
    """Train the model on the train set.

    Args:
        model: the model to train.
        train_loader: the train set.
        epoch: the current epoch, for the progress line.
        test_run: stop after the first batch.

    Returns:
        The loss and accuracy of the model on the train set.

    Raises:
        ValueError: the train set is empty.
    """

    model.train()
    ...
```

The other Google sections appear where they apply, in this order after the summary: `Attributes:` on a class (one line per attribute, as the `GaussianNoise` specimen has), `Args:`, `Yields:` on a generator in place of `Returns:`, `Raises:`, `Examples:` as a doctest block. A section with nothing to say is left out, never written empty.
