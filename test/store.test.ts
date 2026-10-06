import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store";
import { submitBlock, tableSnapshot } from "../src/service";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hpack-")), "test.db");
}

test("失败块回滚: 截断块不提交半张动态表，可从上一快照继续", () => {
  const store = new Store(tmpDb());
  const ctx = store.createContext("t", 4096);
  const ok1 = submitBlock(store, ctx.id, "82 41 03 66 6f 6f", "hex");
  assert.equal(ok1.ok, true);
  // 这个块先插入一条新条目，随后截断 → 整体失败，表状态不变
  const bad = submitBlock(store, ctx.id, "40 01 78 01 79 41 05 66 6f", "hex");
  assert.equal(bad.ok, false);
  assert.equal((bad.error as any).code, "TRUNCATED");
  const snap = tableSnapshot(store, ctx.id);
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0].value, "foo");
  // 从上一快照继续: BE 仍应解析为 :authority=foo
  const ok2 = submitBlock(store, ctx.id, "be", "hex");
  assert.equal(ok2.ok, true);
  assert.equal(ok2.fields![0].value, "foo");
  store.close();
});

test("重启后续解码: 关闭并重开数据库后动态表保持", () => {
  const db = tmpDb();
  let store = new Store(db);
  const ctx = store.createContext("t", 4096);
  submitBlock(store, ctx.id, "82 41 03 66 6f 6f", "hex");
  store.close();
  store = new Store(db);
  const r = submitBlock(store, ctx.id, "be", "hex");
  assert.equal(r.ok, true);
  assert.equal(r.fields![0].name, ":authority");
  assert.equal(r.fields![0].value, "foo");
  store.close();
});

test("两个上下文互不共享动态表", () => {
  const store = new Store(tmpDb());
  const a = store.createContext("a", 4096);
  const b = store.createContext("b", 4096);
  submitBlock(store, a.id, "82 41 03 66 6f 6f", "hex");
  const rb = submitBlock(store, b.id, "be", "hex");
  assert.equal(rb.ok, false);
  assert.equal((rb.error as any).code, "INDEX_OUT_OF_RANGE");
  store.close();
});

test("容量缩小到 0 后引用失败", () => {
  const store = new Store(tmpDb());
  const ctx = store.createContext("t", 4096);
  submitBlock(store, ctx.id, "82 41 03 66 6f 6f", "hex");
  store.setMaxCapacity(ctx.id, 0);
  const upd = submitBlock(store, ctx.id, "20", "hex"); // 大小更新到 0
  assert.equal(upd.ok, true);
  assert.equal(tableSnapshot(store, ctx.id).entries.length, 0);
  const r = submitBlock(store, ctx.id, "be", "hex");
  assert.equal(r.ok, false);
  assert.equal((r.error as any).code, "INDEX_OUT_OF_RANGE");
  store.close();
});

test("旧块记录保留输入表版本快照，不随后续淘汰变化", () => {
  const store = new Store(tmpDb());
  const ctx = store.createContext("t", 68); // 两条 34 字节条目即满
  submitBlock(store, ctx.id, "40 01 61 01 31", "hex");
  submitBlock(store, ctx.id, "40 01 62 01 32", "hex");
  submitBlock(store, ctx.id, "40 01 63 01 33", "hex"); // 挤掉 a
  const blocks = store.listBlocks(ctx.id);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].inputTable.length, 0);
  assert.equal(blocks[1].inputTable.length, 1);
  assert.equal(Buffer.from(blocks[1].inputTable[0].nameHex, "hex").toString(), "a");
  assert.equal(blocks[2].inputTable.length, 2);
  // 当前表只剩 c, b
  const snap = tableSnapshot(store, ctx.id);
  assert.deepEqual(snap.entries.map((e: any) => e.name), ["c", "b"]);
  store.close();
});

test("派生上下文复制表状态后独立演化", () => {
  const store = new Store(tmpDb());
  const src = store.createContext("src", 4096);
  submitBlock(store, src.id, "82 41 03 66 6f 6f", "hex");
  const derived = store.deriveContext(src.id, "d");
  const r = submitBlock(store, derived.id, "be", "hex");
  assert.equal(r.ok, true);
  assert.equal(r.fields![0].value, "foo");
  // 派生上下文再插入新条目，不影响源上下文
  submitBlock(store, derived.id, "40 01 7a 01 77", "hex");
  assert.equal(tableSnapshot(store, derived.id).entries.length, 2);
  assert.equal(tableSnapshot(store, src.id).entries.length, 1);
  store.close();
});

test("导出与导入: 校验容量与条目尺寸", () => {
  const store = new Store(tmpDb());
  const ctx = store.createContext("t", 4096);
  submitBlock(store, ctx.id, "82 41 03 66 6f 6f", "hex");
  const snap = store.exportContext(ctx.id);
  const imported = store.importContext(snap, "imp");
  assert.equal(tableSnapshot(store, imported.id).entries.length, 1);
  // 篡改: 条目尺寸超过容量
  const bad = { ...snap, dynCapacity: 10 };
  assert.throws(() => store.importContext(bad), /超过动态表容量/);
  // 篡改: dynCapacity 超过 maxCapacity
  assert.throws(() => store.importContext({ ...snap, maxCapacity: 1 }), /dynCapacity/);
  store.close();
});

test("累计解码字节上限", () => {
  const store = new Store(tmpDb());
  const ctx = store.createContext("t", 4096, { maxTotalDecodedBytes: 10 });
  const r1 = submitBlock(store, ctx.id, "82 41 03 66 6f 6f", "hex");
  assert.equal(r1.ok, true);
  assert.throws(() => submitBlock(store, ctx.id, "82 41 03 66 6f 6f", "hex"), /累计解码字节/);
  store.close();
});

test("base64 输入与非法输入校验", () => {
  const store = new Store(tmpDb());
  const ctx = store.createContext("t", 4096);
  const b64 = Buffer.from("82 41 03 66 6f 6f".replace(/ /g, ""), "hex").toString("base64");
  const r = submitBlock(store, ctx.id, b64, "base64");
  assert.equal(r.ok, true);
  assert.equal(r.fields![1].value, "foo");
  assert.throws(() => submitBlock(store, ctx.id, "zz", "hex"), /十六进制/);
  assert.throws(() => submitBlock(store, ctx.id, "!!!", "base64"), /Base64/);
  store.close();
});
