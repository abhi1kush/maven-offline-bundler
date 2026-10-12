# maven-offline-bundler

Paste a Maven `pom.xml` in the browser and download a zip of everything that pom needs to build offline. The zip is a `~/.m2/repository` tree. On a machine with no network:

```sh
unzip maven-offline-bundle.zip -d ~/.m2/repository
mvn -o package
```

or

```sh
unzip maven-offline-bundle.zip -d /path/to/offline-repo
mvn -o -Dmaven.repo.local=/path/to/offline-repo package
```

Site: <https://abhi1kush.github.io/maven-offline-bundler/>

Browsers cannot call Maven Central (no CORS), and the page never sees a token. Resolution runs in GitHub Actions.

## Create a bundle

1. Open the site and paste a `pom.xml`, upload the file, give it a screenshot, or give it a QR code. PNG, JPG, and WebP images can be chosen from a file picker, dropped onto the page, or pasted from the clipboard. A screenshot is read with in-browser text recognition. A QR image is decoded in the browser. A long pom can be split across several QR codes in the `MOB1` format; they can be scanned in any order, and missing codes are listed. **Make QR** draws downloadable PNGs and a printable sheet for the current editor text. Where the browser allows it, **Scan camera** reads codes from the camera. Fix anything the page highlights, then continue. Nothing is submitted on its own.
2. Choose **Create bundle**. That opens a GitHub issue titled `Bundle: groupId:artifactId:version` with the `bundle-request` label. The body is the pom inside an `xml` fence.
3. If the prefilled URL would be longer than 7000 characters, the page shows the issue form (title and label only) and a button that copies the body.
4. Actions resolves the pom, uploads `maven-offline-bundle.zip` to a release tagged `bundle-<issue#>-<shortsha>`, comments with the download link and size, and closes the issue.

Recent releases are listed on the site from the public GitHub releases API.

## What the workflow runs

The workflow runs on issues that are opened or edited with the `bundle-request` label, or whose title starts with `Bundle:`. Adding the label to an older issue also starts a run.

In an empty project directory and a fresh local repository it runs:

- `mvn -B dependency:go-offline`
- `mvn -B dependency:resolve-plugins`
- `mvn -B package -DskipTests` with a stub `src/main/java` so the compiler, resources, surefire, jar, and (when declared) `spring-boot-maven-plugin` plugins are resolved

It then deletes `_remote.repositories` and `*.lastUpdated`, rebuilds the stub with `mvn -o package` using only that repository and an empty settings file, and publishes the zip only if that offline build succeeds. When the pom declares `spring-boot-maven-plugin`, the offline jar must contain `BOOT-INF/`. If resolution or the offline check fails, the workflow comments with the Maven error and a log tail and leaves the issue open.

The submitted pom is untrusted build input. The Maven process does not receive `GITHUB_TOKEN`.

## Develop the site

```sh
npm install
npm test
npm run dev
```

Sources live in `web/`. The dev server serves the app at `http://localhost:5173/maven-offline-bundler/`. `npm run build` writes `dist/`, which the Pages workflow publishes.
