// CLI for the offline HPACK analyzer.
import * as fs from "node:fs";
import { Store, defaultDbPath } from "./store";
import { startServer } from "./api";

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf("--" + name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith("--" + name + "="));
  return eq ? eq.split("=").slice(1).join("=") : undefined;
}

function print(x: unknown): void {
  console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));
}

const USAGE = `hpack-analyzer CLI (offline RFC 7541, non-Huffman only)

Usage: node dist/src/cli.js <command> [options]

Commands:
  create [--capacity N]                 Create a decoding context
  list                                  List contexts
  set-capacity <ctx> <n>                Set allowed dynamic table capacity ceiling
  submit <ctx> --hex <hex>              Submit a header block (hex)
  submit <ctx> --base64 <b64>           Submit a header block (base64)
  fields <ctx>                          List all decoded fields in order
  table <ctx> [--version N]             Show dynamic table snapshot
  blocks <ctx>                          List committed blocks
  explain <ctx> <seq>                   Byte-level explanation of one block
  fork <ctx>                            Derive a new context from current state
  export <ctx> [--out file]             Export context snapshot as JSON
  import --in file                      Import a context snapshot
  serve [--port N]                      Start HTTP API (default: free port)
  demo                                  Run the built-in demonstration

Options:
  --db <path>                           SQLite file (default: ./data/hpack.db)
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const dbPath = argValue(args, "db") ?? defaultDbPath();

  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }

  if (cmd === "serve") {
    const port = argValue(args, "port");
    const { port: p } = await startServer({
      port: port ? Number(port) : undefined,
      dbPath,
    });
    console.log(`hpack-analyzer API listening on http://127.0.0.1:${p}`);
    return;
  }

  if (cmd === "demo") {
    const { runDemo } = await import("./demo");
    await runDemo(dbPath);
    return;
  }

  const store = new Store(dbPath);
  try {
    switch (cmd) {
      case "create": {
        const cap = argValue(args, "capacity");
        print(store.createContext({ maxAllowedCapacity: cap ? Number(cap) : undefined }));
        break;
      }
      case "list":
        print(store.listContexts());
        break;
      case "set-capacity":
        print(store.setMaxAllowedCapacity(args[1], Number(args[2])));
        break;
      case "submit": {
        const hex = argValue(args, "hex");
        const b64 = argValue(args, "base64");
        if (!hex && !b64) throw new Error("submit requires --hex or --base64");
        print(store.submitBlock(args[1], hex ? "hex" : "base64", (hex ?? b64)!));
        break;
      }
      case "fields":
        print(store.listFields(args[1]));
        break;
      case "table": {
        const v = argValue(args, "version");
        print(store.tableSnapshot(args[1], v ? Number(v) : undefined));
        break;
      }
      case "blocks":
        print(store.listBlocks(args[1]));
        break;
      case "explain":
        print(store.getBlockExplanation(args[1], Number(args[2])));
        break;
      case "fork":
        print(store.forkContext(args[1]));
        break;
      case "export": {
        const out = store.exportContext(args[1]);
        const file = argValue(args, "out");
        if (file) {
          fs.writeFileSync(file, JSON.stringify(out, null, 2));
          console.log(`exported to ${file}`);
        } else {
          print(out);
        }
        break;
      }
      case "import": {
        const file = argValue(args, "in");
        if (!file) throw new Error("import requires --in <file>");
        print(store.importContext(JSON.parse(fs.readFileSync(file, "utf8"))));
        break;
      }
      default:
        console.error(`unknown command: ${cmd}`);
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main().catch((e) => {
  console.error(e.code ? `${e.code}: ${e.message}` : e);
  process.exitCode = 1;
});
