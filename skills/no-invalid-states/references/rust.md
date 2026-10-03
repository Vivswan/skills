# Rust Strategies

Rust has the strongest toolkit for this skill. Ownership, move semantics, and zero-cost type-level state make many invariants free to enforce.

Prefer, roughly in order of reach:

- enums for mutually exclusive runtime states
- newtypes for validated or semantically distinct values
- typestate for lifecycle-dependent APIs
- `PhantomData` for zero-sized type-level state markers
- consuming `self` for state transitions
- private fields with controlled constructors
- `TryFrom`, `FromStr`, and fallible constructors for boundary validation
- exhaustive `match` (avoid `_` arms over your own state enums)
- ownership and borrowing instead of runtime coordination where practical

## Typestate

Instead of a runtime flag:

```rust
struct Connection {
    connected: bool,
}
```

parameterize the type by its state:

```rust
use std::marker::PhantomData;

struct Disconnected;
struct Connected;

struct Connection<State> {
    inner: Inner,
    _state: PhantomData<State>,
}

impl Connection<Disconnected> {
    fn connect(self) -> Result<Connection<Connected>, Error> {
        // establish the connection, then rewrap as Connection<Connected>
        todo!()
    }
}

impl Connection<Connected> {
    fn send(&mut self, data: &[u8]) -> Result<(), Error> {
        // sending only exists in this state
        todo!()
    }
}
```

Calling `send` on a disconnected connection is now a compile error, and the `connected: bool` checks disappear.

## Consuming transitions

Prefer a transition that consumes the previous state:

```rust
fn initialize(self) -> Result<Resource<Ready>, Error>
```

over one that mutates a flag:

```rust
fn initialize(&mut self) {
    self.initialized = true;
}
```

Consuming `self` makes reuse of the stale state impossible. The old value is moved away, so the borrow checker rejects any later use of it.

## Newtypes at the boundary

```rust
pub struct UserId(String);

impl TryFrom<String> for UserId {
    type Error = ParseError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty() {
            return Err(ParseError::EmptyUserId);
        }
        Ok(UserId(value))
    }
}
```

Keep the inner field private so the only way to obtain a `UserId` is through validation. Internal APIs then take `UserId`, not `&str`, and never re-validate.

## Enums over flag clusters

When several optionals travel together, collapse them into variants:

```rust
enum Payment {
    Card { number: CardNumber, expiry: Expiry },
    Invoice { po_number: PoNumber },
}
```

instead of a struct with `card_number: Option<_>`, `expiry: Option<_>`, and `po_number: Option<_>` plus a comment about which combinations are legal.

## Unsafe behind a safe API

An `unsafe` block is an invariant the compiler cannot check. The same rule applies: one owner upholds it, callers never re-check. The owner is the module that holds the private fields.

```rust
pub fn push(&mut self, value: T) {
    if self.len == self.cap {
        self.grow();
    }
    // SAFETY: the grow above leaves len < cap, so ptr + len is a slot this struct
    // owns and no value is stored there yet.
    unsafe { self.ptr.add(self.len).write(value) };
    self.len += 1;
}
```

- **The signature is safe.** `push` carries no `unsafe`, so a caller cannot be handed an obligation it has no way to meet.
- **The block holds one operation.** The grow check and the length update stay in safe code, so the `SAFETY:` comment has exactly one claim to make and a reviewer one line to audit.
- **The comment names the invariant and what established it.** Its shape is the `/code-standards` skill's comment standard; the lint only demands that it exists.
- **An `unsafe fn` is the exception, not the default.** Use it only when the caller is the one who can uphold the invariant, and state the obligation in a `/// # Safety` section. If the module could check it itself, make the function safe and check there.

At crate scale, the owner is a quarantine: deny `unsafe` for the workspace and re-allow it per audited module, each allow carrying its justification.

```toml
# Cargo.toml at the workspace root
[workspace.lints.rust]
unsafe_code = "deny"

# Cargo.toml of EVERY member crate: a member without this line inherits nothing
[lints]
workspace = true
```

```rust
//! ipc/peercred.rs: the one FFI call that reads the peer's credentials off the socket.
#![allow(unsafe_code)]
```

Everything outside those modules is then safe Rust by construction, and a new `unsafe` block anywhere else fails the build until it is moved behind an owner.

## What to avoid

- **Do not reach for** `Rc<RefCell<_>>`, `Arc<Mutex<_>>`, cloning, heap allocation, or `unsafe` merely to dodge designing ownership correctly.
- **If a typestate refactor forces one of these in**, the refactor is wrong-shaped for this code. Fall back to an enum or separate types.
