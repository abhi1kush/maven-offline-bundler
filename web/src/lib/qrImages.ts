import { QR_READER_OPTIONS, QR_RENDER_OPTIONS } from "./qrFormat";

type QrCodeModule = {
  toDataURL: (text: string, options: typeof QR_RENDER_OPTIONS) => Promise<string>;
};

let readerReady: Promise<typeof import("zxing-wasm/reader")> | null = null;

async function readerModule(): Promise<typeof import("zxing-wasm/reader")> {
  if (!readerReady) {
    readerReady = (async () => {
      const [reader, wasm] = await Promise.all([
        import("zxing-wasm/reader"),
        import("zxing-wasm/reader/zxing_reader.wasm?url"),
      ]);
      await reader.prepareZXingModule({
        overrides: {
          locateFile: () => wasm.default,
        },
        fireImmediately: true,
      });
      return reader;
    })();
  }
  return readerReady;
}

export async function decodeQrImageData(image: ImageData): Promise<string[]> {
  const reader = await readerModule();
  const found = await reader.readBarcodes(image, QR_READER_OPTIONS);
  return found.map((code) => code.text).filter((text) => text.length > 0);
}

export async function decodeQrFiles(files: Blob[]): Promise<string[]> {
  const texts: string[] = [];
  for (const file of files) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not read that image.");
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    texts.push(...(await decodeQrImageData(image)));
  }
  return texts;
}

export async function renderQrDataUrls(parts: string[]): Promise<string[]> {
  const loaded = await import("qrcode");
  const qrcode = ((loaded as { default?: QrCodeModule }).default ?? loaded) as QrCodeModule;
  const urls: string[] = [];
  for (const part of parts) {
    urls.push(await qrcode.toDataURL(part, QR_RENDER_OPTIONS));
  }
  return urls;
}
