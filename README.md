# hpack-analyzer

离线 HPACK（RFC 7541）头字段块解码解释后端。按顺序解码同一上下文中的多个二进制头字段块，观察动态表的插入、淘汰与索引变化。仅提供 HTTP API 与 CLI，不连接真实 HTTP/2 服务，不做请求代理、Cookie 管理或浏览器。

## 支持范围

- 索引字段（Indexed Header Field）
- 增量索引字面字段（Literal with Incremental Indexing）
- 不索引字面字段（Literal without Indexing）
- 永不索引字面字段（Literal Never Indexed）
- 动态表大小更新（Dynamic Table Size Update，仅允许出现在块开头且不超过允许上限）
- 静态表：RFC 7541 标准 61 个条目；动态表最新条目从索引 62 开始
- 字符串：仅支持**非 Huffman** 表示；遇到 Huffman 标记（H=1）明确报 `HUFFMAN_UNSUPPORTED`，不会按普通字符串误读
- 字符串载荷保留原始字节（hex），合法 UTF-8 时另提供文本展示；容量按字节数计算
- 动态表条目尺寸 = 名称字节数 + 值字节数 + 32；超容量从最旧条目淘汰；单条目大于容量时清空表且不插入
- 本工具是离线受限解码器，不宣称已验证 HTTP/2 的头字段语义

## 运行环境

- Windows 本地，Node.js ≥ 22.5（使用内置 `node:sqlite`，无原生模块、无外部服务）
- 不依赖 Docker / WSL / 付费服务 / 在线 API

## 构建、测试、启动、演示

```powershell
npm install        # 安装开发依赖（typescript）
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试（node:test，25 个用例）
npm start          # 启动 API（默认端口 0 = 自动选择空闲端口）
npm run demo       # 内置演示（需先 build）
```

指定端口：`node dist/src/server.js --port 8080` 或设置环境变量 `PORT`。
数据目录：项目内 `./data`（可用环境变量 `HPACK_DATA_DIR` 覆盖）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/contexts` | 创建上下文 `{name?, maxCapacity?, limits?}` |
| GET | `/contexts` | 列出上下文 |
| GET | `/contexts/:id` | 上下文信息 |
| POST | `/contexts/:id/capacity` | 设置允许容量上限 `{maxCapacity}` |
| POST | `/contexts/:id/blocks` | 提交头字段块 `{data, encoding: "hex"\|"base64"}` |
| GET | `/contexts/:id/blocks[/seq]` | 查看块解释（字节区间、表示种类、表事件、输入表版本） |
| GET | `/contexts/:id/fields` | 有序、可重复的头字段列表 |
| GET | `/contexts/:id/table` | 当前动态表快照 |
| POST | `/contexts/:id/derive` | 派生新上下文（复制当前表状态，之后独立演化） |
| GET | `/contexts/:id/export` | 导出快照 JSON |
| POST | `/contexts/import` | 导入快照 `{snapshot, name?}`（校验容量与条目尺寸） |

## CLI

```powershell
node dist/src/cli.js create --name demo --max-capacity 4096
node dist/src/cli.js submit --ctx <ID> --hex "82 41 03 66 6f 6f"
node dist/src/cli.js submit --ctx <ID> --hex "be"
node dist/src/cli.js fields --ctx <ID>
node dist/src/cli.js table --ctx <ID>
node dist/src/cli.js blocks --ctx <ID> --seq 1
node dist/src/cli.js capacity --ctx <ID> --max-capacity 0
node dist/src/cli.js derive --ctx <ID> --name copy
node dist/src/cli.js export --ctx <ID> --out snap.json
node dist/src/cli.js import --file snap.json
node dist/src/cli.js serve --port 8080
node dist/src/cli.js demo
```

## 演示字节说明

- `82 41 03 66 6f 6f` → `:method: GET`（索引 2）与 `:authority: foo`（增量索引，插入动态表，尺寸 10+3+32=45，索引 62）
- 下一块 `be` → 索引 62 引用同一 `:authority: foo`
- 允许容量缩小到 0 并执行大小更新（`20`）后，表被清空，`be` 引用将以 `INDEX_OUT_OF_RANGE` 失败

## 错误码

`INVALID_INPUT`（参数/编码非法）、`HUFFMAN_UNSUPPORTED`、`INTEGER_OVERFLOW`、`INDEX_OUT_OF_RANGE`、`TRUNCATED`、`SIZE_UPDATE_TOO_LARGE`、`SIZE_UPDATE_NOT_AT_START`、`LIMIT_EXCEEDED`（块大小/字段数/累计字节超限）、`NOT_FOUND`。解码类错误均带字节偏移 `offset`。

## 一致性与持久化

- 每个块先在临时表状态上完整解析，成功后在 SQLite 事务中原子提交（块记录 + 新表状态）；失败仅记录诊断，不提交半张动态表，可从前一快照继续
- SQLite 保存块原文、顺序、输入表版本与结果；重启后可继续下一块；旧快照不随后续淘汰变化
- 各上下文动态表互不共享；导入快照校验容量与条目尺寸
- 默认限制：块 ≤ 64 KiB、字段 ≤ 1000、整数 ≤ 8 字节、累计解码 ≤ 16 MiB（可在创建上下文时通过 `limits` 覆盖）

## 已知限制

- 不支持 Huffman 编码字符串（明确报错而非误读）
- 仅解码，不提供编码器
- 不做 HTTP/2 帧层与连接语义校验
