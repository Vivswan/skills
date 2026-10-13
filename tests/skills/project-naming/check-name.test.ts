import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ROOT } from "../../../scripts/lib.mts";
import {
  checkName,
  columns,
  type Options,
  renderRegistries,
  renderTsv,
  run,
  runControls,
  tlds,
} from "../../../skills/project-naming/scripts/check-name.mts";
import {
  REGISTRIES,
  type Registry,
} from "../../../skills/project-naming/scripts/columns/registries/table.mts";
import type { Cell, Io } from "../../../skills/project-naming/scripts/core/cells.mts";
import {
  allTakenIo,
  CRATES_PAGE,
  cell,
  detail,
  dnsFailure,
  fakeIo,
  OPTIONS,
  RANDOM,
  WITH_ARXIV,
  withReply,
} from "../../helpers/project-naming";

const SCRIPT = join(ROOT, "skills", "project-naming", "scripts", "check-name.mts");

describe("check-name.mts controls", () => {
  test("every registry column, DNS and arXiv included, has a taken control that fails when the instrument reads free; the say note has none", async () => {
    const failures = await runControls(
      fakeIo(() => undefined),
      WITH_ARXIV,
      RANDOM,
    );
    expect(failures.map((f) => f.column).sort()).toEqual(
      [
        "pypi",
        "npm",
        "crates",
        "homebrew",
        "docker",
        "maven",
        "hf",
        "github-user",
        "github-repo",
        "bluesky",
        "arxiv",
        "dns-com",
        "wiktionary",
        "urban",
        "typosquat",
      ].sort(),
    );
    expect(failures.every((f) => f.expected === "taken")).toBe(true);
    expect(failures.find((f) => f.column === "dns-com")?.control).toBe("@");
    // The say column is a note on every name, the random one included, so it is no instrument
    // and never a failure.
    expect(failures.map((f) => f.column)).not.toContain("say");
  });

  test("the typosquat control must hit on every ranking: a crates list without the neighbour is a failed instrument while PyPI and npm carry it", async () => {
    const base = allTakenIo(["nic.com"]);
    const cratesBlind: Io = {
      ...base,
      fetch: (input, init) =>
        new URL(input).pathname === "/api/v1/crates"
          ? Promise.resolve(Response.json(CRATES_PAGE([]).body))
          : base.fetch(input, init),
    };
    const failures = await runControls(cratesBlind, OPTIONS, RANDOM);
    expect(failures.map((f) => f.column)).toEqual(["typosquat"]);
    expect(failures.map((f) => f.got.status)).toEqual(["taken"]);
    expect(failures.map((f) => detail(f.got))[0]).not.toContain("crates");
  });

  test("a resolver blind to every host fails the DNS taken control while the HTTP controls pass", async () => {
    const failures = await runControls(allTakenIo([]), WITH_ARXIV, RANDOM);
    expect(failures).toEqual([
      { column: "dns-com", control: "@", expected: "taken", got: { status: "free" } },
    ]);
  });

  test("the DNS taken control is the zone's delegation, so a zone whose registry serves no nic host (co.uk, uk, ca) passes it, and a zone nothing delegates fails it free", async () => {
    // nic.co.uk does not exist and nic.uk has no address, so a control host under the zone
    // failed every accepted zone of that kind; a delegated zone has name servers by definition.
    const zones: Options = { ...OPTIONS, domains: ["co.uk", "uk", "ca"] };
    const io = allTakenIo(["example.co.uk", "example.ca"]);
    expect(await runControls(io, zones, RANDOM)).toEqual([]);
    const control = await checkName(io, zones, "lumera");
    expect(cell(control.cells, "dns-co.uk")).toEqual({ status: "free" });
    const bogus: Options = { ...OPTIONS, domains: ["xyzzy"] };
    expect(await runControls(io, bogus, RANDOM)).toEqual([
      { column: "dns-xyzzy", control: "@", expected: "taken", got: { status: "free" } },
    ]);
    // The server list and the candidates' lookups are different resolvers: the control resolves
    // a listed server through the candidates' one, so a system lookup blind to every host fails
    // the control free while the stub resolver still delegates the zone.
    const com: Options = { ...OPTIONS, domains: ["com"] };
    const blind: Io = {
      ...allTakenIo(["nic.com"]),
      resolve: async () => {
        throw dnsFailure("ENOTFOUND");
      },
    };
    expect(await runControls(blind, com, RANDOM)).toEqual([
      { column: "dns-com", control: "@", expected: "taken", got: { status: "free" } },
    ]);
    // A resolver that cannot answer leaves the control unknown, never free.
    const dark: Io = {
      ...io,
      resolveNs: async () => {
        throw dnsFailure("EAI_AGAIN");
      },
    };
    const [failure] = await runControls(dark, com, RANDOM);
    expect(failure?.got).toEqual({ status: "unknown", detail: "com EAI_AGAIN" });
  });

  test("the Wiktionary control must come back flagged: a label-less reading of the control word is a failed instrument", async () => {
    const base = allTakenIo(["nic.com"]);
    const io: Io = {
      ...base,
      fetch: async (input, init) => {
        const url = new URL(input);
        // Both the lowercase and the capitalised page come back without labels.
        if (
          url.hostname === "en.wiktionary.org" &&
          url.searchParams.get("page")?.toLowerCase() === "pajero"
        ) {
          return new Response(
            JSON.stringify({ parse: { wikitext: "==Spanish==\n# itinerant straw seller\n" } }),
            { status: 200 },
          );
        }
        return base.fetch(input, init);
      },
    };
    const failures = await runControls(io, OPTIONS, RANDOM);
    expect(failures).toEqual([
      {
        column: "wiktionary",
        control: "pajero",
        expected: "taken",
        got: { status: "taken", detail: "word in Spanish" },
      },
    ]);
  });

  test("a registry that answers 200 to the random control is a failed instrument, expected free", async () => {
    const io = withReply(
      allTakenIo(["nic.com"]),
      "registry.npmjs.org",
      () => new Response("{}", { status: 200 }),
    );
    const failures = await runControls(io, OPTIONS, RANDOM);
    expect(failures).toEqual([
      {
        column: "npm",
        control: RANDOM,
        expected: "free",
        got: { status: "taken", detail: "npm package" },
      },
    ]);
  });

  test("run() reports the candidate rows beside the control verdicts", async () => {
    const result = await run(allTakenIo(["nic.com"]), OPTIONS, ["lumera", "tarnix"]);
    expect(result.failures).toEqual([]);
    expect(result.rows.map((row) => row.name)).toEqual(["lumera", "tarnix"]);
  });
});

describe("check-name.mts registry table", () => {
  // A registry that exists only in this test: the table is the one place a column is defined, so
  // an entry added there must reach the columns, the header, and the control rows with no other
  // change. A column that needed a second edit elsewhere would be missing from one of them.
  const extra: Registry = {
    kind: "registry",
    id: "extra",
    label: "a registry added by the test",
    takenControl: "occupied",
    lookup: async (_io, name) =>
      name === "occupied" ? { status: "taken", detail: "extra entry" } : { status: "free" },
  };
  const extended: Options = { ...OPTIONS, table: [...REGISTRIES, extra] };

  test("an entry added to the table is a column, a header field, and a control row with no other change", async () => {
    expect(columns(extended).map((c) => c.id)).toEqual([
      ...columns(OPTIONS).map((c) => c.id),
      "extra",
    ]);
    const row = await checkName(
      fakeIo(() => undefined),
      extended,
      "lumera",
    );
    expect(cell(row.cells, "extra")).toEqual({ status: "free" });
    const tsv = renderTsv(extended, [row]);
    expect(tsv.split("\n")[0]?.endsWith("\tsay\textra")).toBe(true);
    const failures = await runControls(allTakenIo(["nic.com"]), extended, RANDOM);
    expect(failures).toEqual([]);
    const blind: Options = {
      ...extended,
      table: [...REGISTRIES, { ...extra, lookup: async (): Promise<Cell> => ({ status: "free" }) }],
    };
    expect(await runControls(allTakenIo(["nic.com"]), blind, RANDOM)).toEqual([
      { column: "extra", control: "occupied", expected: "taken", got: { status: "free" } },
    ]);
  });

  test("--domain spellings of one zone make one column: case, a dot on either end, a repeat, and a Unicode zone next to its punycode; a spelling that names no zone is rejected by name", () => {
    expect(tlds(["com", "COM", ".com", "com.", "com"])).toEqual({ zones: ["com"], rejected: [] });
    expect(tlds(["ai", "com", "AI"]).zones).toEqual(["ai", "com"]);
    // The resolver takes the punycode form only; the Unicode spelling would read every name free.
    // IDNA maps the ideographic and fullwidth full stops to a dot, on either end too.
    expect(tlds(["\u4e2d\u56fd", "xn--fiqs8s", "XN--FIQS8S", "\uff23om"]).zones).toEqual([
      "xn--fiqs8s",
      "com",
    ]);
    expect(tlds(["com\u3002", "\uff0ecom", "\uff61com\uff61", "co.uk"]).zones).toEqual([
      "com",
      "co.uk",
    ]);
    // A space is no host; a comma is what --registries splits on, so its column could never be
    // selected; a slash would be dropped with everything after it; dots alone leave no zone; a
    // hex spelling is read as an IPv4 address; a label has at most 63 characters and no dash at
    // either end; a host name has at most 253, and the name before the zone up to 39.
    const longest = Array(3).fill("a".repeat(63)).join(".");
    const notZones = [
      "com ",
      "com,net",
      "com/evil",
      ".",
      "",
      "0x7f000001",
      "a".repeat(64),
      "-com",
      "com-",
      `${longest}.${"b".repeat(22)}`,
    ];
    expect(tlds(notZones)).toEqual({ zones: [], rejected: notZones });
    expect(tlds(["a".repeat(63), `${longest}.${"b".repeat(21)}`]).zones).toEqual([
      "a".repeat(63),
      `${longest}.${"b".repeat(21)}`,
    ]);
    for (const spellings of [
      ["com", "COM"],
      ["com", "com"],
    ]) {
      const options: Options = { ...OPTIONS, domains: tlds(spellings).zones };
      const dnsIds = columns(options)
        .map((c) => c.id)
        .filter((id) => id.startsWith("dns-"));
      expect(dnsIds, spellings.join(" ")).toEqual(["dns-com"]);
      const header = renderTsv(options, []).trimEnd().split("\t");
      expect(new Set(header).size, spellings.join(" ")).toBe(header.length);
    }
  });

  test("--registries narrows the availability columns, the controls, and the header to the ids named, dns ids included; the four gate columns run regardless", async () => {
    const subset: Options = { ...WITH_ARXIV, registries: ["npm", "dns-com"] };
    const gates = ["wiktionary", "urban", "typosquat", "say"];
    expect(columns(subset).map((c) => c.id)).toEqual(["npm", "dns-com", ...gates]);
    const failures = await runControls(
      fakeIo(() => undefined),
      subset,
      RANDOM,
    );
    expect(failures.map((f) => f.column)).toEqual([
      "npm",
      "dns-com",
      "wiktionary",
      "urban",
      "typosquat",
    ]);
    const tsv = renderTsv(subset, []);
    expect(tsv).toBe(`name\tnpm\tdns-com\t${gates.join("\t")}\n`);
    // Naming a gate column is allowed and changes nothing.
    expect(columns({ ...subset, registries: ["say", "npm"] }).map((c) => c.id)).toEqual([
      "npm",
      ...gates,
    ]);
    expect(renderRegistries(REGISTRIES).split("\n")[0]).toBe("id\tlabel\ttaken control\tgate");
    const rows = renderRegistries(REGISTRIES).trimEnd().split("\n").slice(1);
    expect(rows.filter((row) => row.endsWith("\tyes")).map((row) => row.split("\t")[0])).toEqual(
      gates,
    );
  });
});

describe("check-name.mts output", () => {
  test("the TSV carries one row per name with every cell spelled out, so an empty cell cannot pass as free", () => {
    const tsv = renderTsv(OPTIONS, [
      {
        name: "lumera",
        cells: {
          pypi: { status: "free" },
          npm: { status: "taken", detail: "npm package" },
          crates: { status: "unknown", detail: "crate HTTP 500" },
          say: { status: "note", detail: "ok(3s)" },
        },
      },
    ]);
    const [header, row] = tsv.trimEnd().split("\n");
    expect(header).toBe(
      "name\tpypi\tnpm\tcrates\thomebrew\tdocker\tmaven\thf\tgithub-user\tgithub-repo\tbluesky\tdns-com\twiktionary\turban\ttyposquat\tsay",
    );
    expect(row).toBe(
      `lumera\tfree\ttaken(npm package)\tunknown(crate HTTP 500)${"\tunknown(missing)".repeat(11)}\tnote(ok(3s))`,
    );
  });

  test("no name, or a name with characters no registry accepts, is a usage error before any lookup", () => {
    const none = Bun.spawnSync([process.execPath, SCRIPT], { stdout: "pipe", stderr: "pipe" });
    expect(none.exitCode).toBe(2);
    expect(none.stderr.toString()).toContain("usage:");
    // An id the table lacks, and an empty id (which would otherwise select no column at all and
    // print an empty row as a clean run), are refused before any lookup.
    for (const selection of ["npm,gopher", "", ",npm"]) {
      const refused = Bun.spawnSync(
        [process.execPath, SCRIPT, "--registries", selection, "lumera"],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(refused.exitCode, selection).toBe(2);
      expect(refused.stderr.toString(), selection).toContain("--registries");
    }
    // A valid selection that --no-arxiv then empties would print a clean row with no cells.
    const emptied = Bun.spawnSync(
      [process.execPath, SCRIPT, "--registries", "arxiv", "--no-arxiv", "lumera"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(emptied.exitCode).toBe(2);
    expect(emptied.stderr.toString()).toContain("no column");
    // Dots alone would resolve the bare name as a host; a space or a comma is no zone at all.
    for (const tld of [".", "", "com ", "com,net"]) {
      const notHost = Bun.spawnSync([process.execPath, SCRIPT, "--domain", tld, "lumera"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(notHost.exitCode, JSON.stringify(tld)).toBe(2);
      expect(notHost.stderr.toString(), JSON.stringify(tld)).toContain(
        `--domain: not a top-level domain: ${JSON.stringify(tld)}`,
      );
    }
    // A space, a trailing dash, and a 40th character: each refused by some registry, so none
    // may be read as free there.
    for (const name of ["two words", "example-", `a${"b".repeat(39)}`]) {
      const bad = Bun.spawnSync([process.execPath, SCRIPT, "lumera", name], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(bad.exitCode, name).toBe(2);
      expect(bad.stderr.toString(), name).toContain(name);
    }
  });
});
