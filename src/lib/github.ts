export const GITHUB_OWNER = "abhi1kush";
export const GITHUB_REPO = "maven-offline-bundler";
export const MAX_ISSUE_URL_LENGTH = 7000;

export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

export type Release = {
  id: number;
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  assets: ReleaseAsset[];
};

export type IssueLink = {
  href: string;
  shortHref: string;
  tooLong: boolean;
  length: number;
};

export function issueBody(pom: string): string {
  const trimmed = pom.trim();
  let fence = "```";
  while (trimmed.includes(fence)) {
    fence += "`";
  }
  return `${fence}xml\n${trimmed}\n${fence}\n`;
}

export function issueTitle(gav: string): string {
  return `Bundle: ${gav}`;
}

export function issueLink(title: string, body: string): IssueLink {
  const base = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/issues/new`;
  const shortHref = `${base}?title=${encodeURIComponent(title)}&labels=${encodeURIComponent("bundle-request")}`;
  const href = `${shortHref}&body=${encodeURIComponent(body)}`;
  return {
    href,
    shortHref,
    tooLong: href.length > MAX_ISSUE_URL_LENGTH,
    length: href.length,
  };
}

export async function fetchReleases(signal?: AbortSignal): Promise<Release[]> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=20`;
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub releases returned HTTP ${response.status}.`);
  }
  const data = (await response.json()) as Release[];
  return data
    .filter((release) => release.tag_name.startsWith("bundle-"))
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "Unpublished";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export function safeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (!ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function zipAsset(release: Release): ReleaseAsset | null {
  return (
    release.assets.find((asset) => asset.name.endsWith(".zip")) ??
    release.assets[0] ??
    null
  );
}
