#!/usr/bin/env python3
"""Resolve a Maven pom into a zip of a local repository for offline builds.

The zip uses ~/.m2/repository layout. _remote.repositories and *.lastUpdated
markers are removed. Before the zip is published, the same pom is rebuilt with
mvn -o against only that repository and an empty settings file.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import textwrap
import xml.etree.ElementTree as ET
from pathlib import Path

FENCE = re.compile(
    r"^[ \t]*(?P<fence>`{3,})(?P<lang>[^\n`]*)\n(?P<body>.*?)^[ \t]*(?P=fence)[ \t]*$",
    re.MULTILINE | re.DOTALL,
)

SPRING_STUB = textwrap.dedent(
    """\
    package app;

    import org.springframework.boot.SpringApplication;
    import org.springframework.boot.autoconfigure.SpringBootApplication;

    @SpringBootApplication
    public class Application {
        public static void main(String[] args) {
            SpringApplication.run(Application.class, args);
        }
    }
    """
)

PLAIN_STUB = textwrap.dedent(
    """\
    package app;

    public class Application {
        public static void main(String[] args) {
            System.out.println("ok");
        }
    }
    """
)

MVN_TIMEOUT_SECONDS = 25 * 60


def extract_pom(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    for match in FENCE.finditer(normalized):
        body = match.group("body").strip()
        if "<project" in body and "</project>" in body:
            return body
    project_at = normalized.find("<project")
    if project_at == -1:
        raise ValueError(
            "No <project> element found. Paste the full pom.xml inside a ```xml fence."
        )
    xml_at = normalized.rfind("<?xml", 0, project_at + 1)
    begin = xml_at if xml_at != -1 else project_at
    end = normalized.rfind("</project>")
    if end == -1:
        raise ValueError(
            "Found <project> but no closing </project> tag. Paste the complete pom.xml inside a ```xml fence."
        )
    return normalized[begin : end + len("</project>")].strip()


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def direct_text(element: ET.Element, name: str) -> str:
    for child in list(element):
        if local_name(child.tag) == name:
            return (child.text or "").strip()
    return ""


def coordinates(pom_text: str) -> str:
    try:
        root = ET.fromstring(pom_text)
    except ET.ParseError:
        return "unknown:unknown:unknown"
    if local_name(root.tag) != "project":
        return "unknown:unknown:unknown"
    parent = next((child for child in list(root) if local_name(child.tag) == "parent"), None)
    group = direct_text(root, "groupId") or (direct_text(parent, "groupId") if parent is not None else "") or "unknown"
    artifact = direct_text(root, "artifactId") or "unknown"
    version = direct_text(root, "version") or (direct_text(parent, "version") if parent is not None else "") or "unknown"
    return f"{group}:{artifact}:{version}"


def wants_spring_stub(pom_text: str) -> bool:
    return "org.springframework.boot" in pom_text and (
        "spring-boot-starter" in pom_text or "spring-boot-autoconfigure" in pom_text
    )


def expects_repackage(pom_text: str) -> bool:
    if "spring-boot-maven-plugin" not in pom_text:
        return False
    return "<skip>true</skip>" not in pom_text


def write_stub(project: Path, spring: bool) -> None:
    source = project / "src" / "main" / "java" / "app"
    if source.exists():
        shutil.rmtree(source)
    source.mkdir(parents=True)
    (source / "Application.java").write_text(SPRING_STUB if spring else PLAIN_STUB, encoding="utf-8")


def xml_escape(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def human_size(num_bytes: int) -> str:
    value = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            if unit == "B":
                return f"{int(value)} B"
            digits = 0 if value >= 10 else 1
            return f"{value:.{digits}f} {unit}"
        value /= 1024
    return f"{num_bytes} B"


def maven_env(home: Path) -> dict[str, str]:
    keys = ("PATH", "JAVA_HOME", "LANG", "LC_ALL", "TZ")
    env = {key: os.environ[key] for key in keys if os.environ.get(key)}
    env["HOME"] = str(home)
    env["LANG"] = env.get("LANG", "C.UTF-8")
    env["LC_ALL"] = env.get("LC_ALL", "C.UTF-8")
    env["MAVEN_OPTS"] = "-Xmx1536m"
    return env


def run_logged(command: list[str], cwd: Path, env: dict[str, str], log: Path, timeout: int) -> bool:
    with log.open("a", encoding="utf-8") as handle:
        handle.write("\n" + "=" * 72 + "\n")
        handle.write("$ " + " ".join(command) + "\n\n")
        handle.flush()
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=30)
            handle.write(f"\nTIMED OUT after {timeout} seconds\n")
            return False
    return code == 0


def run_mvn(mvn: str, goals: list[str], project: Path, repo: Path | None, settings: Path, env: dict[str, str], log: Path, offline: bool) -> bool:
    command = [mvn, "-B", "--no-transfer-progress", "-s", str(settings), "-gs", str(settings)]
    if offline:
        command.append("-o")
    if repo is not None:
        command.append(f"-Dmaven.repo.local={repo}")
    command.extend(["-f", str(project / "pom.xml"), *goals])
    ok = run_logged(command, project, env, log, MVN_TIMEOUT_SECONDS)
    if ok:
        return True
    with log.open("a", encoding="utf-8") as handle:
        handle.write("\n--- retrying command once ---\n")
    return run_logged(command, project, env, log, MVN_TIMEOUT_SECONDS)


def clean_markers(repo: Path) -> None:
    for path in repo.rglob("*"):
        if not path.is_file():
            continue
        name = path.name
        if name == "_remote.repositories" or name.endswith(".lastUpdated") or name.endswith(".part") or name.endswith(".part.lock"):
            path.unlink(missing_ok=True)
    locks = repo / ".locks"
    if locks.exists():
        shutil.rmtree(locks, ignore_errors=True)


def count_artifacts(repo: Path) -> int:
    return sum(1 for path in repo.rglob("*") if path.is_file() and path.suffix in {".jar", ".pom"})


def jar_has_boot_inf(project: Path) -> bool:
    target = project / "target"
    if not target.exists():
        return False
    import zipfile

    for jar in target.glob("*.jar"):
        if jar.name.endswith(".original") or jar.name.endswith("-sources.jar") or jar.name.endswith("-javadoc.jar"):
            continue
        try:
            with zipfile.ZipFile(jar) as archive:
                if any(name.startswith("BOOT-INF/") for name in archive.namelist()):
                    return True
        except zipfile.BadZipFile:
            continue
    return False


def log_tail(log: Path, lines: int = 120, limit: int = 12000) -> str:
    if not log.exists():
        return ""
    text = log.read_text(encoding="utf-8", errors="replace")
    chunk = "\n".join(text.splitlines()[-lines:])
    if len(chunk) > limit:
        chunk = chunk[-limit:]
    return chunk


def maven_errors(log: Path) -> list[str]:
    if not log.exists():
        return []
    ignored = ("To see the full stack trace", "Re-run Maven using", "For more information about the errors")
    found: list[str] = []
    for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
        if "[ERROR]" not in line:
            continue
        message = line.split("[ERROR]", 1)[-1].strip()
        if not message or message.startswith("[") or any(snippet in message for snippet in ignored):
            continue
        if message not in found:
            found.append(message)
    return found[-8:]


def summarize_failure(prefix: str, log: Path) -> str:
    errors = maven_errors(log)
    if not errors:
        return prefix
    specific = [
        err
        for err in errors
        if any(
            key in err
            for key in (
                "Non-parseable",
                "Could not find artifact",
                "Could not resolve",
                "Non-resolvable",
                "was not found",
                "Unresolved",
            )
        )
    ]
    chosen = specific[-4:] or errors[-4:]
    bullets = "\n".join(f"- {err}" for err in chosen)
    return f"{prefix}\n\n{bullets}"


def write_readme(repo: Path, gav: str, issue: int, sha: str, package_ok: bool) -> None:
    package_line = (
        "The bundling build completed mvn package -DskipTests."
        if package_ok
        else "mvn package -DskipTests did not succeed while bundling. The offline check that ran afterwards is described by the GitHub issue comment."
    )
    text = textwrap.dedent(
        f"""\
        Maven offline bundle
        ====================

        Coordinates: {gav}
        Issue: #{issue}
        Release tag: bundle-{issue}-{sha}

        This zip is a Maven local repository (~/.m2/repository layout).
        It also contains this file and a copy of the pom.xml that was requested.
        _remote.repositories and *.lastUpdated files were removed so Maven can
        use the cached artifacts in offline mode.

        {package_line}

        Option A — install into the default local repository
          unzip maven-offline-bundle.zip -d ~/.m2/repository
          cd your-project
          mvn -o package

        Option B — keep a separate repository
          unzip maven-offline-bundle.zip -d /path/to/offline-repo
          cd your-project
          mvn -o -Dmaven.repo.local=/path/to/offline-repo package

        Put the included pom.xml in the project directory and your sources under
        src/main/java. Only artifacts resolved for this pom are included.
        """
    )
    (repo / "README-offline.txt").write_text(text, encoding="utf-8")


def zip_directory(repo: Path, dest: Path) -> None:
    if dest.exists():
        dest.unlink()
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["zip", "-r", "-q", "-1", str(dest), "."], cwd=repo, check=True)


def zip_listing_problems(dest: Path) -> list[str]:
    listing = subprocess.check_output(["unzip", "-Z1", dest], text=True, errors="replace")
    names = listing.splitlines()
    problems: list[str] = []
    if not any(name == "pom.xml" for name in names):
        problems.append("pom.xml is missing from the zip")
    if not any(name == "README-offline.txt" for name in names):
        problems.append("README-offline.txt is missing from the zip")
    leaked = [name for name in names if name.endswith("_remote.repositories") or name.endswith(".lastUpdated")]
    if leaked:
        problems.append(f"tracking files still present ({len(leaked)})")
    return problems


def write_settings(path: Path, repo: Path) -> None:
    path.write_text(
        "\n".join(
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0">',
                "  <interactiveMode>false</interactiveMode>",
                f"  <localRepository>{xml_escape(str(repo))}</localRepository>",
                "  <mirrors>",
                "    <mirror>",
                "      <id>maven-default-http-blocker</id>",
                "      <mirrorOf>external:http:*</mirrorOf>",
                "      <name>Block HTTP repositories</name>",
                "      <url>http://0.0.0.0/</url>",
                "      <blocked>true</blocked>",
                "    </mirror>",
                "  </mirrors>",
                "</settings>",
                "",
            ]
        ),
        encoding="utf-8",
    )


def empty_settings(path: Path) -> None:
    path.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0">\n'
        "  <interactiveMode>false</interactiveMode>\n"
        "</settings>\n",
        encoding="utf-8",
    )


def load_inputs(args: argparse.Namespace) -> tuple[int, str]:
    if args.pom:
        pom = Path(args.pom).read_text(encoding="utf-8")
        if args.issue is None:
            raise ValueError("--issue is required with --pom")
        return args.issue, pom
    if not args.event:
        raise ValueError("Pass --event or --pom")
    event = json.loads(Path(args.event).read_text(encoding="utf-8"))
    issue = event["issue"]
    return int(issue["number"]), extract_pom(issue.get("body") or "")


def result_payload(**kwargs: object) -> dict[str, object]:
    return kwargs


def write_result(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def build(args: argparse.Namespace) -> dict[str, object]:
    log = Path(args.log)
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text("", encoding="utf-8")
    issue = 0
    sha = args.sha
    gav = "unknown:unknown:unknown"
    try:
        issue, pom_text = load_inputs(args)
        gav = coordinates(pom_text)
        if len(pom_text) > 1_000_000:
            raise ValueError("The pom is larger than 1 MB. Refusing to resolve it.")
        with log.open("a", encoding="utf-8") as handle:
            handle.write(f"issue={issue} sha={sha} gav={gav}\n")
    except Exception as exc:  # noqa: BLE001 - reported to the GitHub issue
        return {
            "ok": False,
            "issue": issue or args.issue or 0,
            "sha": sha,
            "tag": "",
            "gav": gav,
            "zip": "",
            "bytes": 0,
            "size": "0 B",
            "go_offline_ok": False,
            "resolve_plugins_ok": False,
            "package_ok": False,
            "offline_ok": False,
            "repackage_ok": False,
            "artifact_files": 0,
            "error": str(exc),
            "log_tail": log_tail(log),
        }

    work = Path(args.work) if args.work else Path(os.environ.get("RUNNER_TEMP", "/tmp")) / f"bundle-{issue}-{sha}"
    if work.exists():
        shutil.rmtree(work)
    project = work / "project"
    repo = work / "repository"
    home = work / "home"
    check_repo = work / "repository-check"
    project.mkdir(parents=True)
    repo.mkdir()
    home.mkdir()
    (project / "pom.xml").write_text(pom_text if pom_text.endswith("\n") else pom_text + "\n", encoding="utf-8")
    spring = wants_spring_stub(pom_text)
    write_stub(project, spring)
    online_settings = work / "online-settings.xml"
    offline_settings = work / "empty-settings.xml"
    write_settings(online_settings, repo)
    empty_settings(offline_settings)
    env = maven_env(home)
    mvn = args.mvn

    with log.open("a", encoding="utf-8") as handle:
        handle.write("\n")
    run_logged([mvn, "-version"], project, env, log, 120)

    go_offline_ok = run_mvn(
        mvn,
        ["dependency:go-offline"],
        project,
        repo,
        online_settings,
        env,
        log,
        offline=False,
    )
    resolve_plugins_ok = run_mvn(
        mvn,
        ["dependency:resolve-plugins"],
        project,
        repo,
        online_settings,
        env,
        log,
        offline=False,
    )
    package_ok = run_mvn(
        mvn,
        ["package", "-DskipTests"],
        project,
        repo,
        online_settings,
        env,
        log,
        offline=False,
    )
    if not package_ok and spring:
        with log.open("a", encoding="utf-8") as handle:
            handle.write("\nSpring stub did not package. Retrying with a plain Java main.\n")
        write_stub(project, spring=False)
        package_ok = run_mvn(
            mvn,
            ["package", "-DskipTests"],
            project,
            repo,
            online_settings,
            env,
            log,
            offline=False,
        )
        spring = False

    clean_markers(repo)
    artifact_files = count_artifacts(repo)
    offline_ok = False
    repackage_ok = False
    error = ""
    (repo / "pom.xml").write_text(pom_text if pom_text.endswith("\n") else pom_text + "\n", encoding="utf-8")
    write_readme(repo, gav, issue, sha, package_ok)

    if artifact_files < 10 or not (go_offline_ok or package_ok):
        error = summarize_failure(
            "Maven could not resolve this pom, so no bundle was published.",
            log,
        )
    else:
        if check_repo.exists():
            shutil.rmtree(check_repo)
        shutil.copytree(repo, check_repo, symlinks=True)
        target = project / "target"
        if target.exists():
            shutil.rmtree(target)
        offline_ok = run_mvn(
            mvn,
            ["package"],
            project,
            check_repo,
            offline_settings,
            env,
            log,
            offline=True,
        )
        repackage_ok = jar_has_boot_inf(project) if expects_repackage(pom_text) else True
        if not offline_ok or not repackage_ok:
            reason = "Offline mvn -o package failed for a generated stub project, so no bundle was published."
            if offline_ok and not repackage_ok:
                reason = (
                    "Offline mvn -o package finished, but spring-boot-maven-plugin did not repackage "
                    "the jar (BOOT-INF is missing), so no bundle was published."
                )
            error = summarize_failure(reason, log)

    tag = f"bundle-{issue}-{sha}"
    zip_path = Path(args.out)
    size_bytes = 0
    if not error:
        try:
            zip_directory(repo, zip_path)
            problems = zip_listing_problems(zip_path)
            if problems:
                error = "Refusing to publish the zip: " + "; ".join(problems)
            else:
                size_bytes = zip_path.stat().st_size
        except subprocess.CalledProcessError as exc:
            error = f"Could not zip the local repository (exit {exc.returncode})."

    ok = not error
    return {
        "ok": ok,
        "issue": issue,
        "sha": sha,
        "tag": tag if ok else "",
        "gav": gav,
        "zip": str(zip_path) if ok else "",
        "bytes": size_bytes,
        "size": human_size(size_bytes),
        "go_offline_ok": go_offline_ok,
        "resolve_plugins_ok": resolve_plugins_ok,
        "package_ok": package_ok,
        "offline_ok": offline_ok,
        "repackage_ok": repackage_ok,
        "artifact_files": artifact_files,
        "error": error,
        "log_tail": "" if ok else log_tail(log),
    }


def self_check_extract() -> None:
    fenced = "Please bundle this:\n\n```xml\n<project>\n  <artifactId>demo</artifactId>\n</project>\n```\n"
    assert "<artifactId>demo</artifactId>" in extract_pom(fenced)
    nested = "````xml\n```\nnot pom\n```\n<project></project>\n````\n"
    assert extract_pom(nested).strip() == "```\nnot pom\n```\n<project></project>"
    raw = "note\n<?xml version=\"1.0\"?>\n<project><artifactId>a</artifactId></project>\nthanks\n"
    extracted = extract_pom(raw)
    assert extracted.startswith("<?xml") and extracted.endswith("</project>")
    try:
        extract_pom("no pom here")
    except ValueError as exc:
        assert "<project>" in str(exc)
    else:
        raise AssertionError("expected ValueError")
    assert coordinates("<project><groupId>g</groupId><artifactId>a</artifactId><version>1</version></project>") == "g:a:1"
    parent = (
        "<project><parent><groupId>org.springframework.boot</groupId>"
        "<artifactId>spring-boot-starter-parent</artifactId><version>3.3.13</version></parent>"
        "<artifactId>demo</artifactId><version>0.1</version></project>"
    )
    assert coordinates(parent) == "org.springframework.boot:demo:0.1"
    print("extract self-check ok")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build an offline Maven repository zip from a pom.")
    parser.add_argument("--event", help="Path to the GitHub event payload")
    parser.add_argument("--pom", help="Path to a pom.xml (local test)")
    parser.add_argument("--issue", type=int, help="Issue number when using --pom")
    parser.add_argument("--sha", help="Short commit sha used in the release tag")
    parser.add_argument("--out", help="Zip path to write")
    parser.add_argument("--result", help="Result JSON path")
    parser.add_argument("--log", help="Maven log path")
    parser.add_argument("--work", help="Working directory (default: a temp dir)")
    parser.add_argument("--mvn", default="mvn", help="Maven executable")
    parser.add_argument("--self-check-extract", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.self_check_extract:
        self_check_extract()
        return 0
    missing = [name for name in ("sha", "out", "result", "log") if not getattr(args, name)]
    if missing:
        print("missing arguments: " + ", ".join(missing), file=sys.stderr)
        return 2
    try:
        payload = build(args)
    except Exception as exc:  # noqa: BLE001 - always leave a result file for the issue comment
        log = Path(args.log)
        payload = {
            "ok": False,
            "issue": args.issue or 0,
            "sha": args.sha,
            "tag": "",
            "gav": "unknown:unknown:unknown",
            "zip": "",
            "bytes": 0,
            "size": "0 B",
            "go_offline_ok": False,
            "resolve_plugins_ok": False,
            "package_ok": False,
            "offline_ok": False,
            "repackage_ok": False,
            "artifact_files": 0,
            "error": f"The bundler crashed: {exc}",
            "log_tail": log_tail(log) if log.exists() else "",
        }
    write_result(Path(args.result), payload)
    if payload["ok"]:
        print(f"bundle ok {payload['gav']} {payload['size']} -> {payload['zip']}")
        return 0
    print(payload["error"], file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
