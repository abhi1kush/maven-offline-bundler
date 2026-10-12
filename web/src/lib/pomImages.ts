const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export function isPomImage(file: { type: string; name: string }): boolean {
  if (IMAGE_TYPES.has(file.type.toLowerCase())) return true;
  return /\.(png|jpe?g|webp)$/i.test(file.name);
}

export function imagesFromFileList(list: FileList | readonly File[] | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter((file) => isPomImage(file));
}

export function imagesFromClipboard(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && isPomImage(file)) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return imagesFromFileList(data.files);
}
