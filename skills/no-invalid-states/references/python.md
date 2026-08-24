# Python Strategies

Python applies the same architecture, with the caveat that its static guarantees are only as strong as the type checker the project runs. Check `pyproject.toml` or CI for mypy or pyright before leaning on type-level enforcement; without a checker, prefer runtime-enforced constructions (frozen dataclasses, validating factories) that fail fast.

Prefer:

- distinct dataclasses or classes for meaningfully different states
- `Literal` tags plus unions for discriminated states
- `NewType` for semantically distinct values validated once
- factory functions as the only sanctioned constructors
- `@dataclass(frozen=True)` where mutation would violate an invariant
- `Enum` for dynamic state that code inspects
- `Protocol` for behavioral contracts
- `typing.assert_never` for exhaustive `match` handling
- strict pyright or mypy where the project supports it
- boundary validation (pydantic, marshmallow, or plain parsing functions, whatever the repo already uses) before constructing domain objects

## State-specific types

Instead of a flag plus a nullable field:

```python
class Connection:
    def __init__(self) -> None:
        self.connected = False
        self.socket = None
```

give each state its own type:

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class DisconnectedConnection:
    pass


@dataclass(frozen=True)
class ConnectedConnection:
    socket: "Socket"


def connect(
    connection: DisconnectedConnection,
) -> ConnectedConnection:
    socket = create_socket()
    return ConnectedConnection(socket)


def send(
    connection: ConnectedConnection,
    message: str,
) -> None:
    connection.socket.send(message)
```

Under a type checker, `send` on a disconnected connection is now a static error, and `socket` is never `None` where it is used.

## Validated values with NewType

```python
from typing import NewType

UserId = NewType("UserId", str)


def parse_user_id(value: str) -> UserId:
    if not value:
        raise ValueError("Invalid user ID")

    return UserId(value)
```

Internal functions accept `UserId`; only the parser accepts `str`. The checker then flags any code path that tries to pass an unvalidated string inward.

## Exhaustive state handling

```python
from typing import assert_never


def handle(state: State) -> None:
    match state:
        case Pending():
            handle_pending(state)
        case Complete():
            handle_complete(state)
        case _:
            assert_never(state)
```

Adding a new state class now produces a type error at every match that does not handle it.

## What to avoid

Do not imitate Rust typestate mechanically when ordinary classes or unions are clearer; Python has no move semantics, so a "consumed" old state object still exists and a determined caller can reuse it. Frozen dataclasses, factories, and checker-enforced signatures are the idiomatic strength here. Avoid `# type: ignore` and `cast()` as pressure valves; each one reopens the hole the refactor was meant to close.
