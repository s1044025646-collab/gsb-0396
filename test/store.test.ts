import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store";

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hpack-")), "test.db");
}

test("restart continuation: state persists across Store instances", () => {
  const db = tmpDb();
  const s1 = new Store(db);
  const ctx = s1.createContext({ maxAllowedCapacity: 4096 });
  s1.submitBlock(ctx.id, "hex", "82 41 03 66 6f 6f");
  s1.close();

  const s2 = new Store(db);
  const r = s2.submitBlock(ctx.id, "hex", "BE");
  assert.equal(r.fields[0].nameText, ":authority");
  assert.equal(r.fields[0].valueText, "foo");
  assert.equal(r.seq, 2);
  s2.close();
});

test("failed block leaves no success record and table unchanged", () => {
  const db = tmpDb();
  const s = new Store(db);
  const ctx = s.createContext({});
  s.submitBlock(ctx.id, "hex", "82 41 03 66 6f 6f");
  assert.throws(() => s.submitBlock(ctx.id, "hex", "41 03 66 6f"), (e: any) => e.code === "TRUNCATED");
  const after = s.getContext(ctx.id);
  assert.equal(after.currentVersion, 1);
  assert.equal(s.listBlocks(ctx.id).length, 1);
  assert.equal(s.tableSnapshot(ctx.id).entries.length, 1);
  // can resubmit a different block from the same snapshot
  const r = s.submitBlock(ctx.id, "hex", "BE");
  assert.equal(r.seq, 2);
  s.close();
});

test("old snapshots are immutable after later evictions", () => {
  const db = tmpDb();
  const s = new Store(db);
  const ctx = s.createContext({ maxAllowedCapacity: 4096 });
  s.submitBlock(ctx.id, "hex", "82 41 03 66 6f 6f"); // v1: :authority=foo
  s.submitBlock(ctx.id, "hex", "20"); // v2: capacity 0, evicted
  const v1 = s.tableSnapshot(ctx.id, 1);
  assert.equal(v1.entries.length, 1);
  assert.equal(v1.entries[0].valueText, "foo");
  const v2 = s.tableSnapshot(ctx.id, 2);
  assert.equal(v2.entries.length, 0);
  s.close();
});

test("contexts are isolated", () => {
  const db = tmpDb();
  const s = new Store(db);
  const a = s.createContext({});
  const b = s.createContext({});
  s.submitBlock(a.id, "hex", "82 41 03 66 6f 6f");
  assert.throws(() => s.submitBlock(b.id, "hex", "BE"), /out of range/);
  assert.equal(s.tableSnapshot(b.id).entries.length, 0);
  s.close();
});

test("fork copies state but diverges independently", () => {
  const db = tmpDb();
  const s = new Store(db);
  const a = s.createContext({});
  s.submitBlock(a.id, "hex", "82 41 03 66 6f 6f");
  const fork = s.forkContext(a.id);
  const r = s.submitBlock(fork.id, "hex", "BE");
  assert.equal(r.fields[0].valueText, "foo");
  // original unaffected by fork's later blocks
  s.submitBlock(fork.id, "hex", "20");
  assert.equal(s.tableSnapshot(a.id).entries.length, 1);
  assert.equal(s.tableSnapshot(fork.id).entries.length, 0);
  s.close();
});

test("export/import roundtrip validates snapshot", () => {
  const db = tmpDb();
  const s = new Store(db);
  const a = s.createContext({ maxAllowedCapacity: 100 });
  s.submitBlock(a.id, "hex", "82 41 03 66 6f 6f");
  const exp = s.exportContext(a.id);
  const imp = s.importContext(exp);
  assert.equal(s.tableSnapshot(imp.id).entries.length, 1);
  // tampered snapshot: entry size exceeds capacity
  const bad = JSON.parse(JSON.stringify(exp));
  bad.table.capacity = 10;
  assert.throws(() => s.importContext(bad), /exceeds/);
  s.close();
});

test("base64 input works", () => {
  const db = tmpDb();
  const s = new Store(db);
  const ctx = s.createContext({});
  const r = s.submitBlock(ctx.id, "base64", Buffer.from("824103666f6f", "hex").toString("base64"));
  assert.equal(r.fields[1].valueText, "foo");
  s.close();
});

test("invalid hex rejected with BAD_INPUT", () => {
  const db = tmpDb();
  const s = new Store(db);
  const ctx = s.createContext({});
  assert.throws(() => s.submitBlock(ctx.id, "hex", "zz"), (e: any) => e.code === "BAD_INPUT");
  s.close();
});

