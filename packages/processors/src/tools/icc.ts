/**
 * Minimal ICC profile reader: the profile description ('desc' tag) as v2
 * textDescriptionType or v4 multiLocalizedUnicodeType ('mluc', English record
 * preferred). Returns null for anything malformed.
 */
export function iccDescription(icc: Uint8Array | undefined): string | null {
  if (!icc || icc.length < 132) return null;
  const buf = Buffer.from(icc.buffer, icc.byteOffset, icc.byteLength);
  try {
    const count = buf.readUInt32BE(128);
    if (count > 1000) return null;
    for (let i = 0; i < count; i += 1) {
      const entry = 132 + i * 12;
      if (entry + 12 > buf.length) return null;
      if (buf.toString('latin1', entry, entry + 4) !== 'desc') continue;
      const offset = buf.readUInt32BE(entry + 4);
      const size = buf.readUInt32BE(entry + 8);
      if (offset + Math.min(size, 12) > buf.length || size < 12) return null;
      const type = buf.toString('latin1', offset, offset + 4);
      if (type === 'desc') {
        const length = buf.readUInt32BE(offset + 8);
        if (length === 0 || offset + 12 + length > buf.length) return null;
        return clean(buf.toString('latin1', offset + 12, offset + 12 + length));
      }
      if (type === 'mluc') {
        const records = buf.readUInt32BE(offset + 8);
        const recordSize = buf.readUInt32BE(offset + 12);
        if (recordSize < 12 || records > 200) return null;
        let chosen: { len: number; off: number } | null = null;
        for (let r = 0; r < records; r += 1) {
          const rec = offset + 16 + r * recordSize;
          if (rec + 12 > buf.length) break;
          const lang = buf.toString('latin1', rec, rec + 2);
          const len = buf.readUInt32BE(rec + 4);
          const off = buf.readUInt32BE(rec + 8);
          if (!chosen || lang === 'en') chosen = { len, off };
          if (lang === 'en') break;
        }
        if (!chosen) return null;
        const start = offset + chosen.off;
        if (start + chosen.len > buf.length) return null;
        const u16 = Buffer.from(buf.subarray(start, start + chosen.len));
        u16.swap16();
        return clean(u16.toString('utf16le'));
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

function clean(text: string): string | null {
  const t = text.replace(/\u0000+$/g, '').replace(/[\u0000-\u001f]/g, ' ').trim();
  return t.length > 0 ? t.slice(0, 200) : null;
}

/** sRGB profiles (by description) — converting to sRGB from one of these is the identity. */
export function isSrgbProfile(description: string | null): boolean {
  return description !== null && /^s?RGB IEC ?61966-2[.-]1\b|^sRGB\b/i.test(description) && !/linear/i.test(description);
}
