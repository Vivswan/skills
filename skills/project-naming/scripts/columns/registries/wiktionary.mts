// Wiktionary wikitext in, a reading out: the page's languages and the senses or terms its
// register labels mark offensive. No IO; readers.mts fetches the page and hands the text here.

/** Register labels Wiktionary puts in `{{lb|<lang>|...}}` on a sense, canonical names and their aliases; any one makes the sense a flag. */
const OFFENSIVE_LABELS = new Set([
  "vulgar",
  "coarse",
  "obscene",
  "profane",
  "profanity",
  "swear word",
  "offensive",
  "derogatory",
  "disparaging",
  "pejorative",
  "slur",
]);

/** Any label ending in "slur" (ethnic, racial, religious) counts too. */
function isOffensiveLabel(label: string): boolean {
  return OFFENSIVE_LABELS.has(label) || label.endsWith(" slur");
}

/** The label templates on a sense line: `lb` and its aliases, the older `context` and `cx` among them. */
const SENSE_LABEL = ["lb", "lbl", "label", "context", "cx"];

/** The label templates on a headword line. */
const TERM_LABEL = ["tlb", "term-label"];

type Template = { start: number; end: number; args: string[] };

/** The template opening at `start` whose arguments begin at `argsFrom`, just past `{{name|`, with
 * its top-level arguments: a `|` or `}}` inside a nested template, a linked label or a
 * `sort={{...}}`, belongs to that template. Null when the line ends before the closing `}}`. */
function templateAt(line: string, start: number, argsFrom: number): Template | null {
  const args: string[] = [];
  let depth = 1;
  let argStart = argsFrom;
  let i = argsFrom;
  while (i < line.length && depth > 0) {
    if (line.startsWith("{{", i)) {
      depth++;
      i += 2;
      continue;
    }

    if (line.startsWith("}}", i)) {
      depth--;
      if (depth === 0) args.push(line.slice(argStart, i));
      i += 2;
      continue;
    }

    if (line[i] === "|" && depth === 1) {
      args.push(line.slice(argStart, i));
      argStart = i + 1;
    }
    i++;
  }

  if (depth > 0) return null;

  return { start, end: i, args: args.map((arg) => arg.trim()) };
}

/** Each template on the line with one of the names, in order; an unclosed one ends the list. */
function templates(line: string, names: readonly string[]): Template[] {
  const found: Template[] = [];
  const opener = new RegExp(`\\{\\{(?:${names.join("|")})\\|`, "g");
  for (let match = opener.exec(line); match; match = opener.exec(line)) {
    const template = templateAt(line, match.index, match.index + match[0].length);
    if (template === null) break;

    found.push(template);
    opener.lastIndex = template.end;
  }

  return found;
}

function withoutTemplates(line: string, names: readonly string[]): string {
  let out = "";
  let from = 0;
  for (const template of templates(line, names)) {
    out += line.slice(from, template.start);
    from = template.end;
  }
  return out + line.slice(from);
}

/** A named argument starts with its name and `=`; a nested template's own `=` is not one. */
function isNamed(arg: string): boolean {
  return /^[^{}|=]+=/.test(arg);
}

/** The text a template reads as: its last unnamed argument (`{{synonym of|en|penis}}` reads
 * "penis", `{{l|en|slang}}` as a label reads "slang"). */
function templateText(inner: string): string {
  const unnamed = inner
    .split("|")
    .filter((arg) => !isNamed(arg))
    .slice(1);
  return unnamed[unnamed.length - 1] ?? "";
}

/** Innermost first, so an outer template's last unnamed argument is plain text by the time it is
 * read as the gloss. */
function templatesAsText(text: string): string {
  let out = text;
  while (/\{\{[^{}]*\}\}/.test(out)) {
    out = out.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => templateText(inner));
  }
  return out;
}

/** Wikitext to a readable gloss: label templates go, links keep their shown text, then any other
 * template keeps its last unnamed argument. Links first, so a piped link inside a template is
 * not read as an argument boundary. */
function plainGloss(line: string): string {
  const unlabelled = withoutTemplates(line.replace(/^#+\s*/, ""), [...SENSE_LABEL, ...TERM_LABEL]);
  return templatesAsText(unlabelled.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2"))
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A Wiktionary language code: `en`, `cmn`, `gem-pro`, `roa-opt`. */
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z]{2,3})*$/;

/** The labels the templates on one line carry: their unnamed arguments after the language. The
 * language is the first argument when it has a code's shape; the legacy `{{context|vulgar}}` and
 * `{{context|vulgar|lang=en}}` forms name none there, and every unnamed argument is a label. A
 * named argument is never a label. */
function registerLabels(line: string): string[] {
  const labels: string[] = [];
  for (const { args } of templates(line, [...SENSE_LABEL, ...TERM_LABEL])) {
    const languageNamed = args.some((arg) => /^lang\s*=/.test(arg));
    const unnamed = args.filter((arg) => !isNamed(arg));
    const languageFirst = !languageNamed && LANGUAGE_CODE.test(unnamed[0] ?? "");
    for (const label of languageFirst ? unnamed.slice(1) : unnamed) {
      labels.push(templatesAsText(label).toLowerCase());
    }
  }
  return labels;
}

function offensiveLabels(line: string): string[] {
  return registerLabels(line).filter(isOffensiveLabel);
}

export type WikiReading = { languages: string[]; flags: string[] };

/** One page's languages (its `==Language==` sections), the senses carrying an offensive label, and
 * the terms labelled so as a whole. */
export function readWikitext(wikitext: string): WikiReading {
  const reading: WikiReading = { languages: [], flags: [] };
  let language = "";
  for (const line of wikitext.split("\n")) {
    const heading = /^==([^=].*?)==\s*$/.exec(line);
    if (heading) {
      language = (heading[1] ?? "").trim();
      reading.languages.push(language);
      continue;
    }
    if (/^#[^:*]/.test(line)) {
      if (offensiveLabels(line).length > 0) {
        reading.flags.push(`${language}: ${plainGloss(line).slice(0, 80)}`);
      }
      continue;
    }
    // A term label beside the headword applies to the whole term, every sense included.
    const term = offensiveLabels(withoutTemplates(line, SENSE_LABEL));
    if (term.length > 0) reading.flags.push(`${language}: term labelled ${term.join(", ")}`);
  }
  return reading;
}
