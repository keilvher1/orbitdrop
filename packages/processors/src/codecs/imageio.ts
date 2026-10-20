import { OrbitError } from '@orbitdrop/contracts';

// Placeholder: macOS ImageIO bridge through the native helper's `imageio` CLI mode (P2).
export async function decodeWithImageIO(_input: Buffer): Promise<Buffer> {
  throw new OrbitError('ENGINE_UNAVAILABLE', 'HEIC decoding is not available in this build');
}

export async function encodeWithImageIO(_png: Buffer, _format: 'heic', _quality: number): Promise<Buffer> {
  throw new OrbitError('ENGINE_UNAVAILABLE', 'HEIC encoding is not available in this build');
}
