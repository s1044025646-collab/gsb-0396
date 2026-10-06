// Minimal HTTP API using node:http (no external dependencies).
import * as http from "node:http";
import * as net from "node:net";
import { Store, StoreError, defaultDbPath } from "./store";
import { HpackError } from "./hpack";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof HpackError) {
    sendJson(res, 422, { error: { code: err.code, message: err.message, byteOffset: err.byteOffset } });
  } else if (err instanceof StoreError) {
    sendJson(res, err.code === "NOT_FOUND" ? 404 : 400, { error: { code: err.code, message: err.message } });
  } else {
    sendJson(res, 500, { error: { code: "INTERNAL", message: String(err) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > 1024 * 1024) throw new StoreError("BAD_INPUT", "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StoreError("BAD_INPUT", "request body must be JSON");
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      if (method === "GET" && parts.length === 0) {
        return sendJson(res, 200, {
          service: "hpack-analyzer",
          scope: "offline RFC 7541 decoder, non-Huffman strings only",
          endpoints: [
            "POST /contexts",
            "GET /contexts",
            "GET /contexts/:id",
            "POST /contexts/:id/settings",
            "POST /contexts/:id/blocks",
            "GET /contexts/:id/fields",
            "GET /contexts/:id/table?version=",
            "GET /contexts/:id/blocks",
            "GET /contexts/:id/blocks/:seq",
            "POST /contexts/:id/fork",
            "GET /contexts/:id/export",
            "POST /contexts/import",
          ],
        });
      }
      if (parts[0] === "contexts" && parts.length === 1 && method === "POST") {
        const body = await readBody(req);
        return sendJson(res, 201, store.createContext(body));
      }
      if (parts[0] === "contexts" && parts.length === 1 && method === "GET") {
        return sendJson(res, 200, store.listContexts());
      }
      if (parts[0] === "contexts" && parts[1] === "import" && method === "POST") {
        const body = await readBody(req);
        return sendJson(res, 201, store.importContext(body));
      }
      if (parts[0] === "contexts" && parts.length >= 2) {
        const id = parts[1];
        const sub = parts[2];
        if (!sub && method === "GET") return sendJson(res, 200, store.getContext(id));
        if (sub === "settings" && method === "POST") {
          const body = await readBody(req);
          return sendJson(res, 200, store.setMaxAllowedCapacity(id, body.maxAllowedCapacity));
        }
        if (sub === "blocks" && parts.length === 3 && method === "POST") {
          const body = await readBody(req);
          if (body.encoding !== "hex" && body.encoding !== "base64") {
            throw new StoreError("BAD_INPUT", "encoding must be 'hex' or 'base64'");
          }
          if (typeof body.data !== "string") {
            throw new StoreError("BAD_INPUT", "data must be a string");
          }
          return sendJson(res, 201, store.submitBlock(id, body.encoding, body.data));
        }
        if (sub === "blocks" && parts.length === 3 && method === "GET") {
          return sendJson(res, 200, store.listBlocks(id));
        }
        if (sub === "blocks" && parts.length === 4 && method === "GET") {
          return sendJson(res, 200, store.getBlockExplanation(id, Number(parts[3])));
        }
        if (sub === "fields" && method === "GET") {
          return sendJson(res, 200, store.listFields(id));
        }
        if (sub === "table" && method === "GET") {
          const v = url.searchParams.get("version");
          return sendJson(res, 200, store.tableSnapshot(id, v === null ? undefined : Number(v)));
        }
        if (sub === "fork" && method === "POST") {
          return sendJson(res, 201, store.forkContext(id));
        }
        if (sub === "export" && method === "GET") {
          return sendJson(res, 200, store.exportContext(id));
        }
      }
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "unknown route" } });
    } catch (err) {
      sendError(res, err);
    }
  });
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

export async function startServer(opts: { port?: number; dbPath?: string } = {}) {
  const store = new Store(opts.dbPath ?? defaultDbPath());
  const server = createServer(store);
  const port = opts.port ?? (await findFreePort());
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, store, port };
}

if (require.main === module) {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const port = portArg ? Number(portArg.split("=")[1]) : envPort;
  startServer({ port }).then(({ port }) => {
    console.log(`hpack-analyzer API listening on http://127.0.0.1:${port}`);
  });
}
