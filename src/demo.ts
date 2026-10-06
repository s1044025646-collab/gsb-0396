import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./store";
import { submitBlock, tableSnapshot } from "./service";

export async function runDemo() {
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "demo.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {}
  }

  console.log("== 演示 1: 82 41 03 66 6f 6f → :method=GET, :authority=foo（插入动态表，尺寸 45）==");
  let store = new Store(dbPath);
  const ctx = store.createContext("demo", 4096);
  const r1 = submitBlock(store, ctx.id, "82 41 03 66 6f 6f", "hex");
  console.log(JSON.stringify(r1.fields, null, 2));
  console.log("动态表:", JSON.stringify(tableSnapshot(store, ctx.id).entries));
  store.close();

  console.log("\n== 演示 2: 重启后（重新打开数据库）提交 BE → 索引 62 引用 :authority=foo ==");
  store = new Store(dbPath);
  const r2 = submitBlock(store, ctx.id, "be", "hex");
  console.log(JSON.stringify(r2.fields, null, 2));

  console.log("\n== 演示 3: 允许容量缩小到 0 后，BE 引用应失败（表已清空）==");
  store.setMaxCapacity(ctx.id, 0);
  submitBlock(store, ctx.id, "20", "hex"); // 动态表大小更新到 0（合法，清空表）
  const r3 = submitBlock(store, ctx.id, "be", "hex");
  console.log("ok =", r3.ok, "error =", JSON.stringify(r3.error));

  console.log("\n== 演示 4: 两个上下文隔离 ==");
  const a = store.createContext("A", 4096);
  const b = store.createContext("B", 4096);
  submitBlock(store, a.id, "82 41 03 66 6f 6f", "hex");
  const rb = submitBlock(store, b.id, "be", "hex");
  console.log("上下文 B 引用索引 62: ok =", rb.ok, "error =", JSON.stringify(rb.error));
  store.close();
  console.log("\n演示完成，数据库位于", dbPath);
}

if (require.main === module) {
  runDemo();
}
