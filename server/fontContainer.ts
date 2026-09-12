/** Extract one complete SFNT face from a collection. Preserve every table,
 * including shaping data and embedding flags; this is not font subsetting. */
export function standaloneFont(bytes: Buffer, faceIndex: number): Buffer {
  if (bytes.toString("ascii", 0, 4) !== "ttcf") {
    if (faceIndex !== 0) throw new Error("Invalid font face index.");
    return bytes;
  }
  const count = bytes.readUInt32BE(8);
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= count) throw new Error("Invalid font face index.");
  const offset = bytes.readUInt32BE(12 + faceIndex * 4);
  const tables = bytes.readUInt16BE(offset + 4);
  let size = 12 + tables * 16;
  const entries = Array.from({ length: tables }, (_, i) => {
    const at = offset + 12 + i * 16;
    const source = bytes.readUInt32BE(at + 8), length = bytes.readUInt32BE(at + 12);
    if (source + length > bytes.length) throw new Error("Invalid font table.");
    const entry = { at, source, length, target: size };
    size += Math.ceil(length / 4) * 4;
    return entry;
  });
  const result = Buffer.alloc(size);
  bytes.copy(result, 0, offset, offset + 12);
  let head: number | undefined;
  for (const [i, entry] of entries.entries()) {
    const at = 12 + i * 16;
    bytes.copy(result, at, entry.at, entry.at + 16);
    result.writeUInt32BE(entry.target, at + 8);
    bytes.copy(result, entry.target, entry.source, entry.source + entry.length);
    if (result.toString("ascii", at, at + 4) === "head") {
      head = entry.target;
      result.writeUInt32BE(0, head + 8);
    }
  }
  if (head === undefined) throw new Error("Font has no head table.");
  let checksum = 0;
  for (let i = 0; i < result.length; i += 4) checksum = (checksum + result.readUInt32BE(i)) >>> 0;
  result.writeUInt32BE((0xb1b0afba - checksum) >>> 0, head + 8);
  return result;
}
