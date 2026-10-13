import { describe, expect, test } from "bun:test";
import { sayAsSpelled } from "../../../skills/project-naming/scripts/columns/say.mts";

describe("say.mts", () => {
  test("a name is ok with its syllable count, or flagged with each reason a reader would stumble on", () => {
    const cases: [string, string][] = [
      ["lumera", "ok(3s)"],
      ["Tarnix", "flag(2s; hard x)"],
      ["villa", "flag(2s; doubled ll)"],
      ["strand", "flag(1s; cluster str)"],
      ["chime", "flag(1s; two readings ch,trailing e)"],
      ["gina", "flag(2s; two readings g before i)"],
      ["bough", "flag(1s; two readings ough)"],
      ["boughgh", "flag(1s; cluster ghgh; two readings ough,gh)"],
      ["eougha", "flag(2s; two readings ough)"],
      ["coughh", "flag(1s; doubled hh; cluster ghh; two readings ough)"],
      ["bread", "flag(1s; two readings ea)"],
      ["table", "ok(2s)"],
      ["vale", "flag(1s; two readings trailing e)"],
      ["my-name", "flag(2s; two readings trailing e)"],
      ["al1luma", "flag(4s; spoken digits 1)"],
      ["abc123", "flag(4s; spoken digits 1,2,3)"],
      ["quokka", "flag(2s; hard q,k; doubled kk)"],
    ];
    for (const [name, expected] of cases) {
      expect(sayAsSpelled(name), name).toEqual({ status: "note", detail: expected });
    }
  });
});
