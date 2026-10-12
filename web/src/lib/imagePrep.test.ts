import { describe, expect, it } from "vitest";
import { prepareRgba } from "./imagePrep";

function fill(width: number, height: number, rgba: [number, number, number, number]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = rgba[0];
    pixels[index + 1] = rgba[1];
    pixels[index + 2] = rgba[2];
    pixels[index + 3] = rgba[3];
  }
  return pixels;
}

describe("prepareRgba", () => {
  it("inverts a dark editor screenshot and leaves a light one alone", () => {
    const dark = prepareRgba(fill(4, 4, [30, 30, 30, 255]), 4, 4);
    expect(dark.pixels[0]).toBe(225);
    const light = prepareRgba(fill(4, 4, [248, 248, 248, 255]), 4, 4);
    expect(light.pixels[0]).toBe(248);
  });

  it("scales a narrow photo up so glyphs are large enough to read", () => {
    const narrow = prepareRgba(fill(20, 10, [250, 250, 250, 255]), 20, 10);
    expect(narrow.width).toBe(40);
    expect(narrow.height).toBe(20);
  });
});
