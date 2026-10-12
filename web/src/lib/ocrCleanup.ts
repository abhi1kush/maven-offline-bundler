const POM_TAGS = [
  "project",
  "modelVersion",
  "parent",
  "groupId",
  "artifactId",
  "version",
  "relativePath",
  "packaging",
  "name",
  "description",
  "url",
  "properties",
  "dependencies",
  "dependency",
  "exclusions",
  "exclusion",
  "scope",
  "optional",
  "type",
  "classifier",
  "build",
  "plugins",
  "plugin",
  "pluginManagement",
  "dependencyManagement",
  "configuration",
  "executions",
  "execution",
  "goals",
  "goal",
  "phase",
  "inherited",
  "id",
  "modules",
  "module",
  "repositories",
  "repository",
  "profiles",
  "profile",
  "resources",
  "resource",
  "directory",
  "includes",
  "include",
  "excludes",
  "exclude",
  "filtering",
  "finalName",
  "extensions",
  "extension",
  "java.version",
] as const;

const ATTRIBUTE_NAMES = ["xmlns", "xsi", "schemaLocation", "version", "encoding"] as const;

function confuse(name: string): string {
  return name.toLowerCase().replace(/[1l|]/g, "i").replace(/[0o]/g, "o");
}

function dictionary(names: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of names) {
    const key = confuse(name);
    const existing = map.get(key);
    if (existing && existing !== name) map.set(key, "");
    else map.set(key, name);
  }
  return map;
}

const TAGS = dictionary(POM_TAGS);
const ATTRIBUTES = dictionary(ATTRIBUTE_NAMES);

export function tagKeyCollisions(): string[] {
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const name of POM_TAGS) {
    const key = confuse(name);
    const existing = seen.get(key);
    if (existing) collisions.push(`${existing} ~ ${name}`);
    else seen.set(key, name);
  }
  return collisions;
}

function canonical(name: string, dict: Map<string, string>): string {
  const mapped = dict.get(confuse(name));
  return mapped || name;
}

function normalizePunctuation(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[“”„‟″〝〞]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[—–−]/g, "-")
    .replace(/[＜〈‹⟨«]/g, "<")
    .replace(/[＞〉›⟩»]/g, ">")
    .replace(/／/g, "/");
}

function unescapeDominantEntities(text: string): string {
  const escaped = text.match(/&lt;/g)?.length ?? 0;
  const raw = text.match(/</g)?.length ?? 0;
  if (escaped < 3 || escaped <= raw) return text;
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function gutterSplit(line: string): { num: number; rest: string } | null {
  const pipe = line.match(/^[ \t]{0,8}(\d{1,4})[ \t]*[|:](.*)$/);
  if (pipe) return { num: Number(pipe[1]), rest: pipe[2] };
  const spaced = line.match(/^[ \t]{0,8}(\d{1,4})([ \t].*|<.*)$/);
  if (spaced) return { num: Number(spaced[1]), rest: spaced[2] };
  return null;
}

function stripSharedGap(rest: string, gap: number): string {
  let index = 0;
  while (index < gap && (rest[index] === " " || rest[index] === "\t")) index += 1;
  return rest.slice(index);
}

export function stripEditorLineNumbers(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const parsed = lines.map((line) => ({ line, gutter: gutterSplit(line) }));
  const numbered = parsed.filter((item) => item.gutter);
  const nonempty = lines.filter((line) => line.trim()).length;
  if (numbered.length < 3 || numbered.length < nonempty * 0.45) return lines.join("\n");

  const numbers = numbered.map((item) => item.gutter?.num ?? 0);
  let ordered = 1;
  let previous = numbers[0] ?? 0;
  for (const value of numbers.slice(1)) {
    if (value >= previous && value <= previous + 5) ordered += 1;
    previous = value;
  }
  if (numbers.length > 1 && ordered < numbers.length * 0.7) return lines.join("\n");

  const gaps = numbered.map((item) => item.gutter?.rest.match(/^[ \t]*/)?.[0].length ?? 0);
  const gap = gaps.length > 0 ? Math.min(...gaps) : 0;

  return parsed
    .map((item) => {
      if (item.gutter) return stripSharedGap(item.gutter.rest, gap);
      const broken = item.line.match(/^[ \t]{0,8}[OoIl|]{1,4}(?:[ \t]*[|:]|[ \t])(.*)$/);
      return broken ? broken[1] : item.line;
    })
    .join("\n");
}

function isChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.includes("<")) return false;
  return trimmed.length <= 48;
}

function dropEditorChrome(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && isChromeLine(lines[start])) start += 1;
  while (end > start && isChromeLine(lines[end - 1])) end -= 1;
  return lines.slice(start, end).join("\n");
}

function repairTagLine(line: string): string {
  const missing = line.match(/^(\s*)([A-Za-z_][\w.-]*)>([\s\S]*)$/);
  if (missing && TAGS.has(confuse(missing[2]))) {
    return `${missing[1]}<${canonical(missing[2], TAGS)}>${missing[3]}`;
  }
  const lead = line.match(/^(\s*)[lI|](\/?[A-Za-z_][\w.-]*[\s\S]*)$/);
  if (lead) {
    const name = lead[2].match(/^\/?([A-Za-z_][\w.-]*)/)?.[1];
    if (name && TAGS.has(confuse(name))) return `${lead[1]}<${lead[2]}`;
  }
  return line;
}

function repairTags(xml: string): string {
  let text = xml.replace(/<\s+/g, "<").replace(/<\/\s+/g, "</").replace(/\s+\/\s*>/g, "/>");
  text = text.replace(
    /<([A-Za-z_][\w.-]*)(\s[^<>]*?)?(\/?)>/g,
    (_full, name: string, rest: string | undefined, close: string) =>
      `<${canonical(name, TAGS)}${rest ?? ""}${close}>`,
  );
  text = text.replace(
    /<\/([A-Za-z_][\w.-]*)\s*>/g,
    (_full, name: string) => `</${canonical(name, TAGS)}>`,
  );
  text = text.replace(
    /<([A-Za-z_][\w.-]*)(\s[^<>]*?)(\/?)>/g,
    (_full, name: string, attrs: string, close: string) => {
      const fixedAttrs = attrs.replace(
        /(^|\s)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)(\s*=)/g,
        (_match, lead: string, attrName: string, eq: string) => {
          const fixed = attrName
            .split(":")
            .map((part) => canonical(part, ATTRIBUTES))
            .join(":");
          return `${lead}${fixed}${eq}`;
        },
      );
      return `<${name}${fixedAttrs}${close}>`;
    },
  );
  return text.split("\n").map(repairTagLine).join("\n");
}

function fixDottedVersions(text: string): string {
  return text.replace(
    /(?<![A-Za-z])([0-9OoIl|][0-9OoIl|]*(?:\.[0-9OoIl|]+)+)(?![A-Za-z])/g,
    (token) => {
      if (!/[OoIl|]/.test(token)) return token;
      return token.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1");
    },
  );
}

function fixVersionValue(value: string): string {
  const dotted = fixDottedVersions(value);
  if (/^[0-9OoIl|.+\-]+$/.test(dotted) && /[OoIl|]/.test(dotted)) {
    return dotted.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1");
  }
  return dotted;
}

function fixVersions(xml: string): string {
  let text = xml.replace(
    /<(version|modelVersion|[\w.-]*\.version)>([^<]*)<\/\1>/gi,
    (full, tag: string, value: string) => {
      const fixed = fixVersionValue(value);
      return fixed === value ? full : `<${tag}>${fixed}</${tag}>`;
    },
  );
  text = text.replace(
    /(\bversion\s*=\s*)(["'])([^"']*)(\2)/gi,
    (full, lead: string, quote: string, value: string, end: string) => {
      const fixed = fixVersionValue(value);
      return fixed === value ? full : `${lead}${quote}${fixed}${end}`;
    },
  );
  return fixDottedVersions(text);
}

function fixCoordinateTokens(text: string): string {
  return text.replace(/(^|[^A-Za-z0-9])0rg(?=[./\s<]|$)/g, "$1org").replace(/(^|[^A-Za-z0-9])c0m(?=[./\s<]|$)/g, "$1com");
}

function ensureXsi(xml: string): string {
  if (!/\bxsi:/.test(xml) || /xmlns:xsi\s*=/.test(xml)) return xml;
  return xml.replace(
    /<project\b([^>]*)>/,
    (_full, attrs: string) => `<project${attrs} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
  );
}

function repairXml(text: string): string {
  const normalized = unescapeDominantEntities(normalizePunctuation(text.replace(/<\? /g, "<?").replace(/ \?>/g, "?>")));
  return ensureXsi(fixCoordinateTokens(fixVersions(repairTags(normalized))));
}

function preparePart(part: string): string {
  const normalized = unescapeDominantEntities(
    normalizePunctuation(part.replace(/\r\n/g, "\n").replace(/\r/g, "\n")),
  );
  return dropEditorChrome(stripEditorLineNumbers(normalized)).replace(/[ \t]+$/gm, "").trim();
}

export function cleanupOcrParts(parts: string[]): string {
  const cleaned = parts.map(preparePart).filter((part) => part.length > 0);
  if (cleaned.length === 0) return "";
  return repairXml(cleaned.join("\n"));
}

export function cleanupOcrText(raw: string): string {
  return cleanupOcrParts([raw]);
}
