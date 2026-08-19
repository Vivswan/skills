# Structure Standards: Full Detail

No indirection layers that carry no information: barrel files, compatibility re-exports, and pass-through functions.

## No barrel files or compatibility re-exports

A file that exists only to re-export symbols from other files (an import-only index/barrel, or a "keep old importers compiling" re-export line left after a move) is redundancy to delete, not maintain. When code moves, update every importer to the new defining module in the same change; do not stage compatibility re-exports as a permanent state.

Why: barrels and compat re-exports add an indirection layer with no information. They hide the real dependency graph (everything appears to depend on the barrel), invite cycles, defeat tree-shaking assumptions, and each one is a file whose only job is to be kept in sync. Churn in importers is cheaper than a maintained redundancy.

## No pass-through (escort) functions

The same rule one level down: a function whose whole body forwards to another function escorts it without adding behavior - a stack frame, a name to keep in sync, and a false seam. Callers call the real function; the escort gets deleted. A wrapper earns its existence only by adding something real: a default, a conversion, error mapping, an injected dependency, a narrowed type.

## The same rule in other languages

- **Python**: `__init__.py` runs at package import; keep it EMPTY unless absolutely necessary. Re-exporting symbols from it builds a barrel: the real dependency graph hides behind the package name and import cycles become easy to mint. Importers name the defining module (`from pkg.user import User`, not `from pkg import User`).
- **Rust**: an intra-crate `mod.rs` whose `pub use` fan only re-exports names is the same barrel. The exception is the crate root: a `lib.rs` `pub use` that defines the crate's public API is idiomatic - it is the crate's only way to present a public surface distinct from its internal module tree.
- **Go**: a package that only wraps another package's identifiers adds a hop; callers import the defining package.

The test is identical in every language: does this file or function only forward names?

## How to apply

- When splitting or moving modules, repoint all importers at the defining files directly (a mechanical find/replace is fine, even across dozens of files); delete any file that ends up import-only.
- Transient re-exports are acceptable only as staging INSIDE a multi-step migration, and the migration is not done until a sweep removes them.
- The test for a barrel is "does this file only re-export names", not "does it import a lot": generated aggregators that carry real derived values (registries, merged tables, generated indexes with data) are not barrels.
- The test for an escort is "does this function add any behavior, contract, or type information"; if not, inline it away and repoint callers.
