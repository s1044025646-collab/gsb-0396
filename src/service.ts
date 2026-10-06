import { Store, ContextRow, BlockRow } from "./store";
import { decodeBlock, tryUtf8, DecodedField, TableEvent } from "./hpack";
import { HpackError } from "./errors";
import { STATIC_TABLE_SIZE } from "./staticTable";

export function parseBytes(data: string, encoding: string): Buffer {
  if (encoding === "hex") {
    const clean = data.replace(/[\s,]/g, "").toLowerCase();
    if (!/^([0-9a-f]{2})*$/.test(clean)) {
      throw new HpackError("INVALID_INPUT", "十六进制输入非法（需偶数个 0-9a-f 字符）");
    }
    return Buffer.from(clean, "hex");
  }
  if (encoding === "base64") {
    const trimmed = data.trim();
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
      throw new HpackError("INVALID_INPUT", "Base64 输入非法");
    }
    return Buffer.from(trimmed, "base64");
  }
  throw new HpackError("INVALID_INPUT", `不支持的编码: ${encoding}（仅支持 hex / base64）`);
}

function fieldToJson(f: DecodedField) {
  return {
    name: tryUtf8(f.name),
    value: tryUtf8(f.value),
    nameHex: f.name.toString("hex"),
    valueHex: f.value.toString("hex"),
    kind: f.kind,
    byteStart: f.byteStart,
    byteEnd: f.byteEnd,
    index: f.index ?? null,
    nameIndex: f.nameIndex ?? null,
  };
}

export interface SubmitOutcome {
  ok: boolean;
  block: BlockRow;
  fields?: ReturnType<typeof fieldToJson>[];
  events?: TableEvent[];
  table?: unknown;
  error?: { code: string; message: string; offset: number | null };
}

export function submitBlock(store: Store, contextId: string, data: string, encoding: string): SubmitOutcome {
  const raw = parseBytes(data, encoding);
  const ctx = store.getContext(contextId);
  if (ctx.totalDecoded + raw.length > ctx.limits.maxTotalDecodedBytes) {
    throw new HpackError("LIMIT_EXCEEDED", `累计解码字节将超过上限 ${ctx.limits.maxTotalDecodedBytes}`);
  }
  const table = store.tableFromContext(ctx);
  try {
    const res = decodeBlock(raw, table, { maxAllowedCapacity: ctx.maxCapacity, limits: ctx.limits });
    const resultJson = {
      fields: res.fields.map(fieldToJson),
      events: res.events,
      bytesConsumed: res.bytesConsumed,
    };
    const block = store.commitBlock(
      contextId,
      encoding,
      raw,
      ctx.dynEntries,
      ctx.dynCapacity,
      resultJson,
      res.table,
      raw.length
    );
    return { ok: true, block, fields: resultJson.fields, events: res.events, table: tableSnapshot(store, contextId) };
  } catch (err) {
    const he =
      err instanceof HpackError
        ? err
        : new HpackError("INVALID_INPUT", err instanceof Error ? err.message : String(err));
    const block = store.recordFailedBlock(contextId, encoding, raw, ctx.dynEntries, ctx.dynCapacity, he.toJSON());
    return { ok: false, block, error: he.toJSON() };
  }
}

export function tableSnapshot(store: Store, contextId: string) {
  const ctx = store.getContext(contextId);
  const table = store.tableFromContext(ctx);
  return {
    capacity: table.capacity,
    maxCapacity: ctx.maxCapacity,
    size: table.size,
    entries: table.entries.map((e, i) => ({
      index: STATIC_TABLE_SIZE + 1 + i,
      name: tryUtf8(e.name),
      value: tryUtf8(e.value),
      nameHex: e.name.toString("hex"),
      valueHex: e.value.toString("hex"),
      size: e.size,
    })),
    totalDecoded: ctx.totalDecoded,
  };
}

export function contextInfo(ctx: ContextRow) {
  return {
    id: ctx.id,
    name: ctx.name,
    maxCapacity: ctx.maxCapacity,
    dynCapacity: ctx.dynCapacity,
    dynEntryCount: ctx.dynEntries.length,
    totalDecoded: ctx.totalDecoded,
    limits: ctx.limits,
    createdAt: ctx.createdAt,
  };
}

export function blockExplanation(store: Store, contextId: string, seq: number) {
  const b = store.getBlock(contextId, seq);
  return {
    seq: b.seq,
    encoding: b.encoding,
    rawHex: b.rawHex,
    ok: b.ok,
    error: b.error,
    result: b.result,
    inputTable: b.inputTable.map((e, i) => ({
      index: STATIC_TABLE_SIZE + 1 + i,
      nameHex: e.nameHex,
      valueHex: e.valueHex,
      name: tryUtf8(Buffer.from(e.nameHex, "hex")),
      value: tryUtf8(Buffer.from(e.valueHex, "hex")),
    })),
    inputDynCapacity: b.inputDynCapacity,
    createdAt: b.createdAt,
  };
}
