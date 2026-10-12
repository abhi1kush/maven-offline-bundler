export const QR_PAYLOAD_CHARS = 220;
export const QR_MAX_PARTS = 99;

export const QR_RENDER_OPTIONS = {
  errorCorrectionLevel: "H" as const,
  margin: 4,
  width: 640,
};

export const QR_READER_OPTIONS = {
  formats: ["QRCode"] as ["QRCode"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDenoise: true,
  textMode: "Plain" as const,
  maxNumberOfSymbols: 48,
};

const PART_PATTERN = /^MOB1:([0-9a-f]{8}):([1-9]\d{0,1})\/([1-9]\d{0,1}):([0-9a-f]{64}):([A-Za-z0-9_-]+)$/;

export type QrBundle = {
  id: string;
  checksum: string;
  parts: string[];
};

export type QrAssembly =
  | { status: "ready"; pom: string }
  | {
      status: "incomplete";
      id: string;
      have: number[];
      missing: number[];
      total: number;
      message: string;
    }
  | { status: "error"; message: string };

type Part = {
  id: string;
  index: number;
  total: number;
  checksum: string;
  payload: string;
};

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concatBytes(chunks);
}

function bufferCopy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

async function transformBytes(stream: CompressionStream | DecompressionStream, bytes: Uint8Array): Promise<Uint8Array> {
  let readError: unknown;
  const reading = readStream(stream.readable).catch((error: unknown) => {
    readError = error;
    return new Uint8Array();
  });
  const writer = stream.writable.getWriter();
  try {
    await writer.write(bufferCopy(bytes));
    await writer.close();
  } catch (error) {
    await reading;
    await writer.abort().catch(() => undefined);
    throw error;
  }
  const value = await reading;
  if (readError) throw readError;
  return value;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return transformBytes(new CompressionStream("deflate-raw"), bytes);
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return transformBytes(new DecompressionStream("deflate-raw"), bytes);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const width = 0x8000;
  for (let index = 0; index < bytes.length; index += width) {
    binary += String.fromCharCode(...bytes.subarray(index, index + width));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string): Uint8Array {
  if (value.length % 4 === 1) throw new Error("bad-base64");
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function encodePom(pom: string): Promise<QrBundle> {
  if (!pom) throw new Error("There is no pom to encode.");
  const bytes = new TextEncoder().encode(pom);
  const checksum = await sha256Hex(bytes);
  const id = checksum.slice(0, 8);
  const payload = toBase64Url(await deflateRaw(bytes));
  const count = Math.max(1, Math.ceil(payload.length / QR_PAYLOAD_CHARS));
  if (count > QR_MAX_PARTS) throw new Error("This pom is too large to split into QR codes.");
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const slice = payload.slice(index * QR_PAYLOAD_CHARS, (index + 1) * QR_PAYLOAD_CHARS);
    parts.push(`MOB1:${id}:${index + 1}/${count}:${checksum}:${slice}`);
  }
  return { id, checksum, parts };
}

function parsePiece(text: string): { kind: "part"; part: Part } | { kind: "plain"; pom: string } | { kind: "bad" } | { kind: "foreign" } {
  const trimmed = text.trim();
  if (trimmed.startsWith("MOB1:")) {
    const match = PART_PATTERN.exec(trimmed);
    if (!match) return { kind: "bad" };
    const part: Part = {
      id: match[1],
      index: Number(match[2]),
      total: Number(match[3]),
      checksum: match[4],
      payload: match[5],
    };
    if (part.index > part.total || part.total > QR_MAX_PARTS || part.id !== part.checksum.slice(0, 8)) {
      return { kind: "bad" };
    }
    return { kind: "part", part };
  }
  if (trimmed.includes("<project")) return { kind: "plain", pom: trimmed };
  return { kind: "foreign" };
}

function missingMessage(missing: number[], total: number): string {
  const rendered = missing.join(", ").replace(/, ([^,]+)$/, " and $1");
  const noun = missing.length === 1 ? "part" : "parts";
  return `Got some of the QR codes. Missing ${noun} ${rendered} of ${total}. Add those codes. Nothing is submitted automatically.`;
}

export async function assembleQrTexts(texts: string[]): Promise<QrAssembly> {
  const parts: Part[] = [];
  const plains: string[] = [];
  let sawForeign = false;
  for (const text of texts) {
    const piece = parsePiece(text);
    if (piece.kind === "bad") return { status: "error", message: "A QR code does not match the MOB1 format." };
    if (piece.kind === "plain") plains.push(piece.pom);
    else if (piece.kind === "part") parts.push(piece.part);
    else sawForeign = true;
  }

  if (plains.length > 0 && parts.length > 0) {
    return { status: "error", message: "These QR codes mix a full pom with multi-part codes." };
  }
  if (plains.length > 0) {
    const unique = [...new Set(plains)];
    if (unique.length > 1) return { status: "error", message: "These QR codes contain different poms." };
    return { status: "ready", pom: unique[0] };
  }
  if (parts.length === 0) {
    return {
      status: "error",
      message: sawForeign ? "No pom was found in those QR codes." : "No QR code was found.",
    };
  }

  const checksums = [...new Set(parts.map((part) => part.checksum))];
  if (checksums.length > 1) return { status: "error", message: "These QR codes belong to more than one pom." };
  const totals = [...new Set(parts.map((part) => part.total))];
  if (totals.length > 1) return { status: "error", message: "QR codes disagree on how many parts the pom has." };
  const total = totals[0];
  const checksum = checksums[0];
  const id = checksum.slice(0, 8);
  const byIndex = new Map<number, string>();
  for (const part of parts) {
    const existing = byIndex.get(part.index);
    if (existing !== undefined && existing !== part.payload) {
      return { status: "error", message: `QR part ${part.index} of ${total} conflicts with another scan of that part.` };
    }
    byIndex.set(part.index, part.payload);
  }

  const missing: number[] = [];
  for (let index = 1; index <= total; index += 1) {
    if (!byIndex.has(index)) missing.push(index);
  }
  const have = [...byIndex.keys()].sort((a, b) => a - b);
  if (missing.length > 0) {
    return { status: "incomplete", id, have, missing, total, message: missingMessage(missing, total) };
  }

  const payload = have.map((index) => byIndex.get(index) ?? "").join("");
  let inflated: Uint8Array;
  try {
    inflated = await inflateRaw(fromBase64Url(payload));
  } catch {
    return { status: "error", message: "A QR payload is damaged." };
  }
  let pom: string;
  try {
    pom = new TextDecoder("utf-8", { fatal: true }).decode(inflated);
  } catch {
    return { status: "error", message: "A QR payload is damaged." };
  }
  const actual = await sha256Hex(new TextEncoder().encode(pom));
  if (actual !== checksum) return { status: "error", message: "The QR checksum does not match the pom." };
  return { status: "ready", pom };
}
