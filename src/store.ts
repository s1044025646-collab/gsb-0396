// SQLite persistence layer using node:sqlite (built into Node >= 22).
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  decodeBlock,
  emptyTable,
  entrySize,
  HpackError,
  Limits,
  DEFAULT_LIMITS,
  TableEntry,
  utf8Text,
} from "./hpack";

export interface ContextRecord {
  id: string;
  maxAllowedCapacity: number;
  limits: Limits;
  decodedBytes: number;
  currentVersion: number;
  createdAt: string;
}

export interface StoredEntry {
  nameHex: string;
  valueHex: string;
  nameText?: string;
  valueText?: string;
  size: number;
}

export class StoreError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS contexts (
        id TEXT PRIMARY KEY,
        max_allowed_capacity INTEGER NOT NULL,
        limits_json TEXT NOT NULL,
        decoded_bytes INTEGER NOT NULL,
        current_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        context_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        capacity INTEGER NOT NULL,
        entries_json TEXT NOT NULL,
        PRIMARY KEY (context_id, version)
      );
      CREATE TABLE IF NOT EXISTS blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        encoding TEXT NOT NULL,
        raw BLOB NOT NULL,
        input_version INTEGER NOT NULL,
        output_version INTEGER NOT NULL,
        fields_json TEXT NOT NULL,
        size_updates_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (context_id, seq)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private newId(): string {
    return "ctx_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  createContext(opts: {
    maxAllowedCapacity?: number;
    limits?: Partial<Limits>;
    id?: string;
    initialTable?: { capacity: number; entries: TableEntry[] };
    decodedBytes?: number;
  }): ContextRecord {
    const cap = opts.maxAllowedCapacity ?? 4096;
    if (!Number.isInteger(cap) || cap < 0 || cap > 1 << 30) {
      throw new StoreError("BAD_INPUT", "maxAllowedCapacity must be an integer in [0, 2^30]");
    }
    const limits: Limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
    const id = opts.id ?? this.newId();
    const now = new Date().toISOString();
    const table = opts.initialTable ?? { capacity: cap, entries: [] };
    this.validateTable(table);
    const insertCtx = this.db.prepare(
      `INSERT INTO contexts (id, max_allowed_capacity, limits_json, decoded_bytes, current_version, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`
    );
    const insertSnap = this.db.prepare(
      `INSERT INTO snapshots (context_id, version, capacity, entries_json) VALUES (?, 0, ?, ?)`
    );
    insertCtx.run(id, cap, JSON.stringify(limits), opts.decodedBytes ?? 0, now);
    insertSnap.run(id, table.capacity, JSON.stringify(serializeEntries(table.entries)));
    return this.getContext(id);
  }

  private validateTable(t: { capacity: number; entries: TableEntry[] }): void {
    if (!Number.isInteger(t.capacity) || t.capacity < 0) {
      throw new StoreError("BAD_INPUT", "snapshot capacity must be a non-negative integer");
    }
    let total = 0;
    for (const e of t.entries) {
      const sz = entrySize(e);
      if (sz > t.capacity) {
        throw new StoreError(
          "BAD_INPUT",
          `snapshot entry (size ${sz}) exceeds snapshot capacity ${t.capacity}`
        );
      }
      total += sz;
    }
    if (total > t.capacity) {
      throw new StoreError(
        "BAD_INPUT",
        `snapshot entries total size ${total} exceeds capacity ${t.capacity}`
      );
    }
  }

  getContext(id: string): ContextRecord {
    const row = this.db
      .prepare(`SELECT * FROM contexts WHERE id = ?`)
      .get(id) as any;
    if (!row) throw new StoreError("NOT_FOUND", `context ${id} not found`);
    return {
      id: row.id,
      maxAllowedCapacity: row.max_allowed_capacity,
      limits: JSON.parse(row.limits_json),
      decodedBytes: row.decoded_bytes,
      currentVersion: row.current_version,
      createdAt: row.created_at,
    };
  }

  listContexts(): ContextRecord[] {
    const rows = this.db.prepare(`SELECT * FROM contexts ORDER BY created_at`).all() as any[];
    return rows.map((row) => ({
      id: row.id,
      maxAllowedCapacity: row.max_allowed_capacity,
      limits: JSON.parse(row.limits_json),
      decodedBytes: row.decoded_bytes,
      currentVersion: row.current_version,
      createdAt: row.created_at,
    }));
  }

  // Load the dynamic table at a specific version (snapshots are immutable).
  loadTable(contextId: string, version?: number): { capacity: number; entries: TableEntry[] } {
    const ctx = this.getContext(contextId);
    const v = version ?? ctx.currentVersion;
    const row = this.db
      .prepare(`SELECT * FROM snapshots WHERE context_id = ? AND version = ?`)
      .get(contextId, v) as any;
    if (!row) throw new StoreError("NOT_FOUND", `snapshot version ${v} not found`);
    return {
      capacity: row.capacity,
      entries: deserializeEntries(JSON.parse(row.entries_json)),
    };
  }

  setMaxAllowedCapacity(contextId: string, cap: number): ContextRecord {
    if (!Number.isInteger(cap) || cap < 0 || cap > 1 << 30) {
      throw new StoreError("BAD_INPUT", "maxAllowedCapacity must be an integer in [0, 2^30]");
    }
    this.getContext(contextId);
    this.db
      .prepare(`UPDATE contexts SET max_allowed_capacity = ? WHERE id = ?`)
      .run(cap, contextId);
    return this.getContext(contextId);
  }

  // Decode and commit a block atomically. On decode failure nothing is
  // written; the previous snapshot remains the current state.
  submitBlock(contextId: string, encoding: "hex" | "base64", data: string) {
    const ctx = this.getContext(contextId);
    let raw: Buffer;
    try {
      raw = Buffer.from(data.replace(/\s+/g, ""), encoding);
    } catch {
      throw new StoreError("BAD_INPUT", `invalid ${encoding} input`);
    }
    if (encoding === "hex" && !/^[0-9a-fA-F]*$/.test(data.replace(/\s+/g, ""))) {
      throw new StoreError("BAD_INPUT", "invalid hex input");
    }
    const table = this.loadTable(contextId);
    const result = decodeBlock(
      raw,
      { entries: table.entries, capacity: table.capacity, size: tableSize(table.entries) },
      {
        maxAllowedCapacity: ctx.maxAllowedCapacity,
        limits: ctx.limits,
        decodedBytesSoFar: ctx.decodedBytes,
      }
    );
    const newVersion = ctx.currentVersion + 1;
    const seqRow = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM blocks WHERE context_id = ?`)
      .get(contextId) as any;
    const seq = seqRow.seq;
    const now = new Date().toISOString();
    const fieldsJson = JSON.stringify(
      result.fields.map((f) => ({
        nameHex: f.name.toString("hex"),
        valueHex: f.value.toString("hex"),
        nameText: utf8Text(f.name),
        valueText: utf8Text(f.value),
        explanation: f.explanation,
      }))
    );
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO snapshots (context_id, version, capacity, entries_json) VALUES (?, ?, ?, ?)`
        )
        .run(contextId, newVersion, result.table.capacity, JSON.stringify(serializeEntries(result.table.entries)));
      this.db
        .prepare(
          `INSERT INTO blocks (context_id, seq, encoding, raw, input_version, output_version, fields_json, size_updates_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(contextId, seq, encoding, raw, ctx.currentVersion, newVersion, fieldsJson,
          JSON.stringify(result.sizeUpdates), now);
      this.db
        .prepare(`UPDATE contexts SET current_version = ?, decoded_bytes = ? WHERE id = ?`)
        .run(newVersion, ctx.decodedBytes + result.decodedBytes, contextId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return {
      contextId,
      seq,
      inputVersion: ctx.currentVersion,
      outputVersion: newVersion,
      fields: JSON.parse(fieldsJson),
      sizeUpdates: result.sizeUpdates,
      table: this.tableSnapshot(contextId),
    };
  }

  tableSnapshot(contextId: string, version?: number) {
    const t = this.loadTable(contextId, version);
    let size = 0;
    const entries = t.entries.map((e, i) => {
      const sz = entrySize(e);
      size += sz;
      return {
        index: 62 + i,
        nameHex: e.name.toString("hex"),
        valueHex: e.value.toString("hex"),
        nameText: utf8Text(e.name),
        valueText: utf8Text(e.value),
        size: sz,
      };
    });
    return { capacity: t.capacity, size, entries };
  }

  listFields(contextId: string) {
    this.getContext(contextId);
    const rows = this.db
      .prepare(`SELECT seq, fields_json FROM blocks WHERE context_id = ? ORDER BY seq`)
      .all(contextId) as any[];
    const out: any[] = [];
    for (const row of rows) {
      const fields = JSON.parse(row.fields_json);
      fields.forEach((f: any, i: number) => out.push({ blockSeq: row.seq, fieldIndex: i, ...f }));
    }
    return out;
  }

  listBlocks(contextId: string) {
    this.getContext(contextId);
    const rows = this.db
      .prepare(
        `SELECT seq, encoding, length(raw) AS byteLength, input_version, output_version, created_at
         FROM blocks WHERE context_id = ? ORDER BY seq`
      )
      .all(contextId) as any[];
    return rows;
  }

  getBlockExplanation(contextId: string, seq: number) {
    this.getContext(contextId);
    const row = this.db
      .prepare(`SELECT * FROM blocks WHERE context_id = ? AND seq = ?`)
      .get(contextId, seq) as any;
    if (!row) throw new StoreError("NOT_FOUND", `block ${seq} not found`);
    return {
      contextId,
      seq: row.seq,
      encoding: row.encoding,
      rawHex: (row.raw as Buffer).toString("hex"),
      inputVersion: row.input_version,
      outputVersion: row.output_version,
      fields: JSON.parse(row.fields_json),
      sizeUpdates: JSON.parse(row.size_updates_json),
      createdAt: row.created_at,
    };
  }

  forkContext(sourceId: string): ContextRecord {
    const src = this.getContext(sourceId);
    const table = this.loadTable(sourceId);
    return this.createContext({
      maxAllowedCapacity: src.maxAllowedCapacity,
      limits: src.limits,
      initialTable: table,
      decodedBytes: src.decodedBytes,
    });
  }

  exportContext(contextId: string) {
    const ctx = this.getContext(contextId);
    const table = this.loadTable(contextId);
    return {
      format: "hpack-analyzer-context@1",
      maxAllowedCapacity: ctx.maxAllowedCapacity,
      limits: ctx.limits,
      decodedBytes: ctx.decodedBytes,
      table: {
        capacity: table.capacity,
        entries: table.entries.map((e) => ({
          nameHex: e.name.toString("hex"),
          valueHex: e.value.toString("hex"),
        })),
      },
    };
  }

  importContext(payload: any): ContextRecord {
    if (!payload || payload.format !== "hpack-analyzer-context@1") {
      throw new StoreError("BAD_INPUT", "unrecognized export format");
    }
    const entries: TableEntry[] = (payload.table?.entries ?? []).map((e: any) => {
      if (typeof e?.nameHex !== "string" || typeof e?.valueHex !== "string") {
        throw new StoreError("BAD_INPUT", "snapshot entries must have nameHex/valueHex");
      }
      return { name: Buffer.from(e.nameHex, "hex"), value: Buffer.from(e.valueHex, "hex") };
    });
    return this.createContext({
      maxAllowedCapacity: payload.maxAllowedCapacity,
      limits: payload.limits,
      decodedBytes: payload.decodedBytes ?? 0,
      initialTable: { capacity: payload.table?.capacity ?? 0, entries },
    });
  }
}

function tableSize(entries: TableEntry[]): number {
  return entries.reduce((a, e) => a + entrySize(e), 0);
}

function serializeEntries(entries: TableEntry[]) {
  return entries.map((e) => ({
    nameHex: e.name.toString("hex"),
    valueHex: e.value.toString("hex"),
  }));
}

function deserializeEntries(rows: Array<{ nameHex: string; valueHex: string }>): TableEntry[] {
  return rows.map((r) => ({
    name: Buffer.from(r.nameHex, "hex"),
    value: Buffer.from(r.valueHex, "hex"),
  }));
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "hpack.db");
}

export { HpackError };
