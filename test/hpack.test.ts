import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeBlock,
  decodeInteger,
  emptyTable,
  entrySize,
  HpackError,
  STATIC_TABLE_SIZE,
  DEFAULT_LIMITS,
} from "../src/hpack";

const OPTS = { maxAllowedCapacity: 4096 };

function dec(hex: string, table = emptyTable(4096), opts: any = {}) {
  return decodeBlock(Buffer.from(hex.replace(/\s+/g, ""), "hex"), table, { ...OPTS, ...opts });
}

test("static table has 61 entries", () => {
  assert.equal(STATIC_TABLE_SIZE, 61);
});

test("demo fixture: 82 41 03 66 6f 6f -> :method=GET, :authority=foo (size 45)", () => {
  const r = dec("82 41 03 66 6f 6f");
  assert.equal(r.fields.length, 2);
  assert.equal(r.fields[0].name.toString(), ":method");
  assert.equal(r.fields[0].value.toString(), "GET");
  assert.equal(r.fields[0].explanation.index, 2);
  assert.equal(r.fields[1].name.toString(), ":authority");
  assert.equal(r.fields[1].value.toString(), "foo");
  assert.equal(r.fields[1].explanation.representation, "literal_incremental");
  assert.equal(r.fields[1].explanation.index, 1); // name from static index 1
  assert.deepEqual(r.fields[1].explanation.byteRange, [1, 6]);
  assert.equal(r.table.entries.length, 1);
  assert.equal(entrySize(r.table.entries[0]), 45);
  assert.equal(r.table.size, 45);
});

test("next block BE references dynamic index 62", () => {
  const r1 = dec("82 41 03 66 6f 6f");
  const r2 = dec("BE", r1.table);
  assert.equal(r2.fields[0].name.toString(), ":authority");
  assert.equal(r2.fields[0].value.toString(), "foo");
  assert.equal(r2.fields[0].explanation.index, 62);
});

test("capacity zero: size update 20 evicts, then BE fails with INDEX_OUT_OF_RANGE", () => {
  const r1 = dec("82 41 03 66 6f 6f");
  const r2 = dec("20", r1.table); // size update to 0
  assert.equal(r2.table.capacity, 0);
  assert.equal(r2.table.entries.length, 0);
  assert.deepEqual(r2.sizeUpdates, [{ byteRange: [0, 1], newCapacity: 0 }]);
  assert.throws(() => dec("BE", r2.table), (e: any) => e.code === "INDEX_OUT_OF_RANGE" && e.byteOffset === 0);
});

test("static boundary: index 61 (BD) and index 62 out of range on empty dynamic table", () => {
  const r = dec("BD"); // 61 = www-authenticate
  assert.equal(r.fields[0].name.toString(), "www-authenticate");
  assert.throws(() => dec("BE"), /out of range/);
  assert.throws(() => dec("80"), (e: any) => e.code === "INDEX_OUT_OF_RANGE"); // index 0
});

test("duplicate names are kept as separate ordered fields", () => {
  // two literal-without-indexing fields named "x": 00 01 78 01 61 / 00 01 78 01 62
  const r = dec("00 01 78 01 61 00 01 78 01 62");
  assert.equal(r.fields.length, 2);
  assert.equal(r.fields[0].name.toString(), "x");
  assert.equal(r.fields[0].value.toString(), "a");
  assert.equal(r.fields[1].value.toString(), "b");
  assert.equal(r.table.entries.length, 0); // without indexing never inserts
});

test("multi-byte integer: literal incremental with long name index and long string", () => {
  // 5f = 01 0b11111 -> prefix max 31, continuation 0x02 => index 31+2=33? build instead:
  // name index via 6-bit prefix: 0x7f 0x00 -> 63+0 = 63? use dynamic. Simpler: string length 20 multibyte.
  // value string of length 300: 7f (127 max) + (300-127)=173 -> 0xad 0x01
  const value = Buffer.alloc(300, 0x61);
  const head = Buffer.from([0x40, 0x01, 0x6e, 0x7f, 0xad, 0x01]); // literal inc, name "n", len 300
  const r = decodeBlock(Buffer.concat([head, value]), emptyTable(4096), OPTS);
  assert.equal(r.fields[0].value.length, 300);
  assert.equal(r.table.entries.length, 1);
});

test("multi-byte index: 1f 1a -> never-indexed name reference index 31", () => {
  // 0001 prefix, index 15+26=41? 0x1f => prefix max 15, next byte 0x1a=26 => index 41 (if-range)
  const r = dec("1f 1a 01 76");
  assert.equal(r.fields[0].name.toString(), "if-none-match");
  assert.equal(r.fields[0].value.toString(), "v");
  assert.equal(r.fields[0].explanation.representation, "literal_never_indexed");
  assert.equal(r.fields[0].explanation.index, 41);
});

test("never indexed does not insert into table", () => {
  const r = dec("10 01 6e 01 76"); // never indexed, literal name n, value v
  assert.equal(r.fields[0].explanation.representation, "literal_never_indexed");
  assert.equal(r.table.entries.length, 0);
});

test("oversized entry empties table and is not inserted", () => {
  const r1 = dec("82 41 03 66 6f 6f"); // inserts :authority foo (45)
  const small = { entries: r1.table.entries, capacity: 50, size: r1.table.size };
  // insert entry of size 60: name 10 bytes + value 15 bytes + 32 = 57 > 50
  const name = Buffer.alloc(10, 0x6e);
  const value = Buffer.alloc(15, 0x76);
  const block = Buffer.concat([Buffer.from([0x40, 0x0a]), name, Buffer.from([0x0f]), value]);
  const r2 = decodeBlock(block, small as any, OPTS);
  assert.equal(r2.table.entries.length, 0);
  assert.equal(r2.table.size, 0);
  assert.ok(r2.fields[0].explanation.tableChanges[0].includes("exceeds capacity"));
});

test("eviction of oldest entries when capacity exceeded", () => {
  // capacity 100; insert two 45-byte entries then a third -> oldest evicted
  const t = emptyTable(100);
  const r1 = dec("41 03 61 61 61", t); // :authority=aaa (45)
  const r2 = dec("41 03 62 62 62", r1.table);
  const r3 = dec("41 03 63 63 63", r2.table);
  assert.equal(r3.table.entries.length, 2);
  assert.equal(r3.table.size, 90);
  assert.equal(r3.table.entries[0].value.toString(), "ccc"); // newest first
  assert.equal(r3.table.entries[1].value.toString(), "bbb");
});

test("truncated string reports byte offset and does not commit", () => {
  const t = emptyTable(4096);
  assert.throws(() => dec("41 03 66 6f", t), (e: any) => e.code === "TRUNCATED" && typeof e.byteOffset === "number");
  assert.equal(t.entries.length, 0); // input table untouched
});

test("truncated block at end rolls back whole block", () => {
  const t = emptyTable(4096);
  // valid insert then truncated field: 41 03 66 6f 6f 82 82? use 0x40 then nothing
  assert.throws(() => dec("41 03 66 6f 6f 40 05 61", t), (e: any) => e.code === "TRUNCATED");
  assert.equal(t.entries.length, 0);
});

test("huffman flag is reported, not misread", () => {
  assert.throws(() => dec("41 83 00 00 00"), (e: any) => e.code === "HUFFMAN_UNSUPPORTED" && e.byteOffset === 1);
});

test("size update after fields is rejected", () => {
  assert.throws(() => dec("82 20"), (e: any) => e.code === "SIZE_UPDATE_NOT_AT_START" && e.byteOffset === 1);
});

test("size update above allowed ceiling is rejected", () => {
  assert.throws(() => dec("3f e1 1f", emptyTable(4096), { maxAllowedCapacity: 100 }),
    (e: any) => e.code === "SIZE_UPDATE_TOO_LARGE" && e.byteOffset === 0);
});

test("integer overflow is reported", () => {
  const many = Buffer.concat([Buffer.from([0x3f]), Buffer.alloc(20, 0xff)]);
  assert.throws(
    () => decodeBlock(many, emptyTable(4096), OPTS),
    (e: any) => e.code === "INT_OVERFLOW"
  );
});

test("decodeInteger basic cases", () => {
  const lim = DEFAULT_LIMITS;
  assert.deepEqual(decodeInteger(Buffer.from([0x0a]), 0, 5, lim), { value: 10, offset: 1 });
  // 1337 with 5-bit prefix (RFC example): 1f 9a 0a
  assert.deepEqual(decodeInteger(Buffer.from([0x1f, 0x9a, 0x0a]), 0, 5, lim), { value: 1337, offset: 3 });
});

test("empty name and empty value are allowed", () => {
  const r = dec("40 00 00"); // literal inc, empty name, empty value
  assert.equal(r.fields[0].name.length, 0);
  assert.equal(r.fields[0].value.length, 0);
  assert.equal(r.table.entries.length, 1);
  assert.equal(entrySize(r.table.entries[0]), 32);
});

test("block size limit", () => {
  assert.throws(
    () => decodeBlock(Buffer.alloc(100), emptyTable(4096), { ...OPTS, limits: { maxBlockBytes: 10 } }),
    (e: any) => e.code === "LIMIT_EXCEEDED"
  );
});

test("cumulative decoded byte limit", () => {
  assert.throws(
    () => decodeBlock(Buffer.from([0x82]), emptyTable(4096), { ...OPTS, decodedBytesSoFar: DEFAULT_LIMITS.maxDecodedBytesTotal }),
    (e: any) => e.code === "LIMIT_EXCEEDED"
  );
});

test("field count limit", () => {
  const block = Buffer.alloc(50, 0x82);
  assert.throws(
    () => decodeBlock(block, emptyTable(4096), { ...OPTS, limits: { maxFields: 10 } }),
    (e: any) => e.code === "LIMIT_EXCEEDED"
  );
});

