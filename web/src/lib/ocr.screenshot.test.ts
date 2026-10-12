// @vitest-environment node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import { PNG } from "pngjs";
import puppeteer, { type Page } from "puppeteer-core";

const dom = new JSDOM("<!doctype html><body></body>");
Object.assign(globalThis, { DOMParser: dom.window.DOMParser, Node: dom.window.Node });
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SPRING_BOOT_EXAMPLE } from "../examplePom";
import { prepareRgba } from "./imagePrep";
import { recognizeImageSources } from "./ocr";
import { pomIdentity, type PomIdentity } from "./pom";

const lines = SPRING_BOOT_EXAMPLE.trim().split("\n");
const outDir = path.resolve("web/src/lib/__screenshots__");

const themes = {
  light: { bg: "#ffffff", fg: "#24292f", gutter: "#8c959f", tab: "#f6f8fa", rule: "#d0d7de" },
  dark: { bg: "#1e1e1e", fg: "#d4d4d4", gutter: "#858585", tab: "#2d2d2d", rule: "#3c3c3c" },
} as const;

function editorHtml(theme: keyof typeof themes): string {
  const color = themes[theme];
  return `<!doctype html>
<html>
  <head>
    <style>
      html, body { margin: 0; background: ${color.bg}; }
      .editor {
        display: inline-block;
        min-width: 720px;
        background: ${color.bg};
        color: ${color.fg};
        border: 1px solid ${color.rule};
        font-family: "JetBrains Mono", "Cascadia Mono", "Liberation Mono", monospace;
        font-size: 20px;
        line-height: 1.45;
        font-variant-ligatures: none;
        font-feature-settings: "liga" 0, "calt" 0;
      }
      .tab {
        padding: 8px 16px;
        background: ${color.tab};
        border-bottom: 1px solid ${color.rule};
        font-size: 14px;
      }
      .rows { padding: 12px 20px 16px 0; }
      .row { display: flex; align-items: flex-start; }
      .gutter {
        width: 58px;
        flex: none;
        text-align: right;
        padding-right: 16px;
        color: ${color.gutter};
      }
      .code { white-space: pre; }
    </style>
  </head>
  <body><div class="editor"><div class="tab">pom.xml</div><div class="rows"></div></div></body>
</html>`;
}

async function shoot(
  page: Page,
  theme: keyof typeof themes,
  start: number,
  end: number,
  type: "png" | "jpeg",
): Promise<Buffer> {
  await page.setContent(editorHtml(theme), { waitUntil: "load" });
  const slice = lines.slice(start, end).map((code, index) => ({ n: start + index + 1, code }));
  await page.evaluate((rows) => {
    const root = document.querySelector(".rows");
    if (!root) throw new Error("missing editor");
    for (const rowData of rows) {
      const row = document.createElement("div");
      row.className = "row";
      const gutter = document.createElement("span");
      gutter.className = "gutter";
      gutter.textContent = String(rowData.n);
      const code = document.createElement("span");
      code.className = "code";
      code.textContent = rowData.code;
      row.append(gutter, code);
      root.append(row);
    }
  }, slice);
  await page.evaluate(() => document.fonts.ready);
  const editor = await page.$(".editor");
  if (!editor) throw new Error("missing editor");
  const image = await editor.screenshot({ type });
  return Buffer.from(image);
}

function preprocessPng(buffer: Buffer): Buffer {
  const png = PNG.sync.read(buffer);
  const prepared = prepareRgba(Uint8ClampedArray.from(png.data), png.width, png.height);
  const out = new PNG({ width: prepared.width, height: prepared.height });
  out.data = Buffer.from(prepared.pixels);
  return PNG.sync.write(out);
}

async function readPom(source: Buffer): Promise<string> {
  return recognizeImageSources([new Uint8Array(source)], undefined, {
    langPath: path.resolve("web/public/ocr"),
    gzip: true,
    cachePath: "/tmp/tess-cache",
  });
}

async function expectSamePom(source: Buffer, label: string): Promise<void> {
  const text = await readPom(source);
  const got = pomIdentity(text);
  const want = pomIdentity(SPRING_BOOT_EXAMPLE);
  expect(got, `${label}\n${text}`).toEqual(want);
  expect(want).not.toBeNull();
  const identity = got as PomIdentity;
  expect(identity.groupId).toBe("com.example");
  expect(identity.artifactId).toBe("hello-offline");
  expect(identity.version).toBe("0.0.1-SNAPSHOT");
  expect(identity.dependencies).toEqual(want?.dependencies);
}

describe("ocr screenshots of the Spring Boot example", () => {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  let page: Page;

  beforeAll(async () => {
    await mkdir(outDir, { recursive: true });
    browser = await puppeteer.launch({
      executablePath: "/usr/local/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 2 });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("reads a light editor screenshot with line numbers", async () => {
    const png = await shoot(page, "light", 0, lines.length, "png");
    await writeFile(path.join(outDir, "light.png"), png);
    await expectSamePom(preprocessPng(png), "light");
  });

  it("reads a dark editor screenshot with line numbers", async () => {
    const png = await shoot(page, "dark", 0, lines.length, "png");
    await writeFile(path.join(outDir, "dark.png"), png);
    await expectSamePom(preprocessPng(png), "dark");
  });

  it("reads a jpeg of the light editor", async () => {
    const jpeg = await shoot(page, "light", 0, lines.length, "jpeg");
    await writeFile(path.join(outDir, "light.jpg"), jpeg);
    await expectSamePom(jpeg, "jpeg");
  });

  it("reads the pom from two screenshots in order", async () => {
    const mid = 16;
    const top = preprocessPng(await shoot(page, "light", 0, mid, "png"));
    const bottom = preprocessPng(await shoot(page, "light", mid, lines.length, "png"));
    await writeFile(path.join(outDir, "light-top.png"), top);
    await writeFile(path.join(outDir, "light-bottom.png"), bottom);
    const text = await recognizeImageSources([new Uint8Array(top), new Uint8Array(bottom)], undefined, {
      langPath: path.resolve("web/public/ocr"),
      gzip: true,
      cachePath: "/tmp/tess-cache",
    });
    expect(pomIdentity(text), text).toEqual(pomIdentity(SPRING_BOOT_EXAMPLE));
  });
});
