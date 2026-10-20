import { OrbitError } from '@orbitdrop/contracts';

// Placeholder: the processors-convert workstream implements a real BMP codec here.
export interface RawRgba {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

export function decodeBmp(_buffer: Buffer, _maxPixels: number): RawRgba {
  throw new OrbitError('ENGINE_UNAVAILABLE', 'BMP decoder not implemented yet');
}

export function encodeBmp(_image: RawRgba): Buffer {
  throw new OrbitError('ENGINE_UNAVAILABLE', 'BMP encoder not implemented yet');
}
