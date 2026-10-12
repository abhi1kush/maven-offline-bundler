import { useEffect, useId, useMemo, useState } from "react";
import { SPRING_BOOT_EXAMPLE } from "./examplePom";
import {
  fetchReleases,
  formatBytes,
  formatWhen,
  issueBody,
  issueLink,
  issueTitle,
  safeHttpsUrl,
  zipAsset,
  type Release,
} from "./lib/github";
import { validatePom } from "./lib/pom";

type ManualIssue = {
  url: string;
  body: string;
  reason: "too-long" | "popup-blocked";
};

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export function App() {
  const fileId = useId();
  const [pom, setPom] = useState("");
  const [manual, setManual] = useState<ManualIssue | null>(null);
  const [copied, setCopied] = useState(false);
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [releasesError, setReleasesError] = useState<string | null>(null);
  const [loadingReleases, setLoadingReleases] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const validation = useMemo(() => validatePom(pom), [pom]);
  const prepared = useMemo(() => {
    if (!validation.ok) return null;
    const body = issueBody(pom);
    const title = issueTitle(validation.coordinates.gav);
    return { body, title, link: issueLink(title, body) };
  }, [pom, validation]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingReleases(true);
    setReleasesError(null);
    fetchReleases(controller.signal)
      .then((items) => {
        setReleases(items);
        setLoadingReleases(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Could not load releases.";
        setReleasesError(message);
        setLoadingReleases(false);
      });
    return () => controller.abort();
  }, [reloadToken]);

  function updatePom(next: string) {
    setPom(next);
    setManual(null);
    setCopied(false);
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    file.text().then((text) => updatePom(text));
  }

  function createBundle() {
    if (!prepared) return;
    setCopied(false);
    if (prepared.link.tooLong) {
      setManual({ url: prepared.link.shortHref, body: prepared.body, reason: "too-long" });
      return;
    }
    const opened = window.open(prepared.link.href, "_blank", "noopener,noreferrer");
    if (!opened) {
      setManual({ url: prepared.link.href, body: prepared.body, reason: "popup-blocked" });
      return;
    }
    setManual(null);
  }

  return (
    <div className="page">
      <header className="masthead">
        <div>
          <p className="eyebrow">Offline Maven</p>
          <h1>maven-offline-bundler</h1>
          <p className="lede">
            Paste a <code>pom.xml</code>. GitHub Actions resolves it from Maven Central and
            publishes a zip in <code>~/.m2/repository</code> layout. Carry that zip to a machine
            with no network and build with <code>mvn -o</code>.
          </p>
        </div>
        <a className="repo-link" href="https://github.com/abhi1kush/maven-offline-bundler">
          GitHub repo
        </a>
      </header>

      <main className="layout">
        <section className="card" aria-labelledby="pom-heading">
          <h2 id="pom-heading">Project pom</h2>
          <p className="hint">
            The browser only checks that this is XML with a Maven <code>project</code>. Resolution
            runs in Actions, so no token and no Maven Central request leave this page.
          </p>
          <label className="field-label" htmlFor="pom-xml">
            pom.xml
          </label>
          <textarea
            id="pom-xml"
            value={pom}
            spellCheck={false}
            placeholder={'<?xml version="1.0" encoding="UTF-8"?>\n<project>\n  ...\n</project>'}
            aria-invalid={pom.trim().length > 0 && !validation.ok}
            onChange={(event) => updatePom(event.target.value)}
          />
          <p
            className={`status ${validation.ok ? (validation.warning ? "warn" : "ok") : pom.trim() ? "bad" : ""}`}
            role="status"
          >
            {validation.ok
              ? `Ready: ${validation.coordinates.gav}${validation.warning ? `. ${validation.warning}` : ""}`
              : validation.error}
          </p>
          {prepared?.link.tooLong ? (
            <p className="status warn" role="status">
              This pom makes a {prepared.link.length.toLocaleString()} character issue link, over
              the 7000 character limit. Create bundle will give you the body to paste.
            </p>
          ) : null}

          <div className="actions">
            <button className="primary" type="button" disabled={!validation.ok} onClick={createBundle}>
              Create bundle
            </button>
            <label className="secondary" htmlFor={fileId}>
              Upload pom.xml
            </label>
            <input
              id={fileId}
              className="file-input"
              type="file"
              accept=".xml,text/xml,application/xml"
              onChange={(event) => {
                onFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <button className="ghost" type="button" onClick={() => updatePom(SPRING_BOOT_EXAMPLE)}>
              Spring Boot example
            </button>
            <button className="ghost" type="button" onClick={() => updatePom("")} disabled={!pom}>
              Clear
            </button>
          </div>

          {manual ? (
            <div className="manual">
              <h3>
                {manual.reason === "too-long"
                  ? "Issue link is too long for this pom"
                  : "The issue tab did not open"}
              </h3>
              {manual.reason === "too-long" ? (
                <ol className="steps">
                  <li>Copy the issue body.</li>
                  <li>Open the issue form. The title and bundle-request label are already filled in.</li>
                  <li>Paste the body and submit.</li>
                </ol>
              ) : (
                <p>Use the link below if the browser blocked the new tab. The body is already in that URL.</p>
              )}
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  onClick={() => {
                    copyText(manual.body).then((ok) => setCopied(ok));
                  }}
                >
                  {copied ? "Copied" : "Copy issue body"}
                </button>
                <a className="secondary" href={manual.url} target="_blank" rel="noreferrer">
                  Open GitHub issue
                </a>
              </div>
              <label className="field-label" htmlFor="issue-body" style={{ marginTop: 12 }}>
                Issue body
              </label>
              <textarea id="issue-body" readOnly value={manual.body} />
            </div>
          ) : null}
        </section>

        <div className="side">
          <section className="card" aria-labelledby="offline-heading">
            <h2 id="offline-heading">Build offline</h2>
            <p className="hint">
              Actions comments on the issue with a release zip, then closes it. On the isolated
              machine:
            </p>
            <ol className="offline-steps">
              <li>
                Extract into the default local repository
                <pre className="command">{`unzip maven-offline-bundle.zip -d ~/.m2/repository
mvn -o package`}</pre>
              </li>
              <li>
                Or keep a separate repository
                <pre className="command">{`unzip maven-offline-bundle.zip -d /path/to/offline-repo
mvn -o -Dmaven.repo.local=/path/to/offline-repo package`}</pre>
              </li>
            </ol>
            <p className="hint" style={{ marginTop: 12, marginBottom: 0 }}>
              The zip root is the repository itself, plus a copy of your pom and
              README-offline.txt. Remote-tracking files that break <code>mvn -o</code> are removed.
            </p>
          </section>

          <section className="card" aria-labelledby="recent-heading">
            <div className="release-head">
              <h2 id="recent-heading">Recent bundles</h2>
              <button className="ghost" type="button" onClick={() => setReloadToken((value) => value + 1)}>
                Refresh
              </button>
            </div>
            <p className="hint">Public GitHub releases. No token is sent from the browser.</p>
            {loadingReleases ? <p className="loading">Loading recent bundles…</p> : null}
            {releasesError ? <p className="error-note">{releasesError}</p> : null}
            {!loadingReleases && !releasesError && releases && releases.length === 0 ? (
              <p className="empty">No bundles published yet. The first release will show up here.</p>
            ) : null}
            {releases && releases.length > 0 ? (
              <ul className="release-list">
                {releases.map((release) => {
                  const asset = zipAsset(release);
                  const download = asset ? safeHttpsUrl(asset.browser_download_url) : null;
                  const page = safeHttpsUrl(release.html_url);
                  return (
                    <li className="release" key={release.id}>
                      <div className="release-tag">{release.tag_name}</div>
                      <div className="release-name">{release.name || release.tag_name}</div>
                      <p className="release-meta">
                        {asset ? formatBytes(asset.size) : "No zip yet"}
                        {" · "}
                        {formatWhen(release.published_at)}
                      </p>
                      {download ? (
                        <a href={download}>Download zip</a>
                      ) : page ? (
                        <a href={page}>View release</a>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
        </div>
      </main>

      <footer className="footer">
        An issue titled <code>Bundle: groupId:artifactId:version</code> with the{" "}
        <code>bundle-request</code> label is enough. Actions runs{" "}
        <code>mvn dependency:go-offline</code> and a <code>mvn package -DskipTests</code> attempt
        so compiler, resources, surefire, jar, and Spring Boot plugins are in the zip.
      </footer>
    </div>
  );
}
