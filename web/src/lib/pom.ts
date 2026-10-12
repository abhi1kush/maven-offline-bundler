export type PomCoordinates = {
  groupId: string;
  artifactId: string;
  version: string;
  gav: string;
};

export type PomValidation =
  | { ok: true; coordinates: PomCoordinates; warning: string | null }
  | { ok: false; error: string };

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

export function validatePom(source: string): PomValidation {
  const xml = source.trim();
  if (!xml) {
    return { ok: false, error: "Paste a pom.xml or choose a file." };
  }

  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  if (!root || elementName(root) === "parsererror" || doc.querySelector("parsererror")) {
    return { ok: false, error: "This file is not valid XML." };
  }
  if (elementName(root) !== "project") {
    return { ok: false, error: "The root element must be <project>." };
  }

  const artifactId = directText(root, "artifactId");
  if (!artifactId) {
    return { ok: false, error: "The project needs an <artifactId>." };
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
    coordinates: {
      groupId,
      artifactId,
      version,
      gav: `${groupId}:${artifactId}:${version}`,
    },
  };
}
