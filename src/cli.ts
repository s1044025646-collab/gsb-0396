import { Store, defaultDbPath } from "./store";
import { submitBlock, tableSnapshot, contextInfo, blockExplanation } from "./service";
import { startServer } from "./server";
import * as fs from "node:fs";

function out(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const USAGE = `hpack-analyzer — 离线 HPACK 头字段块分析器

用法: node dist/src/cli.js <命令> [参数]

命令:
  serve [--port N]                     启动 HTTP API（默认端口 0，即自动选择空闲端口）
  create --name N [--max-capacity N]   创建解码上下文（默认允许容量 4096）
  list                                 列出上下文
  capacity --ctx ID --max-capacity N   设置允许容量上限
  submit --ctx ID (--hex HEX | --base64 B64 | --file PATH [--encoding hex|base64])
                                       提交一个头字段块
  fields --ctx ID                      查看已解码字段（有序、可重复）
  table --ctx ID                       查看动态表快照
  blocks --ctx ID [--seq N]            查看块解释（字节区间/事件/输入表版本）
  derive --ctx ID [--name N]           派生新上下文（复制当前表状态）
  export --ctx ID [--out PATH]         导出快照 JSON
  import --file PATH [--name N]        从快照导入新上下文
  demo                                 运行内置演示

数据目录: ./data（可用环境变量 HPACK_DATA_DIR 覆盖）
`;

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  if (cmd === "serve") {
    const port = Number(argValue(args, "--port") ?? process.env.PORT ?? 0);
    const { port: actual } = await startServer(port);
    console.log(`HPACK 分析器 API 已启动: http://127.0.0.1:${actual}`);
    return;
  }
  if (cmd === "demo") {
    const { runDemo } = require("./demo");
    await runDemo();
    return;
  }

  const store = new Store(defaultDbPath());
  try {
    const ctxId = argValue(args, "--ctx");
    switch (cmd) {
      case "create":
        out(
          contextInfo(
            store.createContext(argValue(args, "--name") ?? "default", Number(argValue(args, "--max-capacity") ?? 4096))
          )
        );
        break;
      case "list":
        out(store.listContexts().map(contextInfo));
        break;
      case "capacity":
        out(contextInfo(store.setMaxCapacity(needCtx(ctxId), Number(argValue(args, "--max-capacity")))));
        break;
      case "submit": {
        const id = needCtx(ctxId);
        let data: string;
        let encoding = argValue(args, "--encoding") ?? "hex";
        const hex = argValue(args, "--hex");
        const b64 = argValue(args, "--base64");
        const file = argValue(args, "--file");
        if (hex !== undefined) {
          data = hex;
          encoding = "hex";
        } else if (b64 !== undefined) {
          data = b64;
          encoding = "base64";
        } else if (file !== undefined) {
          data = fs.readFileSync(file, "utf8");
        } else {
          throw new Error("需要 --hex / --base64 / --file 之一");
        }
        const outcome = submitBlock(store, id, data, encoding);
        out(outcome);
        if (!outcome.ok) process.exitCode = 2;
        break;
      }
      case "fields": {
        const blocks = store.listBlocks(needCtx(ctxId)).filter((b) => b.ok);
        const fields: unknown[] = [];
        for (const b of blocks) for (const f of (b.result as any).fields) fields.push({ seq: b.seq, ...f });
        out(fields);
        break;
      }
      case "table":
        out(tableSnapshot(store, needCtx(ctxId)));
        break;
      case "blocks": {
        const id = needCtx(ctxId);
        const seq = argValue(args, "--seq");
        if (seq !== undefined) out(blockExplanation(store, id, Number(seq)));
        else out(store.listBlocks(id).map((b) => blockExplanation(store, id, b.seq)));
        break;
      }
      case "derive":
        out(contextInfo(store.deriveContext(needCtx(ctxId), argValue(args, "--name"))));
        break;
      case "export": {
        const snap = store.exportContext(needCtx(ctxId));
        const outPath = argValue(args, "--out");
        if (outPath) {
          fs.writeFileSync(outPath, JSON.stringify(snap, null, 2));
          console.log(`已导出到 ${outPath}`);
        } else out(snap);
        break;
      }
      case "import": {
        const file = argValue(args, "--file");
        if (!file) throw new Error("需要 --file");
        const snap = JSON.parse(fs.readFileSync(file, "utf8"));
        out(contextInfo(store.importContext(snap, argValue(args, "--name"))));
        break;
      }
      default:
        console.error(`未知命令: ${cmd}\n`);
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

function needCtx(id: string | undefined): string {
  if (!id) throw new Error("缺少 --ctx 参数");
  return id;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
