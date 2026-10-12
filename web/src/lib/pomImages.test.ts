import { describe, expect, it } from "vitest";
import { imagesFromClipboard, imagesFromFileList, isPomImage } from "./pomImages";

function file(name: string, type: string): File {
  return new File(["x"], name, { type });
}

describe("pom image selection", () => {
  it("accepts png, jpg, and webp and keeps the given order", () => {
    expect(isPomImage(file("pom.png", "image/png"))).toBe(true);
    expect(isPomImage(file("pom.jpg", "image/jpeg"))).toBe(true);
    expect(isPomImage(file("pom.webp", ""))).toBe(true);
    expect(isPomImage(file("pom.xml", "text/xml"))).toBe(false);
    const files = [file("b.png", "image/png"), file("notes.txt", "text/plain"), file("a.webp", "image/webp")];
    expect(imagesFromFileList(files).map((item) => item.name)).toEqual(["b.png", "a.webp"]);
  });

  it("reads clipboard images in item order", () => {
    const first = file("one.jpg", "image/jpeg");
    const second = file("two.png", "image/png");
    const data = {
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => second },
        { kind: "file", getAsFile: () => first },
      ],
      files: [first],
    } as unknown as DataTransfer;
    expect(imagesFromClipboard(data).map((item) => item.name)).toEqual(["two.png", "one.jpg"]);
  });
});
