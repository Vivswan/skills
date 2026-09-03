import { expect } from "bun:test";
import { CheckFailure, errorMessage } from "../../scripts/lib";

// Both halves of a rejection in one invocation: runChecks() reports a
// CheckFailure as FAIL and any other throw as a crash, so the class matters
// as much as the branch-specific message.
export function expectCheckFailure(
  run: () => unknown,
  message: string | RegExp,
  reason?: string,
): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, reason).toBeInstanceOf(CheckFailure);
  expect(errorMessage(thrown), reason).toMatch(message);
}
