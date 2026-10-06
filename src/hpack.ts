// HPACK (RFC 7541) offline decoder core. Non-Huffman strings only.
// No third-party HPACK libraries are used; integer/string/table logic is
// implemented from scratch here.

export type ErrorCode =
  | "INT_OVERFLOW"
  | "INDEX_OUT_OF_RANGE"
  | "TRUNCATED"
  | "HUFFMAN_UNSUPPORTED"
  | "SIZE_UPDATE_NOT_AT_START"
  | "SIZE_UPDATE_TOO_LARGE"
  | "LIMIT_EXCEEDED"
  | "BAD_INPUT";

export class HpackError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public byteOffset?: number
  ) {
    super(message);
    this.name = "HpackError";
  }
}

export interface TableEntry {
  name: Buffer;
  value: Buffer;
}

export function entrySize(e: TableEntry): number {
  return e.name.length + e.value.length + 32;
}

// RFC 7541 Appendix A: 61 static entries, index 1..61.
const STATIC_ROWS: Array<[string, string]> = [
  [":authority", ""],
  [":method", "GET"],
  [":method", "POST"],
  [":path", "/"],
  [":path", "/index.html"],
  [":scheme", "http"],
  [":scheme", "https"],
  [":status", "200"],
  [":status", "204"],
  [":status", "206"],
  [":status", "304"],
  [":status", "400"],
  [":status", "404"],
  [":status", "500"],
  ["accept-charset", ""],
  ["accept-encoding", "gzip, deflate"],
  ["accept-language", ""],
  ["accept-ranges", ""],
  ["accept", ""],
  ["access-control-allow-origin", ""],
  ["age", ""],
  ["allow", ""],
  ["authorization", ""],
  ["cache-control", ""],
  ["content-disposition", ""],
  ["content-encoding", ""],
  ["content-language", ""],
  ["content-length", ""],
  ["content-location", ""],
  ["content-range", ""],
  ["content-type", ""],
  ["cookie", ""],
  ["date", ""],
  ["etag", ""],
  ["expect", ""],
  ["expires", ""],
  ["from", ""],
  ["host", ""],
  ["if-match", ""],
  ["if-modified-since", ""],
  ["if-none-match", ""],
  ["if-range", ""],
  ["if-unmodified-since", ""],
  ["last-modified", ""],
  ["link", ""],
  ["location", ""],
  ["max-forwards", ""],
  ["proxy-authenticate", ""],
  ["proxy-authorization", ""],
  ["range", ""],
  ["referer", ""],
  ["refresh", ""],
  ["retry-after", ""],
  ["server", ""],
  ["set-cookie", ""],
  ["strict-transport-security", ""],
  ["transfer-encoding", ""],
  ["user-agent", ""],
  ["vary", ""],
  ["via", ""],
  ["www-authenticate", ""],
];

export const STATIC_TABLE: TableEntry[] = STATIC_ROWS.map(([n, v]) => ({
  name: Buffer.from(n, "utf8"),
  value: Buffer.from(v, "utf8"),
}));

export const STATIC_TABLE_SIZE = STATIC_TABLE.length; // 61

export interface Limits {
  maxBlockBytes: number;
  maxFields: number;
  maxIntegerBytes: number; // max continuation bytes for one integer
  maxDecodedBytesTotal: number; // cumulative per context
}

export const DEFAULT_LIMITS: Limits = {
  maxBlockBytes: 64 * 1024,
  maxFields: 1000,
  maxIntegerBytes: 8,
  maxDecodedBytesTotal: 16 * 1024 * 1024,
};

// Dynamic table state. entries[0] is the NEWEST entry (index 62).
export interface DynamicTable {
  entries: TableEntry[];
  capacity: number; // current max size (from size updates, bounded by setting)
  size: number;
}

export function emptyTable(capacity: number): DynamicTable {
  return { entries: [], capacity, size: 0 };
}

export function cloneTable(t: DynamicTable): DynamicTable {
  return { entries: t.entries.slice(), capacity: t.capacity, size: t.size };
}

function evictToFit(t: DynamicTable, needed: number, changes: string[]): void {
  while (t.size + needed > t.capacity && t.entries.length > 0) {
    const evicted = t.entries.pop()!; // oldest
    t.size -= entrySize(evicted);
    changes.push(
      `evicted oldest entry (size ${entrySize(evicted)}) to fit new entry`
    );
  }
}

export function insertEntry(
  t: DynamicTable,
  entry: TableEntry,
  changes: string[]
): boolean {
  const sz = entrySize(entry);
  if (sz > t.capacity) {
    // Entry larger than capacity: table is emptied, entry not inserted.
    while (t.entries.length > 0) {
      const evicted = t.entries.pop()!;
      t.size -= entrySize(evicted);
    }
    changes.push(
      `entry size ${sz} exceeds capacity ${t.capacity}: table emptied, entry not inserted`
    );
    return false;
  }
  evictToFit(t, sz, changes);
  t.entries.unshift(entry);
  t.size += sz;
  changes.push(
    `inserted at dynamic index ${STATIC_TABLE_SIZE + 1} (size ${sz}); table size now ${t.size}/${t.capacity}`
  );
  return true;
}

export function setTableCapacity(
  t: DynamicTable,
  newCapacity: number,
  changes: string[]
): void {
  t.capacity = newCapacity;
  evictToFit(t, 0, changes);
  changes.push(`dynamic table capacity set to ${newCapacity}`);
}

// Look up a 1-based HPACK index across static + dynamic tables.
export function lookupIndex(t: DynamicTable, index: number, at: number): TableEntry {
  if (index < 1) {
    throw new HpackError("INDEX_OUT_OF_RANGE", `index 0 is invalid`, at);
  }
  if (index <= STATIC_TABLE_SIZE) {
    return STATIC_TABLE[index - 1];
  }
  const dyn = index - STATIC_TABLE_SIZE - 1;
  if (dyn >= t.entries.length) {
    throw new HpackError(
      "INDEX_OUT_OF_RANGE",
      `index ${index} out of range: static table has ${STATIC_TABLE_SIZE} entries, dynamic table has ${t.entries.length}`,
      at
    );
  }
  return t.entries[dyn];
}

export interface IntegerResult {
  value: number;
  offset: number; // offset after the integer
}

// RFC 7541 Section 5.1: prefixed integer decode.
export function decodeInteger(
  buf: Buffer,
  offset: number,
  prefixBits: number,
  limits: Limits
): IntegerResult {
  if (offset >= buf.length) {
    throw new HpackError("TRUNCATED", "integer prefix byte missing", offset);
  }
  const start = offset;
  const mask = (1 << prefixBits) - 1;
  let value = buf[offset] & mask;
  offset++;
  if (value < mask) {
    return { value, offset };
  }
  let shift = 0;
  let contBytes = 0;
  for (;;) {
    if (offset >= buf.length) {
      throw new HpackError(
        "TRUNCATED",
        `integer starting at byte ${start} is truncated`,
        offset
      );
    }
    if (contBytes >= limits.maxIntegerBytes) {
      throw new HpackError(
        "INT_OVERFLOW",
        `integer starting at byte ${start} exceeds ${limits.maxIntegerBytes} continuation bytes`,
        start
      );
    }
    const b = buf[offset];
    offset++;
    contBytes++;
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (!Number.isSafeInteger(value)) {
      throw new HpackError(
        "INT_OVERFLOW",
        `integer starting at byte ${start} exceeds safe integer range`,
        start
      );
    }
    if ((b & 0x80) === 0) break;
  }
  return { value, offset };
}

export interface StringResult {
  bytes: Buffer;
  offset: number;
}

// RFC 7541 Section 5.2: string literal, non-Huffman only.
export function decodeString(
  buf: Buffer,
  offset: number,
  limits: Limits
): StringResult {
  if (offset >= buf.length) {
    throw new HpackError("TRUNCATED", "string length byte missing", offset);
  }
  const start = offset;
  if (buf[offset] & 0x80) {
    throw new HpackError(
      "HUFFMAN_UNSUPPORTED",
      `Huffman-coded string at byte ${start} is not supported by this tool`,
      start
    );
  }
  const len = decodeInteger(buf, offset, 7, limits);
  offset = len.offset;
  if (offset + len.value > buf.length) {
    throw new HpackError(
      "TRUNCATED",
      `string at byte ${start} declares ${len.value} bytes but only ${buf.length - offset} remain`,
      offset
    );
  }
  return { bytes: buf.subarray(offset, offset + len.value), offset: offset + len.value };
}

export type Representation =
  | "indexed"
  | "literal_incremental"
  | "literal_without_indexing"
  | "literal_never_indexed";

export interface FieldExplanation {
  byteRange: [number, number];
  representation: Representation;
  index?: number; // resolved table index for indexed fields / name references
  nameFrom: "index" | "literal";
  tableChanges: string[];
}

export interface DecodedField {
  name: Buffer;
  value: Buffer;
  explanation: FieldExplanation;
}

export interface SizeUpdate {
  byteRange: [number, number];
  newCapacity: number;
}

export interface DecodeResult {
  fields: DecodedField[];
  sizeUpdates: SizeUpdate[];
  table: DynamicTable; // new committed table state
  decodedBytes: number;
}

export interface DecodeOptions {
  limits?: Partial<Limits>;
  maxAllowedCapacity: number; // configured ceiling for size updates
  decodedBytesSoFar?: number;
}

// Decode one header block against a dynamic table state. The input table is
// NOT mutated; on success the caller commits result.table, on failure the
// previous state remains intact (atomic semantics).
export function decodeBlock(
  block: Buffer,
  table: DynamicTable,
  options: DecodeOptions
): DecodeResult {
  const limits: Limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  if (block.length > limits.maxBlockBytes) {
    throw new HpackError(
      "LIMIT_EXCEEDED",
      `block size ${block.length} exceeds limit ${limits.maxBlockBytes}`,
      0
    );
  }
  const prior = options.decodedBytesSoFar ?? 0;
  if (prior + block.length > limits.maxDecodedBytesTotal) {
    throw new HpackError(
      "LIMIT_EXCEEDED",
      `cumulative decoded bytes ${prior + block.length} exceeds limit ${limits.maxDecodedBytesTotal}`,
      0
    );
  }

  const work = cloneTable(table);
  const fields: DecodedField[] = [];
  const sizeUpdates: SizeUpdate[] = [];
  let offset = 0;
  let seenField = false;

  while (offset < block.length) {
    if (fields.length >= limits.maxFields) {
      throw new HpackError(
        "LIMIT_EXCEEDED",
        `field count exceeds limit ${limits.maxFields}`,
        offset
      );
    }
    const b = block[offset];
    const start = offset;

    if (b & 0x80) {
      // Indexed header field, 7-bit prefix.
      const idx = decodeInteger(block, offset, 7, limits);
      offset = idx.offset;
      const entry = lookupIndex(work, idx.value, start);
      fields.push({
        name: entry.name,
        value: entry.value,
        explanation: {
          byteRange: [start, offset],
          representation: "indexed",
          index: idx.value,
          nameFrom: "index",
          tableChanges: [],
        },
      });
      seenField = true;
    } else if (b & 0x40) {
      // Literal with incremental indexing, 6-bit prefix.
      const idx = decodeInteger(block, offset, 6, limits);
      offset = idx.offset;
      let name: Buffer;
      let nameFrom: "index" | "literal";
      let refIndex: number | undefined;
      if (idx.value === 0) {
        const s = decodeString(block, offset, limits);
        name = s.bytes;
        offset = s.offset;
        nameFrom = "literal";
      } else {
        name = lookupIndex(work, idx.value, start).name;
        nameFrom = "index";
        refIndex = idx.value;
      }
      const v = decodeString(block, offset, limits);
      const value = v.bytes;
      offset = v.offset;
      const changes: string[] = [];
      insertEntry(work, { name: Buffer.from(name), value: Buffer.from(value) }, changes);
      fields.push({
        name,
        value,
        explanation: {
          byteRange: [start, offset],
          representation: "literal_incremental",
          index: refIndex,
          nameFrom,
          tableChanges: changes,
        },
      });
      seenField = true;
    } else if ((b & 0xe0) === 0x20) {
      // Dynamic table size update, 5-bit prefix. Must precede any field.
      if (seenField) {
        throw new HpackError(
          "SIZE_UPDATE_NOT_AT_START",
          `table size update at byte ${start} appears after header fields`,
          start
        );
      }
      const sz = decodeInteger(block, offset, 5, limits);
      offset = sz.offset;
      if (sz.value > options.maxAllowedCapacity) {
        throw new HpackError(
          "SIZE_UPDATE_TOO_LARGE",
          `size update ${sz.value} at byte ${start} exceeds allowed maximum ${options.maxAllowedCapacity}`,
          start
        );
      }
      const changes: string[] = [];
      setTableCapacity(work, sz.value, changes);
      sizeUpdates.push({ byteRange: [start, offset], newCapacity: sz.value });
    } else {
      // Literal without indexing (0000) or never indexed (0001), 4-bit prefix.
      const neverIndexed = (b & 0x10) !== 0;
      const idx = decodeInteger(block, offset, 4, limits);
      offset = idx.offset;
      let name: Buffer;
      let nameFrom: "index" | "literal";
      let refIndex: number | undefined;
      if (idx.value === 0) {
        const s = decodeString(block, offset, limits);
        name = s.bytes;
        offset = s.offset;
        nameFrom = "literal";
      } else {
        name = lookupIndex(work, idx.value, start).name;
        nameFrom = "index";
        refIndex = idx.value;
      }
      const v = decodeString(block, offset, limits);
      const value = v.bytes;
      offset = v.offset;
      fields.push({
        name,
        value,
        explanation: {
          byteRange: [start, offset],
          representation: neverIndexed
            ? "literal_never_indexed"
            : "literal_without_indexing",
          index: refIndex,
          nameFrom,
          tableChanges: [],
        },
      });
      seenField = true;
    }
  }

  return { fields, sizeUpdates, table: work, decodedBytes: block.length };
}

// Try to render bytes as UTF-8 text; returns undefined if not valid UTF-8.
export function utf8Text(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
