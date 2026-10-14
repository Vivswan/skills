#!/usr/bin/env bun
// The module-order check of the Python shape standard: the two readings a
// reviewer otherwise takes by scrolling, made exact.
//   a module-level assignment below the first def        -> finding, exit 1
//   a function naming a function defined below it         -> finding, exit 1
//   a statement after the if __name__ == "__main__" block -> finding, exit 1
// Python's own ast and symtable modules read the files, so the parse and the
// scope rules are the interpreter's, not a port: the program below runs under
// python3 with -I, and a file Python cannot parse is an unreadable input
// (exit 2), never a finding.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const SELF = basename(import.meta.path).replace(/\.js$/, ".mts");
const USAGE = [
  `usage: ${SELF} [--python <exe>] <path>...`,
  "  <path>    a .py file, or a directory walked for .py files (hidden directories, node_modules, venv, and __pycache__ skipped)",
  "  --python  the interpreter that parses the files (default: python3)",
  "prints: findings one per line as file:line: message, then one stderr line that readability outranks the order",
  "exits: 0 every module is in order; 1 findings; 2 usage, no interpreter, or a file Python cannot parse",
].join("\n");

const SKIPPED_DIRS = new Set(["node_modules", "venv", "__pycache__"]);
const REFRAIN =
  "python-order: a finding is a place to look; readability and beauty come first, and the order yields where it would read worse";

// The analysis, as Python: file paths arrive one per line on stdin, findings leave as JSON lines.
// symtable decides what a function reads from the module, through every scope nested in it, so a
// comprehension variable, a local import, or a parameter of the same name is not a reference to a
// later def. A finding sits at the function's own def line: hunting the use's line through the ast
// re-derives Python's scope rules, and review kept finding a scope that walk resolved wrongly.
// A generic def's table sits inside a type-parameter table, whose type name differs across Python versions.
const ANALYSIS = `
import ast, json, symtable, sys, tokenize

DEFS = (ast.FunctionDef, ast.AsyncFunctionDef)
SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
ASSIGNMENTS = (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.NamedExpr)


def read_source(path):
    with tokenize.open(path) as source:
        return source.read()


def is_main_guard(node):
    if not isinstance(node, ast.If) or not isinstance(node.test, ast.Compare):
        return False
    test = node.test
    if len(test.ops) != 1 or not isinstance(test.ops[0], ast.Eq):
        return False

    left, right = test.left, test.comparators[0]
    names_module = isinstance(left, ast.Name) and left.id == "__name__"
    is_main = isinstance(right, ast.Constant) and right.value == "__main__"

    return names_module and is_main


def module_statements(nodes):
    for node in nodes:
        yield node
        if isinstance(node, SCOPES):
            continue
        if is_main_guard(node):
            yield from module_statements(node.orelse)
            continue

        yield from module_statements(ast.iter_child_nodes(node))


def assigned_name(node):
    target = node.targets[0] if isinstance(node, ast.Assign) else node.target
    if isinstance(target, ast.Name):
        return target.id

    return ast.unparse(target)


def late_assignments(statements, functions):
    if not functions:
        return

    first_def_line = functions[0].lineno
    for node in statements:
        if isinstance(node, ASSIGNMENTS) and node.lineno > first_def_line:
            yield node.lineno, f"{assigned_name(node)} is assigned below the first def; module constants sit in one block after the imports"


def function_table(children, name, lineno):
    for child in children:
        if child.get_lineno() != lineno or child.get_name() != name:
            continue
        if child.get_type() == "function":
            return child

        return function_table(child.get_children(), name, lineno)

    return None


def module_reads(table):
    names = {symbol.get_name() for symbol in table.get_symbols() if symbol.is_global() and symbol.is_referenced()}
    for child in table.get_children():
        names |= module_reads(child)

    return names


def forward_references(functions, module_table):
    defined_at = {}
    for function in functions:
        defined_at.setdefault(function.name, function.lineno)

    for function in functions:
        table = function_table(module_table.get_children(), function.name, function.lineno)
        if table is None:
            continue

        for name in sorted(module_reads(table)):
            if name in defined_at and defined_at[name] > function.lineno:
                yield function.lineno, f"{function.name} uses {name}, defined below it; a function sits above its callers"


def after_main_guard(body):
    for index, node in enumerate(body[:-1]):
        if is_main_guard(node):
            yield body[index + 1].lineno, 'a statement follows the if __name__ == "__main__": block; the guard closes the module'


def check(path):
    source = read_source(path)
    body = ast.parse(source, filename=path).body
    statements = list(module_statements(body))
    functions = [node for node in statements if isinstance(node, DEFS)]
    module_table = symtable.symtable(source, path, "exec")

    findings = [*late_assignments(statements, functions), *forward_references(functions, module_table), *after_main_guard(body)]
    for line, message in sorted(findings):
        print(json.dumps({"file": path, "line": line, "message": message}))


def main():
    for path in sys.stdin.read().splitlines():
        try:
            check(path)
        except SyntaxError as error:
            print(json.dumps({"file": path, "line": error.lineno or 0, "unreadable": str(error.msg)}))


main()
`;

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/** Every .py file under the paths, files named directly included, in path order. */
export function pythonFiles(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (!statSync(path).isDirectory()) {
      out.push(path);
      continue;
    }
    // Bun.Glob skips dot-directories by default, which covers .git and .venv.
    for (const found of new Bun.Glob("**/*.py").scanSync({ cwd: path, onlyFiles: true })) {
      if (!found.split(sep).some((part) => SKIPPED_DIRS.has(part))) out.push(join(path, found));
    }
  }
  return out.sort();
}

export interface Report {
  readonly findings: Finding[];
  /** Files Python could not parse: the syntax error, at its line. */
  readonly unreadable: Finding[];
}

export function checkFiles(files: readonly string[], python = "python3"): Report {
  if (files.length === 0) return { findings: [], unreadable: [] };
  const run = spawnSync(python, ["-I", "-c", ANALYSIS], {
    input: `${files.join("\n")}\n`,
    encoding: "utf8",
  });
  if (run.error || run.status !== 0) {
    const detail = run.error ? run.error.message : run.stderr.trim();
    throw new Error(`${python} failed: ${detail}`);
  }
  const findings: Finding[] = [];
  const unreadable: Finding[] = [];
  for (const line of run.stdout.split("\n").filter((l) => l.length > 0)) {
    const row = JSON.parse(line) as {
      file: string;
      line: number;
      message?: string;
      unreadable?: string;
    };
    if (row.unreadable !== undefined) {
      unreadable.push({ file: row.file, line: row.line, message: row.unreadable });
    } else {
      findings.push({ file: row.file, line: row.line, message: row.message ?? "" });
    }
  }
  return { findings, unreadable };
}

function readArgs(argv: readonly string[]): { python: string; paths: string[] } {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { python: { type: "string", default: "python3" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length === 0) throw new Error("no path given");
  return { python: values.python, paths: positionals };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    process.exit(0);
  }
  try {
    const { python, paths } = readArgs(args);
    const files = pythonFiles(paths.map((p) => resolve(p)));
    const report = checkFiles(files, python);
    const show = (f: Finding) => `${relative(process.cwd(), f.file)}:${f.line}: ${f.message}`;
    for (const f of report.findings) console.log(show(f));
    for (const f of report.unreadable) console.error(`unreadable: ${show(f)}`);
    if (report.findings.length > 0) console.error(REFRAIN);
    process.exit(report.unreadable.length > 0 ? 2 : report.findings.length > 0 ? 1 : 0);
  } catch (error) {
    console.error(`${SELF}: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exit(2);
  }
}
