// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SPRING_BOOT_EXAMPLE } from "../examplePom";
import { assembleQrTexts, encodePom, QR_PAYLOAD_CHARS } from "./qrFormat";

function largePom(): string {
  const dependencies = Array.from({ length: 60 }, (_, index) =>
    [
      "    <dependency>",
      "      <groupId>com.example</groupId>",
      `      <artifactId>library-${index}</artifactId>`,
      `      <version>1.${index}.0</version>`,
      "    </dependency>",
    ].join("\n"),
  ).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<project>",
    "  <modelVersion>4.0.0</modelVersion>",
    "  <groupId>com.example</groupId>",
    "  <artifactId>large-offline</artifactId>",
    "  <version>9.9.9</version>",
    "  <dependencies>",
    dependencies,
    "  </dependencies>",
    "</project>",
    "",
  ].join("\n");
}

function corruptPayload(part: string): string {
  const marker = part.lastIndexOf(":");
  const payload = part.slice(marker + 1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const next = alphabet[(alphabet.indexOf(payload[10] ?? "A") + 3) % alphabet.length];
  return `${part.slice(0, marker + 1)}${payload.slice(0, 10)}${next}${payload.slice(11)}`;
}

describe("qr format", () => {
  it("round-trips a small pom and keeps the checksum in every part", async () => {
    const bundle = await encodePom(SPRING_BOOT_EXAMPLE);
    expect(bundle.parts.length).toBeGreaterThan(0);
    expect(bundle.id).toHaveLength(8);
    expect(bundle.checksum).toHaveLength(64);
    for (const [index, part] of bundle.parts.entries()) {
      expect(part.startsWith(`MOB1:${bundle.id}:${index + 1}/${bundle.parts.length}:${bundle.checksum}:`)).toBe(true);
      const payload = part.split(":").at(-1) ?? "";
      expect(payload.length).toBeLessThanOrEqual(QR_PAYLOAD_CHARS);
    }
    const again = await encodePom(SPRING_BOOT_EXAMPLE);
    expect(again).toEqual(bundle);
    const assembled = await assembleQrTexts(bundle.parts);
    expect(assembled).toEqual({ status: "ready", pom: SPRING_BOOT_EXAMPLE });
  });

  it("round-trips a large pom from parts given in any order", async () => {
    const pom = largePom();
    const bundle = await encodePom(pom);
    expect(bundle.parts.length).toBeGreaterThan(2);
    const reversed = [...bundle.parts].reverse();
    const assembled = await assembleQrTexts(reversed);
    expect(assembled).toEqual({ status: "ready", pom });
  });

  it("reports a missing part and does not invent the pom", async () => {
    const bundle = await encodePom(largePom());
    const dropped = bundle.parts.filter((_, index) => index !== 1);
    const assembled = await assembleQrTexts(dropped);
    expect(assembled.status).toBe("incomplete");
    if (assembled.status !== "incomplete") return;
    expect(assembled.missing).toEqual([2]);
    expect(assembled.total).toBe(bundle.parts.length);
    expect(assembled.message).toContain("Missing part 2 of");
    expect(assembled.message).toContain("Nothing is submitted automatically.");
    expect("pom" in assembled).toBe(false);
  });

  it("rejects a corrupted part", async () => {
    const bundle = await encodePom(SPRING_BOOT_EXAMPLE);
    const damaged = bundle.parts.map((part, index) => (index === 0 ? corruptPayload(part) : part));
    const assembled = await assembleQrTexts(damaged);
    expect(assembled.status).toBe("error");
    if (assembled.status !== "error") return;
    expect(assembled.message.length).toBeGreaterThan(0);
    expect(assembled.message).not.toContain(SPRING_BOOT_EXAMPLE);
  });

  it("rejects a checksum that does not belong to the payload", async () => {
    const bundle = await encodePom(SPRING_BOOT_EXAMPLE);
    const flipped = bundle.checksum.slice(0, -1) + (bundle.checksum.endsWith("0") ? "1" : "0");
    const forged = bundle.parts.map((part) => part.replace(bundle.checksum, flipped).replace(bundle.id, flipped.slice(0, 8)));
    const assembled = await assembleQrTexts(forged);
    expect(assembled).toMatchObject({ status: "error" });
  });

  it("reads a plain pom from a single QR text", async () => {
    const pom = "<project>\n  <artifactId>demo</artifactId>\n</project>";
    expect(await assembleQrTexts([pom, pom])).toEqual({ status: "ready", pom });
    expect(await assembleQrTexts(["https://example.test"])).toMatchObject({
      status: "error",
      message: "No pom was found in those QR codes.",
    });
  });

  it("rejects parts from two different poms", async () => {
    const first = await encodePom(SPRING_BOOT_EXAMPLE);
    const second = await encodePom(largePom());
    const assembled = await assembleQrTexts([first.parts[0], second.parts[0]]);
    expect(assembled).toEqual({ status: "error", message: "These QR codes belong to more than one pom." });
  });
});
