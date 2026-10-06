import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DynamicTable, Limits, DEFAULT_LIMITS, entrySize } from "./hpack";
import { HpackError } from "./errors";

export interface DynEntryRow {
  nameHex: string;
  valueHex: string;
}

export interface ContextRow {
  id: string;
  name: string;
  maxCapacity: number;
  dynCapacity: number;
  dynEntries: DynEntryRow[];
  totalDecoded: number;
  limits: Limits;
  createdAt: string;
}

export interface BlockRow {
  id: number;
  contextId: string;
  seq: number;
  encoding: string;
  rawHex: string;
  ok: boolean;
  error: unknown | null;
  result: unknown | null;
  inputTable: DynEntryRow[];
  inputDynCapacity: number;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS contexts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        max_capacity INTEGER NOT NULL,
        dyn_capacity INTEGER NOT NULL,
        dyn_entries TEXT NOT NULL,
        total_decoded INTEGER NOT NULL DEFAULT 0,
        limits TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL REFERENCES contexts(id),
        seq INTEGER NOT NULL,
        encoding TEXT NOT NULL,
        raw_hex TEXT NOT NULL,
        ok INTEGER NOT NULL,
        error TEXT,
        result TEXT,
        input_table TEXT NOT NULL,
        input_dyn_capacity INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_blocks_ctx ON blocks(context_id, seq);
    `);
  }

  close() {
    this.db.close();
  }

  private rowToContext(r: any): ContextRow {
    return {
      id: r.id,
      name: r.name,
      maxCapacity: r.max_capacity,
      dynCapacity: r.dyn_capacity,
      dynEntries: JSON.parse(r.dyn_entries),
      totalDecoded: r.total_decoded,
      limits: { ...DEFAULT_LIMITS, ...JSON.parse(r.limits) },
      createdAt: r.created_at,
    };
  }

  createContext(name: string, maxCapacity: number, limits?: Partial<Limits>): ContextRow {
    if (!Number.isInteger(maxCapacity) || maxCapacity < 0) {
      throw new HpackError("INVALID_INPUT", "maxCapacity 必须是非负整数");
    }
    const id = randomUUID();
    const merged = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
    this.db
      .prepare(
        "INSERT INTO contexts (id, name, max_capacity, dyn_capacity, dyn_entries, total_decoded, limits, created_at) VALUES (?,?,?,?,?,0,?,?)"
      )
      .run(id, name, maxCapacity, maxCapacity, "[]", JSON.stringify(merged), new Date().toISOString());
    return this.getContext(id);
  }

  getContext(id: string): ContextRow {
    const r = this.db.prepare("SELECT * FROM contexts WHERE id = ?").get(id);
    if (!r) throw new HpackError("NOT_FOUND", `上下文不存在: ${id}`);
    return this.rowToContext(r);
  }

  listContexts(): ContextRow[] {
    return (this.db.prepare("SELECT * FROM contexts ORDER BY created_at").all() as any[]).map((r) =>
      this.rowToContext(r)
    );
  }

  setMaxCapacity(id: string, maxCapacity: number): ContextRow {
    if (!Number.isInteger(maxCapacity) || maxCapacity < 0) {
      throw new HpackError("INVALID_INPUT", "maxCapacity 必须是非负整数");
    }
    this.getContext(id);
    this.db
      .prepare("UPDATE contexts SET max_capacity = ?, dyn_capacity = MIN(dyn_capacity, ?) WHERE id = ?")
      .run(maxCapacity, maxCapacity, id);
    return this.getContext(id);
  }

  tableFromContext(ctx: ContextRow): DynamicTable {
    const t = new DynamicTable(ctx.dynCapacity);
    t.entries = ctx.dynEntries.map((e) => {
      const name = Buffer.from(e.nameHex, "hex");
      const value = Buffer.from(e.valueHex, "hex");
      return { name, value, size: entrySize(name, value) };
    });
    t.size = t.entries.reduce((s, e) => s + e.size, 0);
    return t;
  }

  nextSeq(contextId: string): number {
    const r = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM blocks WHERE context_id = ?")
      .get(contextId) as any;
    return r.seq;
  }

  commitBlock(
    contextId: string,
    encoding: string,
    raw: Buffer,
    inputTable: DynEntryRow[],
    inputDynCapacity: number,
    result: unknown,
    newTable: DynamicTable,
    bytesDecoded: number
  ): BlockRow {
    const seq = this.nextSeq(contextId);
    const entries: DynEntryRow[] = newTable.entries.map((e) => ({
      nameHex: e.name.toString("hex"),
      valueHex: e.value.toString("hex"),
    }));
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO blocks (context_id, seq, encoding, raw_hex, ok, error, result, input_table, input_dyn_capacity, created_at) VALUES (?,?,?,?,1,NULL,?,?,?,?)"
        )
        .run(
          contextId,
          seq,
          encoding,
          raw.toString("hex"),
          JSON.stringify(result),
          JSON.stringify(inputTable),
          inputDynCapacity,
          new Date().toISOString()
        );
      this.db
        .prepare("UPDATE contexts SET dyn_capacity = ?, dyn_entries = ?, total_decoded = total_decoded + ? WHERE id = ?")
        .run(newTable.capacity, JSON.stringify(entries), bytesDecoded, contextId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getBlock(contextId, seq);
  }

  recordFailedBlock(
    contextId: string,
    encoding: string,
    raw: Buffer,
    inputTable: DynEntryRow[],
    inputDynCapacity: number,
    error: unknown
  ): BlockRow {
    const seq = this.nextSeq(contextId);
    this.db
      .prepare(
        "INSERT INTO blocks (context_id, seq, encoding, raw_hex, ok, error, result, input_table, input_dyn_capacity, created_at) VALUES (?,?,?,?,0,?,NULL,?,?,?)"
      )
      .run(
        contextId,
        seq,
        encoding,
        raw.toString("hex"),
        JSON.stringify(error),
        JSON.stringify(inputTable),
        inputDynCapacity,
        new Date().toISOString()
      );
    return this.getBlock(contextId, seq);
  }

  getBlock(contextId: string, seq: number): BlockRow {
    const r = this.db.prepare("SELECT * FROM blocks WHERE context_id = ? AND seq = ?").get(contextId, seq) as any;
    if (!r) throw new HpackError("NOT_FOUND", `块不存在: ${contextId}#${seq}`);
    return this.rowToBlock(r);
  }

  listBlocks(contextId: string): BlockRow[] {
    return (this.db.prepare("SELECT * FROM blocks WHERE context_id = ? ORDER BY seq").all(contextId) as any[]).map(
      (r) => this.rowToBlock(r)
    );
  }

  private rowToBlock(r: any): BlockRow {
    return {
      id: r.id,
      contextId: r.context_id,
      seq: r.seq,
      encoding: r.encoding,
      rawHex: r.raw_hex,
      ok: !!r.ok,
      error: r.error ? JSON.parse(r.error) : null,
      result: r.result ? JSON.parse(r.result) : null,
      inputTable: JSON.parse(r.input_table),
      inputDynCapacity: r.input_dyn_capacity,
      createdAt: r.created_at,
    };
  }

  deriveContext(sourceId: string, name?: string): ContextRow {
    const src = this.getContext(sourceId);
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO contexts (id, name, max_capacity, dyn_capacity, dyn_entries, total_decoded, limits, created_at) VALUES (?,?,?,?,?,0,?,?)"
      )
      .run(
        id,
        name ?? `${src.name}-derived`,
        src.maxCapacity,
        src.dynCapacity,
        JSON.stringify(src.dynEntries),
        JSON.stringify(src.limits),
        new Date().toISOString()
      );
    return this.getContext(id);
  }

  exportContext(id: string) {
    const ctx = this.getContext(id);
    return {
      format: "hpack-analyzer-snapshot-v1",
      name: ctx.name,
      maxCapacity: ctx.maxCapacity,
      dynCapacity: ctx.dynCapacity,
      dynEntries: ctx.dynEntries,
      limits: ctx.limits,
    };
  }

  importContext(snapshot: any, name?: string): ContextRow {
    if (!snapshot || snapshot.format !== "hpack-analyzer-snapshot-v1") {
      throw new HpackError("INVALID_INPUT", "快照格式无效");
    }
    const { maxCapacity, dynCapacity, dynEntries } = snapshot;
    if (!Number.isInteger(maxCapacity) || maxCapacity < 0) {
      throw new HpackError("INVALID_INPUT", "快照 maxCapacity 非法");
    }
    if (!Number.isInteger(dynCapacity) || dynCapacity < 0 || dynCapacity > maxCapacity) {
      throw new HpackError("INVALID_INPUT", "快照 dynCapacity 非法或超过允许上限");
    }
    if (!Array.isArray(dynEntries)) {
      throw new HpackError("INVALID_INPUT", "快照 dynEntries 非法");
    }
    let total = 0;
    for (const e of dynEntries) {
      const nameHex = typeof e?.nameHex === "string" ? e.nameHex : "";
      const valueHex = typeof e?.valueHex === "string" ? e.valueHex : "";
      if (!/^[0-9a-f]*$/.test(nameHex) || !/^[0-9a-f]*$/.test(valueHex)) {
        throw new HpackError("INVALID_INPUT", "快照条目包含非法十六进制");
      }
      total += entrySize(Buffer.from(nameHex, "hex"), Buffer.from(valueHex, "hex"));
    }
    if (total > dynCapacity) {
      throw new HpackError("INVALID_INPUT", `快照条目总尺寸 ${total} 超过动态表容量 ${dynCapacity}`);
    }
    const ctx = this.createContext(name ?? snapshot.name ?? "imported", maxCapacity, snapshot.limits);
    this.db
      .prepare("UPDATE contexts SET dyn_capacity = ?, dyn_entries = ? WHERE id = ?")
      .run(dynCapacity, JSON.stringify(dynEntries), ctx.id);
    return this.getContext(ctx.id);
  }
}

export function defaultDbPath(): string {
  const dir = process.env.HPACK_DATA_DIR ?? path.join(process.cwd(), "data");
  return path.join(dir, "hpack.db");
}
