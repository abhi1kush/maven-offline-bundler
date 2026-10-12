import { prepareRgba } from "./imagePrep";
import { cleanupOcrParts } from "./ocrCleanup";

export type OcrProgress = {
  imageIndex: number;
  imageCount: number;
  ratio: number;
  status: string;
};

type ImageSource = Blob | HTMLCanvasElement | Uint8Array;

type WorkerOptions = {
  workerPath?: string;
  corePath?: string;
  langPath?: string;
  gzip?: boolean;
  cachePath?: string;
};

const STATUS_LABELS: Record<string, string> = {
  "loading tesseract core": "loading OCR engine",
  "initializing tesseract": "starting OCR",
  "loading language traineddata": "loading language data",
  "initializing api": "preparing OCR",
  "recognizing text": "recognizing text",
};

export function formatOcrProgress(update: OcrProgress): string {
  const percent = Math.max(0, Math.min(100, Math.round(update.ratio * 100)));
  const label = STATUS_LABELS[update.status] ?? update.status;
  const which =
    update.imageCount > 1 ? `image ${update.imageIndex + 1} of ${update.imageCount}` : "image";
  return `Reading ${which} · ${label} ${percent}%`;
}

function browserWorkerOptions(): WorkerOptions {
  const base = import.meta.env.BASE_URL;
  return {
    workerPath: `${base}ocr/worker.min.js`,
    corePath: `${base}ocr/tesseract-core-simd-lstm.wasm.js`,
    langPath: `${base}ocr`,
    gzip: true,
  };
}

async function canvasFromBlob(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const source = document.createElement("canvas");
  source.width = bitmap.width;
  source.height = bitmap.height;
  const sourceContext = source.getContext("2d", { willReadFrequently: true });
  if (!sourceContext) throw new Error("Could not read that image.");
  sourceContext.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = sourceContext.getImageData(0, 0, source.width, source.height);
  const prepared = prepareRgba(image.data, source.width, source.height);
  const canvas = document.createElement("canvas");
  canvas.width = prepared.width;
  canvas.height = prepared.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not read that image.");
  const pixels = new Uint8ClampedArray(prepared.width * prepared.height * 4);
  pixels.set(prepared.pixels);
  context.putImageData(new ImageData(pixels, prepared.width, prepared.height), 0, 0);
  return canvas;
}

export async function recognizeImageSources(
  sources: ImageSource[],
  onProgress?: (update: OcrProgress) => void,
  options?: WorkerOptions,
): Promise<string> {
  if (sources.length === 0) throw new Error("Choose a PNG, JPG, or WebP image of the pom.");
  const report = (imageIndex: number, ratio: number, status: string) => {
    onProgress?.({
      imageIndex,
      imageCount: sources.length,
      ratio: (imageIndex + ratio) / sources.length,
      status,
    });
  };
  report(0, 0, "loading tesseract core");
  const { createWorker, OEM, PSM } = await import("tesseract.js");
  let currentIndex = 0;
  const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    ...options,
    logger: (message) => {
      const ratio = typeof message.progress === "number" ? message.progress : 0;
      report(currentIndex, ratio, message.status || "preparing OCR");
    },
  });
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
    const parts: string[] = [];
    for (let index = 0; index < sources.length; index += 1) {
      currentIndex = index;
      report(index, 0, "recognizing text");
      const result = await worker.recognize(sources[index] as HTMLCanvasElement, {}, { text: true });
      parts.push(result.data.text ?? "");
      report(index, 1, "recognizing text");
    }
    return cleanupOcrParts(parts);
  } finally {
    await worker.terminate();
  }
}

export async function recognizePomImages(
  files: Blob[],
  onProgress?: (update: OcrProgress) => void,
): Promise<string> {
  const sources: HTMLCanvasElement[] = [];
  for (const file of files) sources.push(await canvasFromBlob(file));
  return recognizeImageSources(sources, onProgress, browserWorkerOptions());
}
