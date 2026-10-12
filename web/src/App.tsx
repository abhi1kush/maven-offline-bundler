import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import { formatOcrProgress, recognizePomImages } from "./lib/ocr";
import { imagesFromClipboard, imagesFromFileList } from "./lib/pomImages";
import { validatePom, type PomProblem } from "./lib/pom";

type ManualIssue = {
  url: string;
  body: string;
  reason: "too-long" | "popup-blocked";
};

const MAX_IMAGES = 12;

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

function lineOffset(source: string, line: number): number {
  const lines = source.split("\n");
  let offset = 0;
  for (let index = 0; index < line - 1 && index < lines.length; index += 1) {
    offset += lines[index].length + 1;
  }
  return offset;
}

export function App() {
  const fileId = useId();
  const imageId = useId();
  const pomRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLPreElement>(null);
  const ocrRun = useRef(0);
  const runOcrRef = useRef<(files: File[]) => Promise<void>>(async () => {});
  const [pom, setPom] = useState("");
  const [pomSource, setPomSource] = useState<"edit" | "ocr">("edit");
  const [manual, setManual] = useState<ManualIssue | null>(null);
  const [copied, setCopied] = useState(false);
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [releasesError, setReleasesError] = useState<string | null>(null);
  const [loadingReleases, setLoadingReleases] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState("");
  const [ocrError, setOcrError] = useState<string | null>(null);

  const validation = useMemo(() => validatePom(pom), [pom]);
  const prepared = useMemo(() => {
    if (!validation.ok) return null;
    const body = issueBody(pom);
    const title = issueTitle(validation.coordinates.gav);
    return { body, title, link: issueLink(title, body) };
  }, [pom, validation]);
  const problemByLine = useMemo(() => {
    const map = new Map<number, PomProblem>();
    if (validation.ok) return map;
    for (const problem of validation.problems) {
      if (problem.line && !map.has(problem.line)) map.set(problem.line, problem);
    }
    return map;
  }, [validation]);

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

  function updatePom(next: string, source: "edit" | "ocr" = "edit") {
    setPom(next);
    setPomSource(source);
    setManual(null);
    setCopied(false);
  }

  function focusProblem(problem: PomProblem, source = pom) {
    const area = pomRef.current;
    if (!area || !problem.line) return;
    const start = lineOffset(source, problem.line);
    const current = source.split("\n")[problem.line - 1] ?? "";
    area.focus();
    area.setSelectionRange(start, start + current.length);
  }

  async function runOcr(files: File[]) {
    const images = files.filter((file) => file.size <= 15_000_000);
    if (images.length === 0) {
      setOcrError("Those images are empty or larger than 15 MB.");
      return;
    }
    if (images.length > MAX_IMAGES) {
      setOcrError(`Use at most ${MAX_IMAGES} images. They are read from first to last.`);
      return;
    }
    const run = ocrRun.current + 1;
    ocrRun.current = run;
    setOcrRunning(true);
    setOcrError(null);
    setOcrProgress("Reading image · loading OCR engine 0%");
    try {
      const text = await recognizePomImages(images, (update) => {
        if (ocrRun.current === run) setOcrProgress(formatOcrProgress(update));
      });
      if (ocrRun.current !== run) return;
      if (!text.trim()) {
        setOcrError("No text found in those images.");
        return;
      }
      updatePom(text, "ocr");
      const next = validatePom(text);
      const problem = next.ok ? null : next.problems.find((item) => item.line);
      if (problem?.line) {
        requestAnimationFrame(() => focusProblem(problem, text));
      }
    } catch (error) {
      if (ocrRun.current !== run) return;
      const message = error instanceof Error ? error.message : "Could not read that image.";
      setOcrError(message);
    } finally {
      if (ocrRun.current === run) {
        setOcrRunning(false);
        setOcrProgress("");
      }
    }
  }
  runOcrRef.current = runOcr;

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const images = imagesFromClipboard(event.clipboardData);
      if (images.length === 0) return;
      event.preventDefault();
      void runOcrRef.current(images);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

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

  const pomLines = pom.split("\n");

  return (
    <div className="page">
      <header className="masthead">
        <div>
          <p className="eyebrow">Offline Maven</p>
          <h1>maven-offline-bundler</h1>
          <p className="lede">
            Paste a <code>pom.xml</code> or a screenshot of one. GitHub Actions resolves it from
            Maven Central and publishes a zip in <code>~/.m2/repository</code> layout. Carry that
            zip to a machine with no network and build with <code>mvn -o</code>.
          </p>
        </div>
        <a className="repo-link" href="https://github.com/abhi1kush/maven-offline-bundler">
          GitHub repo
        </a>
      </header>

      <main className="layout">
        <section
          className={`card${dragOver ? " drop-active" : ""}`}
          aria-labelledby="pom-heading"
          onDragEnter={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            const images = imagesFromFileList(event.dataTransfer.files);
            if (images.length > 0) {
              void runOcr(images);
              return;
            }
            const file = event.dataTransfer.files?.[0];
            if (file && (/\.xml$/i.test(file.name) || file.type.includes("xml"))) {
              onFile(file);
              return;
            }
            setOcrError("Drop a pom.xml or a PNG, JPG, or WebP screenshot.");
          }}
        >
          <h2 id="pom-heading">Project pom</h2>
          <p className="hint">
            The browser only checks that this is XML with a Maven <code>project</code>. Resolution
            runs in Actions, so no token and no Maven Central request leave this page. A screenshot
            is read in the browser. Several images are joined in the order you add them.
          </p>
          <label className="field-label" htmlFor="pom-xml">
            pom.xml
          </label>
          <div className="editor">
            <pre ref={backdropRef} className="editor-back" aria-hidden="true">
              {pom
                ? pomLines.map((line, index) => {
                    const problem = problemByLine.get(index + 1);
                    const column = problem?.column && problem.column > 0 ? problem.column - 1 : null;
                    const shown = line.length > 0 ? line : "\u00a0";
                    return (
                      <span key={index} className={problem ? "line bad" : "line"}>
                        {column !== null && column < shown.length ? (
                          <>
                            {shown.slice(0, column)}
                            <mark>{shown[column]}</mark>
                            {shown.slice(column + 1)}
                          </>
                        ) : (
                          shown
                        )}
                      </span>
                    );
                  })
                : null}
            </pre>
            <textarea
              id="pom-xml"
              ref={pomRef}
              className="editor-input"
              value={pom}
              spellCheck={false}
              placeholder={'<?xml version="1.0" encoding="UTF-8"?>\n<project>\n  ...\n</project>'}
              aria-invalid={pom.trim().length > 0 && !validation.ok}
              aria-describedby="pom-status"
              onScroll={() => {
                const area = pomRef.current;
                const backdrop = backdropRef.current;
                if (!area || !backdrop) return;
                backdrop.scrollTop = area.scrollTop;
                backdrop.scrollLeft = area.scrollLeft;
              }}
              onChange={(event) => updatePom(event.target.value)}
            />
          </div>
          <p
            id="pom-status"
            className={`status ${validation.ok ? (validation.warning ? "warn" : "ok") : pom.trim() ? "bad" : ""}`}
            role="status"
          >
            {validation.ok
              ? `Ready: ${validation.coordinates.gav}${validation.warning ? `. ${validation.warning}` : ""}`
              : validation.error}
          </p>
          {ocrRunning ? (
            <p className="status ocr-progress" role="status">
              {ocrProgress}
            </p>
          ) : null}
          {ocrError ? <p className="error-note">{ocrError}</p> : null}
          {pomSource === "ocr" && pom.trim() ? (
            <p className="hint ocr-note">
              {validation.ok
                ? "Read from the image. Correct anything that looks wrong, then choose Create bundle."
                : "Fix the highlighted lines, then choose Create bundle. Nothing is submitted automatically."}
            </p>
          ) : null}
          {!validation.ok && validation.problems.length > 0 ? (
            <ul className="problems">
              {validation.problems.map((problem) => (
                <li key={`${problem.line ?? "x"}-${problem.message}`}>
                  <button type="button" className="problem" onClick={() => focusProblem(problem)}>
                    {problem.line ? `Line ${problem.line}: ` : ""}
                    {problem.message}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {prepared?.link.tooLong ? (
            <p className="status warn" role="status">
              This pom makes a {prepared.link.length.toLocaleString()} character issue link, over
              the 7000 character limit. Create bundle will give you the body to paste.
            </p>
          ) : null}

          <div className="actions">
            <button className="primary" type="button" disabled={!validation.ok || ocrRunning} onClick={createBundle}>
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
            <label className={`secondary${ocrRunning ? " disabled" : ""}`} htmlFor={imageId}>
              Upload pom image
            </label>
            <input
              id={imageId}
              className="file-input"
              type="file"
              accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
              multiple
              disabled={ocrRunning}
              onChange={(event) => {
                const images = imagesFromFileList(event.target.files);
                event.target.value = "";
                if (images.length > 0) void runOcr(images);
              }}
            />
            <button className="ghost" type="button" onClick={() => updatePom(SPRING_BOOT_EXAMPLE)}>
              Spring Boot example
            </button>
            <button className="ghost" type="button" onClick={() => updatePom("")} disabled={!pom || ocrRunning}>
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
