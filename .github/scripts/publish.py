#!/usr/bin/env python3
"""Publish a bundle release or comment on the issue when bundling fails."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def run(command: list[str], check: bool = True, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=check,
        text=True,
        input=input_text,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def gh(*args: str, check: bool = True, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    command = ["gh"]
    if repo:
        command.extend(["-R", repo])
    command.extend(args)
    return run(command, check=check, input_text=input_text)


def issue_number_from_event() -> int:
    event_path = os.environ.get("GITHUB_EVENT_PATH", "")
    if not event_path:
        return 0
    event = json.loads(Path(event_path).read_text(encoding="utf-8"))
    return int(event.get("issue", {}).get("number") or 0)


def fence(text: str) -> str:
    ticks = "```"
    while ticks in text:
        ticks += "`"
    return f"{ticks}text\n{text.rstrip()}\n{ticks}"


def status_line(label: str, ok: bool | None) -> str:
    if ok is None:
        return f"- `{label}`: not run"
    return f"- `{label}`: {'succeeded' if ok else 'failed'}"


def failure_comment(result: dict[str, object] | None, issue: int) -> str:
    if result is None:
        return (
            "Could not publish an offline bundle.\n\n"
            "The bundler failed before it could write a result. "
            "Check the Actions log for this issue.\n"
        )
    error = str(result.get("error") or "Maven failed while building the offline repository.")
    lines = [
        "Could not publish an offline bundle for this pom.",
        "",
        error,
        "",
        status_line("dependency:go-offline", result.get("go_offline_ok") if "go_offline_ok" in result else None),  # type: ignore[arg-type]
        status_line("dependency:resolve-plugins", result.get("resolve_plugins_ok") if "resolve_plugins_ok" in result else None),  # type: ignore[arg-type]
        status_line("package -DskipTests", result.get("package_ok") if "package_ok" in result else None),  # type: ignore[arg-type]
        status_line("offline mvn -o package", result.get("offline_ok") if "offline_ok" in result else None),  # type: ignore[arg-type]
        "",
        "The issue is still open. Edit the body so it contains the full pom inside a ```xml fence to try again.",
        "",
    ]
    tail = str(result.get("log_tail") or "").strip()
    if tail:
        lines.extend(["<details>", "<summary>Log tail</summary>", "", fence(tail), "", "</details>", ""])
    else:
        lines.append("No Maven log was captured.")
    if issue:
        lines.append(f"Issue #{issue}.")
    return "\n".join(lines)


def success_comment(result: dict[str, object], download_url: str, release_url: str) -> str:
    gav = result.get("gav") or "unknown"
    size = result.get("size") or "unknown"
    tag = result.get("tag") or ""
    package_note = (
        "`mvn package -DskipTests` succeeded while resolving."
        if result.get("package_ok")
        else "`mvn package -DskipTests` failed while resolving. The offline check below is the one that gates publication."
    )
    repackage_note = ""
    if result.get("repackage_ok") and "spring-boot" in str(gav):
        repackage_note = " The offline check included a Spring Boot repackage (the jar contains `BOOT-INF/`)."
    return "\n".join(
        [
            "Offline bundle is ready.",
            "",
            f"- Coordinates: `{gav}`",
            f"- Download: [maven-offline-bundle.zip]({download_url}) ({size})",
            f"- Release: [{tag}]({release_url})",
            f"- {package_note}",
            f"- Offline check: `mvn -o package` succeeded against only this repository and an empty settings file.{repackage_note}",
            "",
            "Extract into `~/.m2/repository`, or point Maven at the extracted directory:",
            "",
            "```sh",
            "unzip maven-offline-bundle.zip -d ~/.m2/repository",
            "mvn -o package",
            "```",
            "",
            "```sh",
            "unzip maven-offline-bundle.zip -d /path/to/offline-repo",
            "mvn -o -Dmaven.repo.local=/path/to/offline-repo package",
            "```",
            "",
            "The zip root is the repository layout plus `pom.xml` and `README-offline.txt`.",
            "",
        ]
    )


def publish(result: dict[str, object]) -> None:
    issue = int(result["issue"])
    tag = str(result["tag"])
    zip_path = Path(str(result["zip"]))
    gav = str(result.get("gav") or "bundle")
    sha = os.environ.get("GITHUB_SHA", "")
    notes = "\n".join(
        [
            f"Offline Maven repository for `{gav}`.",
            "",
            "Extract the zip and build with `mvn -o package`.",
            "See README-offline.txt inside the archive.",
            "",
            f"Issue #{issue}.",
        ]
    )
    gh("release", "delete", tag, "--yes", "--cleanup-tag", check=False)
    create = [
        "release",
        "create",
        tag,
        f"{zip_path}#maven-offline-bundle.zip",
        "--latest=false",
        "--title",
        f"Bundle: {gav}",
        "--notes",
        notes,
    ]
    if sha:
        create.extend(["--target", sha])
    created = gh(*create, check=False)
    if created.returncode != 0:
        raise RuntimeError(created.stdout.strip() or "gh release create failed")
    repo = os.environ.get("GITHUB_REPOSITORY", "abhi1kush/maven-offline-bundler")
    download_url = f"https://github.com/{repo}/releases/download/{tag}/maven-offline-bundle.zip"
    release_url = f"https://github.com/{repo}/releases/tag/{tag}"
    gh("issue", "comment", str(issue), "--body", success_comment(result, download_url, release_url))
    closed = gh("issue", "close", str(issue), "--reason", "completed", check=False)
    if closed.returncode != 0:
        print(closed.stdout)


def comment_failure(result: dict[str, object] | None) -> None:
    issue = int(result["issue"]) if result and result.get("issue") else issue_number_from_event()
    if not issue:
        print("no issue number available for the failure comment", file=sys.stderr)
        return
    gh("issue", "comment", str(issue), "--body", failure_comment(result, issue))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--result", required=True)
    parser.add_argument("--failure", action="store_true")
    args = parser.parse_args(argv)
    result_path = Path(args.result)
    result = json.loads(result_path.read_text(encoding="utf-8")) if result_path.exists() else None
    try:
        if args.failure or result is None or not result.get("ok"):
            comment_failure(result)
            return 0
        publish(result)
        return 0
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
