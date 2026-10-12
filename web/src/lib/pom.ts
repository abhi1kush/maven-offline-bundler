export type PomCoordinates = {
  groupId: string;
  artifactId: string;
  version: string;
  gav: string;
};

export type PomProblem = {
  message: string;
  line: number | null;
  column: number | null;
};

export type PomValidation =
  | { ok: true; coordinates: PomCoordinates; warning: string | null; problems: PomProblem[] }
  | { ok: false; error: string; problems: PomProblem[] };

export type PomDependency = {
  groupId: string;
  artifactId: string;
  version: string;
};

export type PomIdentity = {
  groupId: string;
  artifactId: string;
  version: string;
  parent: PomDependency | null;
  dependencies: PomDependency[];
  plugins: PomDependency[];
  properties: Record<string, string>;
};

function elementName(element: Element): string {
  return (element.localName || element.tagName).toLowerCase();
}

function elementChildren(parent: Element): Element[] {
  const fromChildren = Array.from(parent.children ?? []);
  if (fromChildren.length > 0) return fromChildren;
  const elements: Element[] = [];
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) elements.push(node as Element);
  }
  return elements;
}

function directChild(parent: Element, name: string): Element | null {
  const wanted = name.toLowerCase();
  for (const child of elementChildren(parent)) {
    if (elementName(child) === wanted) return child;
  }
  return null;
}

function directText(parent: Element, name: string): string {
  return directChild(parent, name)?.textContent?.trim() ?? "";
}

function lineOf(source: string, pattern: RegExp): number | null {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) return index + 1;
  }
  return null;
}

function xmlProblem(doc: Document): PomProblem | null {
  const error = doc.querySelector("parsererror");
  if (!error) return null;
  const raw = (error.textContent ?? "").replace(/\s+/g, " ").trim();
  const location =
    raw.match(/line\s+(\d+)(?:\s+at\s+column\s+(\d+))?/i) ?? raw.match(/(?:^|\s)(\d+):(\d+)\b/);
  const detail = raw.match(/error on line[^:]*:\s*(.+?)(?:\s+Below is a rendering|$)/i)?.[1]?.trim();
  return {
    message: detail ? `This file is not valid XML. ${detail}` : "This file is not valid XML.",
    line: location ? Number(location[1]) : null,
    column: location?.[2] ? Number(location[2]) : null,
  };
}

export function validatePom(source: string): PomValidation {
  const xml = source.trim();
  if (!xml) {
    return {
      ok: false,
      error: "Paste a pom.xml, upload a file, or drop a screenshot.",
      problems: [],
    };
  }

  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  const parsed = xmlProblem(doc);
  if (!root || elementName(root) === "parsererror" || parsed) {
    const problem = parsed ?? { message: "This file is not valid XML.", line: null, column: null };
    return { ok: false, error: problem.message, problems: [problem] };
  }
  if (elementName(root) !== "project") {
    const problem = {
      message: "The root element must be <project>.",
      line: lineOf(source, /<\s*\/?\s*[^!\s>/?-]/),
      column: null,
    };
    return { ok: false, error: problem.message, problems: [problem] };
  }

  const artifactId = directText(root, "artifactId");
  if (!artifactId) {
    const problem = {
      message: "The project needs an <artifactId>.",
      line: lineOf(source, /<\s*project\b/i),
      column: null,
    };
    return { ok: false, error: problem.message, problems: [problem] };
  }

  const parent = directChild(root, "parent");
  const groupId =
    directText(root, "groupId") || (parent ? directText(parent, "groupId") : "") || "unknown";
  const version =
    directText(root, "version") || (parent ? directText(parent, "version") : "") || "unknown";
  const warning = directText(root, "modelVersion")
    ? null
    : "No <modelVersion>. Maven projects usually set it to 4.0.0.";

  return {
    ok: true,
    warning,
    problems: [],
    coordinates: {
      groupId,
      artifactId,
      version,
      gav: `${groupId}:${artifactId}:${version}`,
    },
  };
}

function coordinateOf(element: Element | null): PomDependency | null {
  if (!element) return null;
  return {
    groupId: directText(element, "groupId"),
    artifactId: directText(element, "artifactId"),
    version: directText(element, "version"),
  };
}

export function pomIdentity(source: string): PomIdentity | null {
  const validation = validatePom(source);
  if (!validation.ok) return null;
  const doc = new DOMParser().parseFromString(source.trim(), "application/xml");
  const root = doc.documentElement;
  const parent = coordinateOf(directChild(root, "parent"));
  const dependencies = elementChildren(directChild(root, "dependencies") ?? root)
    .filter((element) => element.parentElement && elementName(element.parentElement) === "dependencies")
    .filter((element) => elementName(element) === "dependency")
    .map((element) => coordinateOf(element))
    .filter((item): item is PomDependency => item !== null);
  const pluginsParent = directChild(directChild(root, "build") ?? root, "plugins");
  const plugins = elementChildren(pluginsParent ?? root)
    .filter((element) => element.parentElement && elementName(element.parentElement) === "plugins")
    .filter((element) => elementName(element) === "plugin")
    .map((element) => coordinateOf(element))
    .filter((item): item is PomDependency => item !== null);
  const properties: Record<string, string> = {};
  const propertiesElement = directChild(root, "properties");
  if (propertiesElement) {
    for (const child of elementChildren(propertiesElement)) {
      properties[elementName(child)] = child.textContent?.trim() ?? "";
    }
  }
  return {
    groupId: validation.coordinates.groupId,
    artifactId: validation.coordinates.artifactId,
    version: validation.coordinates.version,
    parent,
    dependencies,
    plugins,
    properties,
  };
}
