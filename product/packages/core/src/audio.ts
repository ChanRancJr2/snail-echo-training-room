export const audioMimeTypes = ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac'] as const;
export type AudioMime = typeof audioMimeTypes[number];
export const maxAudioBytes = 15_000_000;

export function detectAudioMime(bytes: Uint8Array): AudioMime | null {
  if (bytes.length < 16) return null;
  const at = (offset: number, ...signature: number[]) => signature.every((byte, index) => bytes[offset + index] === byte);
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'audio/webm';
  if (at(0, 0x4f, 0x67, 0x67, 0x53)) return 'audio/ogg';
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return 'audio/mp4';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x41, 0x56, 0x45)) return 'audio/wav';
  if (at(0, 0x49, 0x44, 0x33)) return 'audio/mpeg';
  const second = bytes[1]!;
  if (bytes[0] === 255 && (second & 246) === 240) return 'audio/aac';
  if (bytes[0] === 255 && (second & 224) === 224 && (second & 6) !== 0) return 'audio/mpeg';
  return null;
}
