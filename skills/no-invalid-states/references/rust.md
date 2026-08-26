# Rust Strategies

Rust has the strongest toolkit for this skill: ownership, move semantics, and zero-cost type-level state make many invariants free to enforce.

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

Consuming `self` makes reuse of the stale state impossible: the old value is moved away, so the borrow checker rejects any later use of it.

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

## What to avoid

- Do not reach for `Rc<RefCell<_>>`, `Arc<Mutex<_>>`, cloning, heap allocation, or `unsafe` merely to dodge designing ownership correctly.
- If a typestate refactor forces one of these in, the refactor is wrong-shaped for this code. Fall back to an enum or separate types.
