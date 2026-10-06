import { test } from "node:test";
import assert from "node:assert/strict";
import { DynamicTable, decodeBlock, decodeInteger, DEFAULT_LIMITS, entrySize } from "../src/hpack";
import { STATIC_TABLE_SIZE } from "../src/staticTable";

const limits = DEFAULT_LIMITS;
const opts = { maxAllowedCapacity: 4096, limits };

function hex(s: string): Buffer {
  return Buffer.from(s.replace(/\s/g, ""), "hex");
}

test("静态表边界: 索引 1 = :authority, 索引 61 = www-authenticate, 索引 62 越界", () => {
  const t = new DynamicTable(4096);
  const r1 = decodeBlock(hex("81"), t, opts);
  assert.equal(r1.fields[0].name.toString(), ":authority");
  const r61 = decodeBlock(hex("bd"), new DynamicTable(4096), opts);
  assert.equal(r61.fields[0].name.toString(), "www-authenticate");
  assert.throws(
    () => decodeBlock(hex("be"), new DynamicTable(4096), opts),
    (e: any) => {
      assert.equal(e.code, "INDEX_OUT_OF_RANGE");
      return true;
    }
  );
  assert.equal(STATIC_TABLE_SIZE, 61);
});

test("演示夹具: 82 41 03 66 6f 6f → :method=GET, :authority=foo 插入尺寸 45", () => {
  const t = new DynamicTable(4096);
  const r = decodeBlock(hex("82 41 03 66 6f 6f"), t, opts);
  assert.equal(r.fields.length, 2);
  assert.equal(r.fields[0].name.toString(), ":method");
  assert.equal(r.fields[0].value.toString(), "GET");
  assert.equal(r.fields[0].kind, "indexed");
  assert.equal(r.fields[0].byteStart, 0);
  assert.equal(r.fields[0].byteEnd, 1);
  assert.equal(r.fields[1].name.toString(), ":authority");
  assert.equal(r.fields[1].value.toString(), "foo");
  assert.equal(r.fields[1].kind, "literal_incremental");
  assert.equal(r.fields[1].byteStart, 1);
  assert.equal(r.fields[1].byteEnd, 6);
  assert.equal(r.table.entries.length, 1);
  assert.equal(r.table.entries[0].size, 45);
  assert.equal(entrySize(Buffer.from(":authority"), Buffer.from("foo")), 45);
});

test("演示夹具: 下一块 BE 引用索引 62 得到同一 authority", () => {
  const t = new DynamicTable(4096);
  const r1 = decodeBlock(hex("82 41 03 66 6f 6f"), t, opts);
  const r2 = decodeBlock(hex("be"), r1.table, opts);
  assert.equal(r2.fields[0].index, 62);
  assert.equal(r2.fields[0].name.toString(), ":authority");
  assert.equal(r2.fields[0].value.toString(), "foo");
});

test("多字节整数与动态表索引移动", () => {
  const t = new DynamicTable(4096);
  let r = decodeBlock(hex("41 03 66 6f 6f"), t, opts);
  r = decodeBlock(hex("41 03 62 61 72"), r.table, opts);
  const r63 = decodeBlock(hex("bf"), r.table, opts);
  assert.equal(r63.fields[0].value.toString(), "foo");
  const dec = decodeInteger(Buffer.from([0x3f, 0xe1, 0x00]), 0, 5, 8);
  assert.equal(dec.value, 31 + 97);
  assert.equal(dec.bytesRead, 3);
});

test("整数溢出与截断定位字节偏移", () => {
  assert.throws(
    () => decodeInteger(Buffer.from([0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0, 5, 8),
    (e: any) => {
      assert.equal(e.code, "INTEGER_OVERFLOW");
      assert.equal(e.offset, 0);
      return true;
    }
  );
  assert.throws(
    () => decodeInteger(Buffer.from([0x1f, 0x80]), 0, 5, 8),
    (e: any) => {
      assert.equal(e.code, "TRUNCATED");
      assert.equal(e.offset, 2);
      return true;
    }
  );
});

test("重复名称保留顺序，不合并", () => {
  const t = new DynamicTable(4096);
  const r = decodeBlock(hex("00 01 61 01 78 00 01 61 01 79"), t, opts);
  assert.equal(r.fields.length, 2);
  assert.equal(r.fields[0].name.toString(), "a");
  assert.equal(r.fields[0].value.toString(), "x");
  assert.equal(r.fields[1].name.toString(), "a");
  assert.equal(r.fields[1].value.toString(), "y");
});

test("无索引与永不索引字面量不入表", () => {
  const t = new DynamicTable(4096);
  const r = decodeBlock(hex("00 01 61 01 78 10 01 62 01 79"), t, opts);
  assert.equal(r.fields[0].kind, "literal_without_indexing");
  assert.equal(r.fields[1].kind, "literal_never");
  assert.equal(r.table.entries.length, 0);
});

test("淘汰: 容量只够两条时插入第三条挤掉最旧", () => {
  const t = new DynamicTable(90);
  let r = decodeBlock(hex("40 01 61 01 31"), t, opts);
  r = decodeBlock(hex("40 01 62 01 32"), r.table, opts);
  r = decodeBlock(hex("40 01 63 01 33"), r.table, opts);
  assert.equal(r.table.entries.length, 2);
  assert.equal(r.table.entries[0].name.toString(), "c");
  assert.equal(r.table.entries[1].name.toString(), "b");
  assert.ok(r.events.some((e) => e.type === "evict"));
});

test("单条目大于容量: 清空表且不插入", () => {
  const t = new DynamicTable(40);
  let r = decodeBlock(hex("40 01 61 01 31"), t, opts);
  assert.equal(r.table.entries.length, 1);
  const big = Buffer.concat([Buffer.from([0x40, 0x01, 0x62, 0x64]), Buffer.alloc(100, 0x7a)]);
  r = decodeBlock(big, r.table, opts);
  assert.equal(r.table.entries.length, 0);
  assert.equal(r.table.size, 0);
  assert.ok(r.events.some((e) => e.type === "clear"));
});

test("大小更新: 只允许在块开头且不超过允许上限", () => {
  const t = new DynamicTable(4096);
  const r = decodeBlock(hex("3f e1 00 82"), t, { maxAllowedCapacity: 128, limits });
  assert.equal(r.table.capacity, 128);
  assert.equal(r.fields.length, 1);
  assert.throws(
    () => decodeBlock(hex("3f e2 00"), new DynamicTable(4096), { maxAllowedCapacity: 128, limits }),
    (e: any) => {
      assert.equal(e.code, "SIZE_UPDATE_TOO_LARGE");
      assert.equal(e.offset, 0);
      return true;
    }
  );
  assert.throws(
    () => decodeBlock(hex("82 20"), new DynamicTable(4096), opts),
    (e: any) => {
      assert.equal(e.code, "SIZE_UPDATE_NOT_AT_START");
      assert.equal(e.offset, 1);
      return true;
    }
  );
});

test("Huffman 标记明确报不支持", () => {
  assert.throws(
    () => decodeBlock(hex("41 83 00 00 00"), new DynamicTable(4096), opts),
    (e: any) => {
      assert.equal(e.code, "HUFFMAN_UNSUPPORTED");
      assert.equal(e.offset, 1);
      return true;
    }
  );
});

test("块末截断: 字符串声明长度超过剩余", () => {
  assert.throws(
    () => decodeBlock(hex("41 05 66 6f"), new DynamicTable(4096), opts),
    (e: any) => {
      assert.equal(e.code, "TRUNCATED");
      return true;
    }
  );
});

test("名称可引用表中名称，值从载荷读取", () => {
  const t = new DynamicTable(4096);
  const r = decodeBlock(hex("42 03 58 59 5a"), t, opts);
  assert.equal(r.fields[0].name.toString(), ":method");
  assert.equal(r.fields[0].value.toString(), "XYZ");
  assert.equal(r.fields[0].nameIndex, 2);
});

test("空名称与空值合法", () => {
  const t = new DynamicTable(4096);
  const r = decodeBlock(hex("40 00 00"), t, opts);
  assert.equal(r.fields[0].name.length, 0);
  assert.equal(r.fields[0].value.length, 0);
  assert.equal(r.table.entries[0].size, 32);
});

test("非 UTF-8 载荷保留原始字节", () => {
  const t = new DynamicTable(4096);
  const r = decodeBlock(hex("40 01 61 02 ff fe"), t, opts);
  assert.deepEqual([...r.fields[0].value], [0xff, 0xfe]);
});

test("字段数与块大小限制", () => {
  const t = new DynamicTable(4096);
  assert.throws(
    () => decodeBlock(hex("82 82"), t, { maxAllowedCapacity: 4096, limits: { ...limits, maxFields: 1 } }),
    (e: any) => {
      assert.equal(e.code, "LIMIT_EXCEEDED");
      return true;
    }
  );
  assert.throws(
    () => decodeBlock(hex("82 82 82"), t, { maxAllowedCapacity: 4096, limits: { ...limits, maxBlockBytes: 2 } }),
    (e: any) => {
      assert.equal(e.code, "LIMIT_EXCEEDED");
      return true;
    }
  );
});
