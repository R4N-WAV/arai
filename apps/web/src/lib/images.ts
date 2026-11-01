/**
 * Re-encodes a picked image in the browser: crops/resizes to the target box
 * and writes a fresh WebP (JPEG fallback). This strips EXIF/GPS metadata and
 * anything hidden in the original file before it is uploaded.
 */
export async function prepareImage(file: File, box: { w: number; h: number }, maxBytes: number): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('unsupported_image');
  const bmp = await createImageBitmap(file).catch(() => {
    throw new Error('unsupported_image');
  });
  // Cover-crop to the target aspect ratio, never upscaling beyond the source.
  const target = box.w / box.h;
  const srcRatio = bmp.width / bmp.height;
  const sw = srcRatio > target ? bmp.height * target : bmp.width;
  const sh = srcRatio > target ? bmp.height : bmp.width / target;
  const scale = Math.min(1, box.w / sw);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, w, h);
  bmp.close();
  for (const type of ['image/webp', 'image/jpeg']) {
    for (const q of [0.9, 0.8, 0.7, 0.55, 0.4]) {
      const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));
      if (out && out.type === type && out.size <= maxBytes) return out;
    }
  }
  throw new Error('image_too_large');
}

export async function uploadImage(kind: 'avatar' | 'banner', data: Blob): Promise<void> {
  const res = await fetch(`/api/account/profile/${kind}`, {
    method: 'PUT',
    headers: { 'X-Arai-CSRF': '1', 'Content-Type': data.type },
    credentials: 'same-origin',
    body: data,
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'upload_failed');
}
