// @vitest-environment node
import QRCode from "qrcode";
import { PNG } from "pngjs";
import { readBarcodes } from "zxing-wasm/reader";
import { describe, expect, it } from "vitest";
import { SPRING_BOOT_EXAMPLE } from "../examplePom";
import { assembleQrTexts, encodePom, QR_READER_OPTIONS, QR_RENDER_OPTIONS } from "./qrFormat";

async function render(part: string): Promise<PNG> {
  const png = await QRCode.toBuffer(part, { ...QR_RENDER_OPTIONS, type: "png" });
  return PNG.sync.read(png);
}

function write(image: PNG): Buffer {
  return PNG.sync.write(image);
}

function scale(source: PNG, factor: number): PNG {
  const width = Math.max(1, Math.round(source.width * factor));
  const height = Math.max(1, Math.round(source.height * factor));
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(source.width - 1, Math.floor(x / factor));
      const sy = Math.min(source.height - 1, Math.floor(y / factor));
      const from = (sy * source.width + sx) * 4;
      const to = (y * width + x) * 4;
      out.data[to] = source.data[from];
      out.data[to + 1] = source.data[from + 1];
      out.data[to + 2] = source.data[from + 2];
      out.data[to + 3] = 255;
    }
  }
  return out;
}

function rotate(source: PNG, degrees: number): PNG {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const width = source.width;
  const height = source.height;
  const nextWidth = Math.ceil(Math.abs(width * cosine) + Math.abs(height * sine));
  const nextHeight = Math.ceil(Math.abs(width * sine) + Math.abs(height * cosine));
  const out = new PNG({ width: nextWidth, height: nextHeight });
  out.data.fill(255);
  const cx = width / 2;
  const cy = height / 2;
  const ncx = nextWidth / 2;
  const ncy = nextHeight / 2;
  const sample = (x: number, y: number) => source.data[(y * width + x) * 4];
  for (let y = 0; y < nextHeight; y += 1) {
    for (let x = 0; x < nextWidth; x += 1) {
      const dx = x - ncx;
      const dy = y - ncy;
      const sx = dx * cosine + dy * sine + cx;
      const sy = -dx * sine + dy * cosine + cy;
      if (sx < 0 || sy < 0 || sx >= width - 1 || sy >= height - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const value =
        sample(x0, y0) * (1 - fx) * (1 - fy) +
        sample(x0 + 1, y0) * fx * (1 - fy) +
        sample(x0, y0 + 1) * (1 - fx) * fy +
        sample(x0 + 1, y0 + 1) * fx * fy;
      const to = (y * nextWidth + x) * 4;
      const gray = Math.round(value);
      out.data[to] = gray;
      out.data[to + 1] = gray;
      out.data[to + 2] = gray;
      out.data[to + 3] = 255;
    }
  }
  return out;
}

function noise(source: PNG, amount: number, seed = 17): PNG {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const out = new PNG({ width: source.width, height: source.height });
  for (let index = 0; index < source.data.length; index += 4) {
    const shifted = source.data[index] * 0.92 + 10 + (next() - 0.5) * amount;
    const gray = Math.max(0, Math.min(255, Math.round(shifted)));
    out.data[index] = gray;
    out.data[index + 1] = gray;
    out.data[index + 2] = gray;
    out.data[index + 3] = 255;
  }
  return out;
}

async function textsFrom(images: PNG[]): Promise<string[]> {
  const texts: string[] = [];
  for (const image of images) {
    const found = await readBarcodes(write(image), QR_READER_OPTIONS);
    texts.push(...found.map((code) => code.text));
  }
  return texts;
}

async function expectPom(images: PNG[], pom: string) {
  const assembled = await assembleQrTexts(await textsFrom(images));
  expect(assembled, JSON.stringify(assembled)).toEqual({ status: "ready", pom });
}

describe("qr png", () => {
  it("decodes generated codes, including scaled, rotated, and noisy copies", async () => {
    const bundle = await encodePom(SPRING_BOOT_EXAMPLE);
    const images = await Promise.all(bundle.parts.map((part) => render(part)));
    await expectPom(images, SPRING_BOOT_EXAMPLE);
    await expectPom(
      images.map((image) => scale(image, 0.8)),
      SPRING_BOOT_EXAMPLE,
    );
    await expectPom(
      images.map((image) => rotate(image, 8)),
      SPRING_BOOT_EXAMPLE,
    );
    await expectPom(
      images.map((image) => noise(rotate(scale(image, 0.85), 6), 28)),
      SPRING_BOOT_EXAMPLE,
    );
  });

  it("decodes a multi-part pom from noisy codes supplied out of order", async () => {
    const dependencies = Array.from({ length: 40 }, (_, index) => `<dependency><groupId>com.example</groupId><artifactId>m${index}</artifactId><version>1.0.${index}</version></dependency>`).join("");
    const pom = `<project><groupId>com.example</groupId><artifactId>wide</artifactId><version>1.0.0</version><dependencies>${dependencies}</dependencies></project>`;
    const bundle = await encodePom(pom);
    expect(bundle.parts.length).toBeGreaterThan(1);
    const images = await Promise.all(bundle.parts.map((part) => render(part)));
    const noisy = images.map((image) => noise(rotate(scale(image, 1.15), -7), 22, 99)).reverse();
    await expectPom(noisy, pom);
  });
});
