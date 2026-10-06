# HPACK 动态表引用与头字段块解码解释器（离线后端）

一个纯本地运行的 HPACK（RFC 7541）头字段块**离线分析器**：按顺序解码同一上下文中的多个二进制块，观察动态表的插入、淘汰与索引变化，并对每个字段给出字节级解释。仅提供 HTTP API 与 CLI，无前端、不连接真实 HTTP/2 服务、不做请求代理。

技术栈：TypeScript + Node.js（内置 `node:http`、`node:sqlite`，无任何运行时第三方依赖）。Windows 本地直接运行，不需要 Docker / WSL / 外部服务。

## 支持范围（重要）

- 仅支持 RFC 7541 的**非 Huffman** 字符串表示；遇到 Huffman 标记位（H=1）明确报 `HUFFMAN_UNSUPPORTED`，绝不按普通字符串误读。
- 支持：索引字段（indexed）、增量索引字面字段（literal_incremental）、不索引字面字段（literal_without_indexing）、永不索引字面字段（literal_never_indexed）、动态表大小更新（size update）。
- 静态表为标准 61 项；动态表最新条目从索引 62 开始，索引从 1 开始连续编号。
- 名称可引用表中条目，值一律从当前载荷读取；名称和值均可为空；重复名称按顺序保留为独立字段，不合并。
- 字符串载荷保留原始字节（hex），另在合法 UTF-8 时提供文本展示；容量按**字节数**计算（名 + 值 + 32）。
- 单条目大于当前容量时清空动态表且不插入；超容量时从最旧条目淘汰。
- 大小更新只允许出现在块开头且不超过上下文配置的上限，不产生头字段输出。
- 本工具是离线受限解码器，**不宣称验证 HTTP/2 头字段语义**（如伪头字段规则）。

## 错误码

`INT_OVERFLOW`、`INDEX_OUT_OF_RANGE`、`TRUNCATED`、`HUFFMAN_UNSUPPORTED`、`SIZE_UPDATE_NOT_AT_START`、`SIZE_UPDATE_TOO_LARGE`、`LIMIT_EXCEEDED`、`BAD_INPUT`、`NOT_FOUND`。解码类错误均带 `byteOffset` 定位字节偏移。

## 限制（超限不留成功记录）

每上下文可配置：`maxBlockBytes`（默认 64KB）、`maxFields`（默认 1000）、`maxIntegerBytes`（默认 8）、`maxDecodedBytesTotal`（默认 16MB，累计）。

## 原子性与持久化

每个块先在临时表状态上完整解析，成功后才在一个 SQLite 事务中原子提交（新快照 + 块记录 + 上下文游标）；失败只返回诊断，不提交半张动态表，可从前一快照重新提交其他输入。SQLite 保存块原文、顺序、输入/输出表版本与解码结果；历史快照不可变，重启后可继续下一块。各上下文动态表互不共享；导入快照会校验容量与条目尺寸。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 构建并运行全部测试（独立字节夹具，非自身往返）
npm start         # 启动 API（默认自动选择空闲端口；-- --port=8080 或 PORT 环境变量指定）
npm run demo      # 内置演示：82 41 03 66 6f 6f -> BE -> 容量归零 -> BE 失败 -> 重启续解码
```

数据目录为项目内 `data/`（默认 `data/hpack.db`，可用 `--db` 覆盖）。

## CLI

```powershell
node dist/src/cli.js create --capacity 4096
node dist/src/cli.js submit <ctx> --hex "82 41 03 66 6f 6f"
node dist/src/cli.js submit <ctx> --hex BE
node dist/src/cli.js fields <ctx>
node dist/src/cli.js table <ctx> [--version 1]
node dist/src/cli.js explain <ctx> 1
node dist/src/cli.js set-capacity <ctx> 0
node dist/src/cli.js fork <ctx>
node dist/src/cli.js export <ctx> --out snap.json
node dist/src/cli.js import --in snap.json
node dist/src/cli.js serve --port 8080
```

## HTTP API（摘要）

- `POST /contexts` `{maxAllowedCapacity?, limits?}` → 创建上下文
- `POST /contexts/:id/settings` `{maxAllowedCapacity}` → 设置允许容量上限
- `POST /contexts/:id/blocks` `{encoding: "hex"|"base64", data}` → 提交一个块（原子）
- `GET /contexts/:id/fields` → 按顺序的全部字段（含重复）
- `GET /contexts/:id/table?version=N` → 动态表快照（含每项索引与尺寸）
- `GET /contexts/:id/blocks/:seq` → 某块的字节级解释（字节区间、表示种类、解析索引、表变化）
- `POST /contexts/:id/fork` → 派生新上下文（复制当前状态，之后互不影响）
- `GET /contexts/:id/export` / `POST /contexts/import` → 导出 / 导入快照（导入校验容量与条目尺寸）

## 演示字节说明

`82 41 03 66 6f 6f`：`82` = 索引 2（`:method: GET`）；`41` = 增量索引、名称引用静态索引 1（`:authority`），值长 3 为 `foo`，插入动态表（尺寸 10+3+32=45，索引 62）。下一块 `BE` = 索引 62，得到同一 `:authority: foo`。经 `20`（大小更新为 0）清空表后，`BE` 报 `INDEX_OUT_OF_RANGE`。

## 已知限制

- 不支持 Huffman 字符串（明确报错而非误解码）。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
- 仅监听 `127.0.0.1`；无鉴权，供本地分析使用。
