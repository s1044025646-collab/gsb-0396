import { HpackError } from "./errors";
import { STATIC_TABLE, STATIC_TABLE_SIZE, TableEntry } from "./staticTable";

export const ENTRY_OVERHEAD = 32;

export interface Limits {
  maxBlockBytes: number;
  maxFields: number;
  maxIntegerBytes: number;
  maxTotalDecodedBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxBlockBytes: 64 * 1024,
  maxFields: 1000,
  maxIntegerBytes: 8,
  maxTotalDecodedBytes: 16 * 1024 * 1024,
};

export function entrySize(name: Buffer, value: Buffer): number {
  return name.length + value.length + ENTRY_OVERHEAD;
}

export interface DynEntry {
  name: Buffer;
  value: Buffer;
  size: number;
}

export class DynamicTable {
  // newest first
  entries: DynEntry[] = [];
  size = 0;
  capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  clone(): DynamicTable {
    const t = new DynamicTable(this.capacity);
    t.entries = this.entries.map((x) => ({ ...x }));
    t.size = this.size;
    return t;
  }

  setCapacity(capacity: number): { evicted: number } {
    this.capacity = capacity;
    return { evicted: this.evict() };
  }

  private evict(): number {
    let evicted = 0;
    while (this.size > this.capacity && this.entries.length > 0) {
      const old = this.entries.pop()!;
      this.size -= old.size;
      evicted++;
    }
    return evicted;
  }

  insert(name: Buffer, value: Buffer): { evicted: number; inserted: boolean } {
    const size = entrySize(name, value);
    if (size > this.capacity) {
      const evicted = this.entries.length;
      this.entries = [];
      this.size = 0;
      return { evicted, inserted: false };
    }
    this.entries.unshift({ name, value, size });
    this.size += size;
    const evicted = this.evict();
    return { evicted, inserted: true };
  }
}

export function lookupIndex(table: DynamicTable, index: number, offset: number): TableEntry {
  if (!Number.isInteger(index) || index < 1) {
    throw new HpackError("INDEX_OUT_OF_RANGE", `非法索引 ${index}`, offset);
  }
  if (index <= STATIC_TABLE_SIZE) return STATIC_TABLE[index - 1];
  const dynIdx = index - STATIC_TABLE_SIZE - 1;
  if (dynIdx >= table.entries.length) {
    throw new HpackError(
      "INDEX_OUT_OF_RANGE",
      `索引 ${index} 超出范围（静态表 ${STATIC_TABLE_SIZE} 项，动态表 ${table.entries.length} 项）`,
      offset
    );
  }
  return table.entries[dynIdx];
}

export interface IntegerResult {
  value: number;
  bytesRead: number;
}

export function decodeInteger(buf: Buffer, offset: number, prefixBits: number, maxIntegerBytes: number): IntegerResult {
  if (offset >= buf.length) {
    throw new HpackError("TRUNCATED", "整数起始处已到达块末尾", offset);
  }
  const mask = (1 << prefixBits) - 1;
  let value = buf[offset] & mask;
  let bytesRead = 1;
  if (value < mask) return { value, bytesRead };
  let shift = 0;
  for (;;) {
    if (offset + bytesRead >= buf.length) {
      throw new HpackError("TRUNCATED", "多字节整数在块末尾被截断", offset + bytesRead);
    }
    if (bytesRead >= maxIntegerBytes) {
      throw new HpackError("INTEGER_OVERFLOW", `整数超过 ${maxIntegerBytes} 字节上限`, offset);
    }
    const b = buf[offset + bytesRead];
    bytesRead++;
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (!Number.isSafeInteger(value)) {
      throw new HpackError("INTEGER_OVERFLOW", "整数超出安全整数范围", offset);
    }
    if ((b & 0x80) === 0) break;
  }
  return { value, bytesRead };
}

export interface StringResult {
  bytes: Buffer;
  bytesRead: number;
}

export function decodeString(buf: Buffer, offset: number, maxIntegerBytes: number): StringResult {
  if (offset >= buf.length) {
    throw new HpackError("TRUNCATED", "字符串起始处已到达块末尾", offset);
  }
  if (buf[offset] & 0x80) {
    throw new HpackError(
      "HUFFMAN_UNSUPPORTED",
      "字符串使用 Huffman 编码（H 位为 1），本工具仅支持非 Huffman 表示",
      offset
    );
  }
  const len = decodeInteger(buf, offset, 7, maxIntegerBytes);
  const start = offset + len.bytesRead;
  const end = start + len.value;
  if (end > buf.length) {
    throw new HpackError(
      "TRUNCATED",
      `字符串声明长度 ${len.value} 字节，但块内仅剩 ${buf.length - start} 字节`,
      start
    );
  }
  return { bytes: buf.subarray(start, end), bytesRead: len.bytesRead + len.value };
}

export type FieldKind = "indexed" | "literal_incremental" | "literal_never" | "literal_never_indexed" | "literal_without_indexing";

export interface DecodedField {
  name: Buffer;
  value: Buffer;
  kind: FieldKind;
  byteStart: number;
  byteEnd: number; // exclusive
  index?: number; // resolved table index when applicable
  nameIndex?: number; // table index used for the name, when referenced
}

export interface TableEvent {
  type: "insert" | "evict" | "clear" | "resize";
  index?: number;
  name?: string;
  size?: number;
  capacity?: number;
  count?: number;
}

export interface DecodeResult {
  fields: DecodedField[];
  events: TableEvent[];
  table: DynamicTable; // new committed table state
  bytesConsumed: number;
}

export interface DecodeOptions {
  maxAllowedCapacity: number;
  limits: Limits;
}

export function decodeBlock(block: Buffer, table: DynamicTable, opts: DecodeOptions): DecodeResult {
  const { limits } = opts;
  if (block.length > limits.maxBlockBytes) {
    throw new HpackError("LIMIT_EXCEEDED", `块大小 ${block.length} 超过上限 ${limits.maxBlockBytes}`, 0);
  }
  const work = table.clone();
  const fields: DecodedField[] = [];
  const events: TableEvent[] = [];
  let pos = 0;
  let seenField = false;

  while (pos < block.length) {
    if (fields.length >= limits.maxFields) {
      throw new HpackError("LIMIT_EXCEEDED", `字段数超过上限 ${limits.maxFields}`, pos);
    }
    const b = block[pos];
    const start = pos;

    if (b & 0x80) {
      // Indexed Header Field — 1xxxxxxx
      const idx = decodeInteger(block, pos, 7, limits.maxIntegerBytes);
      const entry = lookupIndex(work, idx.value, pos);
      pos += idx.bytesRead;
      fields.push({
        name: entry.name,
        value: entry.value,
        kind: "indexed",
        byteStart: start,
        byteEnd: pos,
        index: idx.value,
      });
      seenField = true;
    } else if ((b & 0xe0) === 0x20) {
      // Dynamic Table Size Update — 001xxxxx
      if (seenField) {
        throw new HpackError("SIZE_UPDATE_NOT_AT_START", "动态表大小更新只允许出现在块开头", pos);
      }
      const sz = decodeInteger(block, pos, 5, limits.maxIntegerBytes);
      if (sz.value > opts.maxAllowedCapacity) {
        throw new HpackError(
          "SIZE_UPDATE_TOO_LARGE",
          `大小更新 ${sz.value} 超过允许上限 ${opts.maxAllowedCapacity}`,
          pos
        );
      }
      pos += sz.bytesRead;
      const { evicted } = work.setCapacity(sz.value);
      events.push({ type: "resize", capacity: sz.value, count: evicted });
    } else {
      // Literal forms
      let kind: FieldKind;
      let prefixBits: number;
      if ((b & 0xc0) === 0x40) {
        kind = "literal_incremental";
        prefixBits = 6;
      } else if ((b & 0xf0) === 0x10) {
        kind = "literal_never";
        prefixBits = 4;
      } else {
        kind = "literal_without_indexing";
        prefixBits = 4;
      }
      const nameIdx = decodeInteger(block, pos, prefixBits, limits.maxIntegerBytes);
      pos += nameIdx.bytesRead;
      let name: Buffer;
      let referencedNameIndex: number | undefined;
      if (nameIdx.value === 0) {
        const s = decodeString(block, pos, limits.maxIntegerBytes);
        name = Buffer.from(s.bytes);
        pos += s.bytesRead;
      } else {
        const entry = lookupIndex(work, nameIdx.value, start);
        name = entry.name;
        referencedNameIndex = nameIdx.value;
      }
      const v = decodeString(block, pos, limits.maxIntegerBytes);
      const value = Buffer.from(v.bytes);
      pos += v.bytesRead;
      const field: DecodedField = {
        name,
        value,
        kind,
        byteStart: start,
        byteEnd: pos,
        nameIndex: referencedNameIndex,
      };
      if (kind === "literal_incremental") {
        const { evicted, inserted } = work.insert(name, value);
        const size = entrySize(name, value);
        if (inserted) {
          events.push({ type: "insert", index: STATIC_TABLE_SIZE + 1, name: name.toString("utf8"), size });
        } else {
          events.push({ type: "clear", name: name.toString("utf8"), size });
        }
        if (evicted > 0) events.push({ type: "evict", count: evicted });
        field.index = inserted ? STATIC_TABLE_SIZE + 1 : undefined;
      }
      fields.push(field);
      seenField = true;
    }
  }

  return { fields, events, table: work, bytesConsumed: pos };
}

export function tryUtf8(buf: Buffer): string | null {
  // strict UTF-8 validation without altering payload
  const td = new TextDecoder("utf-8", { fatal: true });
  try {
    return td.decode(buf);
  } catch {
    return null;
  }
}
