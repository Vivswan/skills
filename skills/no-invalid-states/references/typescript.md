# TypeScript Strategies

TypeScript's structural type system models domain states precisely as long as you keep the compiler honest: no `any`, no `as` escape hatches, no `!` assertions over your own invariants.

Prefer:

- discriminated unions for mutually exclusive states
- branded (opaque) types for validated values
- literal types and `as const` for closed sets
- exhaustive `never` checks in every `switch` over a union
- generics when state changes the available API
- `readonly` where mutation would break an invariant
- schema validation (whatever the project already uses: zod, valibot, ajv, io-ts, hand-rolled guards) at external boundaries only
- type guards at boundaries, not scattered through internal code

## Discriminated unions

Instead of a flag plus optionals:

```typescript
type Connection = {
  connected: boolean;
  socket?: WebSocket;
};
```

split the states and tag them:

```typescript
type Disconnected = {
  state: "disconnected";
};

type Connected = {
  state: "connected";
  socket: WebSocket;
};

type Connection = Disconnected | Connected;
```

Then let functions demand the state they need:

```typescript
function send(connection: Connected, message: string): void {
  connection.socket.send(message);
}
```

`send` on a disconnected connection no longer compiles, and the `if (!connection.socket)` checks inside it disappear.

## Branded types

```typescript
type UserId = string & {
  readonly __brand: "UserId";
};

function parseUserId(value: string): UserId {
  if (!value) {
    throw new Error("Invalid user ID");
  }

  return value as UserId;
}
```

The single `as` inside the parser is the one sanctioned cast: it is the boundary. After construction, internal APIs accept `UserId` and never re-validate arbitrary strings. Two branded types over the same primitive (`UserId` vs `OrderId`) can no longer be swapped by accident.

## Exhaustiveness

Give every `switch` over a union a `never` default so adding a variant breaks the build everywhere it must be handled:

```typescript
function handle(state: State): void {
  switch (state.kind) {
    case "pending":
      return handlePending(state);

    case "complete":
      return handleComplete(state);

    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}
```

## Boundary schemas

Parse external data (HTTP bodies, env vars, file contents, message queues) once, at the edge, into the internal types. If the project has a schema library, define the schema next to the type and infer one from the other so they cannot drift. Do not sprinkle `typeof x === "string"` guards through business logic; if internal code needs a guard, the boundary leaked.

## What to avoid

`as`, `!`, and `any` used to silence a useful error are the TypeScript equivalents of commenting out a failing test. If the compiler rejects an internal call, strengthen the caller's type instead of asserting.
