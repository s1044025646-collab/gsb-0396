// Built-in demonstration: decodes the sample blocks from the README.
import * as fs from "node:fs";
import { Store } from "./store";

export async function runDemo(dbPath: string): Promise<void> {
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  const store = new Store(dbPath);
  try {
    const ctx = store.createContext({ maxAllowedCapacity: 4096 });
    console.log("context: " + ctx.id);

    console.log("\n[1] submit block 82 41 03 66 6f 6f");
    const r1 = store.submitBlock(ctx.id, "hex", "82 41 03 66 6f 6f");
    for (const f of r1.fields) {
      console.log("  " + f.nameText + " = " + f.valueText + "  (" + f.explanation.representation + ", bytes " + f.explanation.byteRange + ")");
    }
    console.log("  table: size=" + r1.table.size + "/" + r1.table.capacity + " entries=" + JSON.stringify(r1.table.entries.map((e: any) => [e.index, e.nameText, e.valueText, e.size])));

    console.log("\n[2] submit block BE (indexed, dynamic index 62)");
    const r2 = store.submitBlock(ctx.id, "hex", "BE");
    for (const f of r2.fields) {
      console.log("  " + f.nameText + " = " + f.valueText + "  (index " + f.explanation.index + ")");
    }

    console.log("\n[3] shrink capacity to 0 via size update 20, then BE must fail");
    const r3 = store.submitBlock(ctx.id, "hex", "20");
    console.log("  size update applied: " + JSON.stringify(r3.sizeUpdates));
    try {
      store.submitBlock(ctx.id, "hex", "BE");
      console.log("  ERROR: BE unexpectedly succeeded");
    } catch (e: any) {
      console.log("  BE failed as expected: " + e.code + " @ byte " + e.byteOffset + ": " + e.message);
    }

    console.log("\n[4] restart (reopen store) and continue with next block");
    store.close();
    const store2 = new Store(dbPath);
    const t = store2.tableSnapshot(ctx.id);
    console.log("  table after restart: size=" + t.size + "/" + t.capacity + " entries=" + t.entries.length);
    const r4 = store2.submitBlock(ctx.id, "hex", "82");
    console.log("  decoded after restart: " + r4.fields[0].nameText + " = " + r4.fields[0].valueText);
    store2.close();
  } catch (e) {
    try { store.close(); } catch { /* ignore */ }
    throw e;
  }
}
