# Strategies for Other Languages

The situation table in SKILL.md maps onto most languages. This file collects the idiomatic mechanism per ecosystem so the skill stays useful outside Rust, TypeScript, and Python.

## Go

Go has no sum types, so lean on package boundaries and construction:

- unexported struct fields with a validating `NewX(...) (X, error)` constructor; outside the package, the constructor is the only way in
- separate types per state (`PendingOrder`, `ShippedOrder`) with transition functions between them
- a closed interface (an unexported method only in-package types can implement) to approximate a sealed set of variants
- defined types (`type UserID string`) plus a parse function; conversions are explicit, so `UserID(raw)` outside the parser is greppable in review

```go
type UserID string

func ParseUserID(raw string) (UserID, error) {
    if raw == "" {
        return "", errors.New("empty user id")
    }
    return UserID(raw), nil
}
```

## Java and Kotlin

- sealed interfaces or sealed classes for mutually exclusive states, with exhaustive `switch` / `when` over them
- records (Java) and data classes (Kotlin) with validation in the compact constructor or `init` block, so an instance existing implies validity
- Kotlin value classes (`@JvmInline value class UserId(val raw: String)`) with a `companion object` factory as the smart constructor
- private constructors plus static factories where a hierarchy is overkill
- non-null types (Kotlin) or `Optional` at boundaries only, never as fields that encode which state the object is in

```kotlin
sealed interface Connection
object Disconnected : Connection
data class Connected(val socket: Socket) : Connection

fun send(connection: Connected, message: String) =
    connection.socket.send(message)
```

## C#

- abstract base class with a fixed set of sealed nested subclasses (or the OneOf library if the project already uses it) as a discriminated union
- records with validation in the constructor; `init`-only and `required` properties to force complete construction
- exhaustive `switch` expressions with no discard arm over your own state hierarchies
- readonly structs wrapping a validated primitive as the newtype

## Swift

Swift enums with associated values are a first-class sum type; use them directly:

```swift
enum Connection {
    case disconnected
    case connected(Socket)
}
```

`switch` is exhaustive by default. For validated primitives, wrap in a struct with a failable or throwing initializer and a private raw value.

## Haskell, OCaml, F#, Elm, Scala

Algebraic data types are the native answer. The characteristic pattern is the smart constructor: export the type abstractly, hide its data constructor, and export only a validating function:

```haskell
module UserId (UserId, parseUserId) where

newtype UserId = UserId Text

parseUserId :: Text -> Either ParseError UserId
```

Phantom type parameters give typestate where lifecycles matter. In Scala, use `sealed trait` hierarchies or enums with exhaustive `match`.

## Dynamic languages (Ruby, untyped JS, Elixir, Clojure)

Without a checker, encode invariants in construction rather than types:

- immutable value objects whose constructor validates and raises
- factory methods as the single entry point; make `new` private (Ruby)
- distinct classes per state so wrong-state calls fail immediately with NoMethodError instead of misbehaving later
- pattern matching over tagged tuples or structs (Elixir) with no catch-all clause
- gradual typing (Sorbet, TypeScript migration, typespecs plus dialyzer) when the project already has it; do not introduce one just for this skill

## Databases and schemas

Some invariants belong below the application:

- `NOT NULL` instead of "this column is never null, trust us"
- `CHECK` constraints for value ranges and legal state combinations
- foreign keys instead of application-side existence checks
- `UNIQUE` constraints instead of check-then-insert races
- enum columns or lookup tables for closed sets

A database constraint outlives every application rewrite. When the invariant is about stored data, enforce it there and let the application types mirror it.
