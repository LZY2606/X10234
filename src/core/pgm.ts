// Minimal decoder for ASCII (P2) and binary (P5) Netpbm PGM frames.
export interface PgmImage {
  width: number;
  height: number;
  maxVal: number;
  pixels: Uint8Array;
}

export function decodePgm(bytes: Uint8Array): PgmImage {
  const magic = String.fromCharCode(bytes[0], bytes[1]);
  if (magic === 'P2') return decodeAscii(bytes);
  if (magic === 'P5') return decodeBinary(bytes);
  throw new Error(`unsupported frame encoding ${magic} (expected P2/P5 PGM)`);
}

function readAsciiTokens(bytes: Uint8Array): string[] {
  let text = new TextDecoder('latin1').decode(bytes);
  const lines = text.split(/\r?\n/).map((line) => {
    const hash = line.indexOf('#');
    return hash === -1 ? line : line.slice(0, hash);
  });
  return lines.join('\n').split(/\s+/).filter(Boolean);
}

function decodeAscii(bytes: Uint8Array): PgmImage {
  const tokens = readAsciiTokens(bytes);
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  const maxVal = Number(tokens[3]);
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = clamp(Number(tokens[4 + i]), maxVal);
  return { width, height, maxVal, pixels };
}

function decodeBinary(bytes: Uint8Array): PgmImage {
  let pos = 0;
  const readToken = (): string => {
    while (pos < bytes.length && /\s/.test(String.fromCharCode(bytes[pos]))) pos++;
    let start = pos;
    while (pos < bytes.length && !/\s/.test(String.fromCharCode(bytes[pos]))) {
      if (bytes[pos] === 35) while (pos < bytes.length && bytes[pos] !== 10) pos++;
      else pos++;
    }
    return new TextDecoder('latin1').decode(bytes.slice(start, pos));
  };
  readToken(); // P5
  const width = Number(readToken());
  const height = Number(readToken());
  const maxVal = Number(readToken());
  pos++; // single whitespace separator
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = clamp(bytes[pos + i], maxVal);
  return { width, height, maxVal, pixels };
}

function clamp(v: number, maxVal: number): number {
  const scaled = maxVal <= 255 ? v : Math.round((v / maxVal) * 255);
  return Math.max(0, Math.min(255, scaled));
}
