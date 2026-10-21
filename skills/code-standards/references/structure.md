# Structure Standards: Full Detail

No indirection layers that carry no information: barrel files, compatibility re-exports, and pass-through functions.

## No barrel files or compatibility re-exports

A file that exists only to re-export symbols from other files is redundancy to delete, not maintain. That covers the import-only index/barrel and the "keep old importers compiling" re-export line left after a move.

When code moves, update every importer to the new defining module in the same change. Do not stage compatibility re-exports as a permanent state.

Why: barrels and compat re-exports add an indirection layer with no information.

- They hide the real dependency graph: everything appears to depend on the barrel.
- They invite cycles and defeat tree-shaking assumptions.
- Each one is a file whose only job is to be kept in sync.

Churn in importers is cheaper than a maintained redundancy.

## No pass-through (escort) functions

The same rule one level down: a function whose whole body forwards to another function escorts it without adding behavior. It costs a stack frame, a name to keep in sync, and a false seam. Callers call the real function, and the escort gets deleted.

A wrapper earns its existence only by adding something real: a default, a conversion, error mapping, an injected dependency, a narrowed type.

## A confusing layout is a defect

Folder structure is code. A layout that confuses a reader is tech debt and is fixed, not preserved; any file or folder may move, and nothing in a repository is off limits.

A path something outside the repository reads by name (`.github/workflows/`, a skill folder's `SKILL.md`, a published package's import path) is that reader's contract, not layout; moving it is a visible change, never a pure move. Everything else is layout.

A pure move lands as its own PR. Every path the move changes follows it in the same change: references to the old path from elsewhere (importers, workflow and manifest paths, comments) and relative paths inside the moved file. Nothing is left behind to keep old paths working (the barrel rule above).

The PR body carries an export census (the exported names before and after, equal) and the test count (equal). A move mixed with an edit hides the edit inside rename rows; split them.

A whole-repo reorganisation is proposed as a target layout first, one tree with one line per folder saying what lives there, and files move only after the owner agrees to it.

## A predictable layout

A reader predicts where a thing lives before looking, and the import line names the file. The rules below are defaults the case may override; the specimen is one package of [AnalogVNN](https://github.com/Vivswan/AnalogVNN), by this skill's author:

```text
analogvnn/
  backward/     BackwardModule.py  BackwardFunction.py  BackwardIdentity.py  BackwardUsingForward.py
  fn/           train.py  test.py  reduce_precision.py  dirac_delta.py  to_matrix.py
  nn/
    activation/   Activation.py  ReLU.py  SiLU.py  Sigmoid.py  Tanh.py  Gaussian.py  ...
    noise/        Noise.py  GaussianNoise.py  LaplacianNoise.py  PoissonNoise.py  UniformNoise.py
    precision/    Precision.py  ReducePrecision.py  StochasticReducePrecision.py
  utils/        is_cpu_cuda.py  to_tensor_parameter.py  render_autograd_graph.py
```

- **The file is named after its main public thing,** a behaviour class or a stage's main function, in that thing's own case, and holds that thing with its helpers: `GaussianNoise.py` holds the class `GaussianNoise`, `reduce_precision.py` the function `reduce_precision`. The import line `from analogvnn.nn.noise.GaussianNoise import GaussianNoise` is predictable from either end.
- **A stage's siblings of one kind share one module:** `records` holds its records, `constants` its constants, `util` its small functions, each in the language's file form (`records.py`, `constants.py`, `util.py` in the specimen's Python), and a package that fits one module is one module.
- **A module named after its main thing may hold that thing alone.** The defect is a helper of one caller, or a constant, given its own module outside those three. Specimen: one sweep split a tree into 269 modules, among them a file holding a single format-conversion helper and another holding a default layer list.
- **A file per function is the same defect from the other side.** A file holds one concept with its helpers, as a function holds one concept with its steps (`shape.md`, One concept per function).
- **A folder is a concept,** and inside it the base sits beside one file per variant (`Noise.py` beside the four noises). Adding a variant adds one file; nothing else moves.
- **Every sibling has the same internal template,** and every module follows the one module template (`shape.md`, Module layout), so the reader knows where the constants, the class, and the entry point sit before opening the file. The specimen's reading: "it is easy to even just predict where the thing will be".
- **Sibling stages mirror their names.** In a pipeline the stage is the folder and the concept is the file name, repeated across stages: `equations/dpuc_input.py` and `simulation/results_parser/dpuc_input.py` are one concept at two stages.
- **Entry points sit at the root,** one runnable script per run (`finetune.py`, `run_pca.py`). A `utils/` folder holds the small functions several stages share, grouped by what they serve, as a stage's `util.py` holds its own.
- **Package metadata and constants have one home each:** the root `__init__.py` carries only the package's name, author, and version; a package-wide constant (one that two or more modules read) lives in one constants module, never beside its first use. A module's own constants sit in its constants block (`shape.md`, Module layout).
- **Not sure where a thing goes: ask the user, with options.** Two or three candidate placements, each with the import line it would give and what sits beside it. A guessed placement is the one the reader cannot predict.

Readability and beauty come first: this rule yields where following it would read worse, and the deviation is said in a line.

The specimens pre-date modern typing. The layout is what to copy; the syntax is modernised.

## The same rule in other languages

The test is identical in every language: does this file or function only forward names? How each language spells the barrel (`__init__.py`, `mod.rs`, `index.ts`, a wrapping package) is on its page under `languages/`.

## How to apply

- When splitting or moving modules, repoint all importers at the defining files directly (a mechanical find/replace is fine, even across dozens of files). Delete any file that ends up import-only.
- Transient re-exports are acceptable only as staging INSIDE a multi-step migration, and the migration is not done until a sweep removes them.
- The test for a barrel is "does this file only re-export names", not "does it import a lot": generated aggregators that carry real derived values (registries, merged tables, generated indexes with data) are not barrels.
- The test for an escort is "does this function add any behavior, contract, or type information". If not, inline it away and repoint callers.
