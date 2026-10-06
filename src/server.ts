import * as http from "node:http";
import { AddressInfo } from "node:net";
import { Store, defaultDbPath } from "./store";
import { submitBlock, tableSnapshot, contextInfo, blockExplanation } from "./service";
import { HpackError } from "./errors";

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > 1024 * 1024) {
        reject(new HpackError("LIMIT_EXCEEDED", "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HpackError("INVALID_INPUT", "请求体不是合法 JSON");
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // POST /contexts {name?, maxCapacity?, limits?}
      if (req.method === "POST" && parts.length === 1 && parts[0] === "contexts") {
        const body = await parseJsonBody(req);
        const ctx = store.createContext(body.name ?? "default", body.maxCapacity ?? 4096, body.limits);
        return sendJson(res, 201, contextInfo(ctx));
      }
      // GET /contexts
      if (req.method === "GET" && parts.length === 1 && parts[0] === "contexts") {
        return sendJson(res, 200, store.listContexts().map(contextInfo));
      }
      // POST /contexts/import {snapshot, name?}
      if (req.method === "POST" && parts.length === 2 && parts[0] === "contexts" && parts[1] === "import") {
        const body = await parseJsonBody(req);
        const ctx = store.importContext(body.snapshot, body.name);
        return sendJson(res, 201, contextInfo(ctx));
      }
      if (parts.length >= 2 && parts[0] === "contexts") {
        const id = parts[1];
        const sub = parts[2];
        // GET /contexts/:id
        if (req.method === "GET" && parts.length === 2) {
          return sendJson(res, 200, contextInfo(store.getContext(id)));
        }
        // POST /contexts/:id/capacity {maxCapacity}
        if (req.method === "POST" && sub === "capacity") {
          const body = await parseJsonBody(req);
          return sendJson(res, 200, contextInfo(store.setMaxCapacity(id, body.maxCapacity)));
        }
        // POST /contexts/:id/blocks {data, encoding}
        if (req.method === "POST" && sub === "blocks") {
          const body = await parseJsonBody(req);
          if (typeof body.data !== "string") throw new HpackError("INVALID_INPUT", "缺少 data 字段");
          const outcome = submitBlock(store, id, body.data, body.encoding ?? "hex");
          return sendJson(res, outcome.ok ? 200 : 422, outcome);
        }
        // GET /contexts/:id/blocks 或 /contexts/:id/blocks/:seq
        if (req.method === "GET" && sub === "blocks") {
          if (parts.length === 4) {
            return sendJson(res, 200, blockExplanation(store, id, Number(parts[3])));
          }
          return sendJson(res, 200, store.listBlocks(id).map((b) => blockExplanation(store, id, b.seq)));
        }
        // GET /contexts/:id/fields
        if (req.method === "GET" && sub === "fields") {
          const blocks = store.listBlocks(id).filter((b) => b.ok);
          const fields: unknown[] = [];
          for (const b of blocks) {
            for (const f of (b.result as any).fields) fields.push({ seq: b.seq, ...f });
          }
          return sendJson(res, 200, fields);
        }
        // GET /contexts/:id/table
        if (req.method === "GET" && sub === "table") {
          return sendJson(res, 200, tableSnapshot(store, id));
        }
        // POST /contexts/:id/derive {name?}
        if (req.method === "POST" && sub === "derive") {
          const body = await parseJsonBody(req);
          return sendJson(res, 201, contextInfo(store.deriveContext(id, body.name)));
        }
        // GET /contexts/:id/export
        if (req.method === "GET" && sub === "export") {
          return sendJson(res, 200, store.exportContext(id));
        }
      }
      if (req.method === "GET" && parts.length === 1 && parts[0] === "health") {
        return sendJson(res, 200, { ok: true });
      }
      throw new HpackError("NOT_FOUND", `路由不存在: ${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof HpackError) {
        const status =
          err.code === "NOT_FOUND" ? 404 : err.code === "LIMIT_EXCEEDED" ? 413 : err.code === "CONFLICT" ? 409 : 400;
        return sendJson(res, status, { error: err.toJSON() });
      }
      return sendJson(res, 500, { error: { code: "INTERNAL", message: String(err) } });
    }
  });
}

export function startServer(port: number, dbPath?: string): Promise<{ server: http.Server; port: number }> {
  const store = new Store(dbPath ?? defaultDbPath());
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

if (require.main === module) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : Number(process.env.PORT ?? 0);
  startServer(Number.isFinite(port) ? port : 0).then(({ port }) => {
    console.log(`HPACK 分析器 API 已启动: http://127.0.0.1:${port}`);
  });
}
