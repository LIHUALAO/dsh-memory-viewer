# dsh-memory-viewer · 记忆本子浏览器

点开就能翻。把每一个 DS 会话留下的记忆本子列出来，左边挑一本，右边看它写了什么。

装上去之后，侧边栏多一个图标，设置页多一个页面。第一次打开时，如果记忆目录不存在，
插件会用自带模板铺一份出来：一份空白的 `AGENTS.md`（让用户自己的 DS 去填），
一份 `example.md`（告诉用户"一本记忆该长什么样"）。

## 为什么要有这个

会话之间不共享记忆。每次新开的会话是新的，上一个它想过什么、讨厌什么、记住谁，都留在磁盘上没人翻。

这个插件把那些散落的 markdown 摊开来给人看。

## 它是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 一个只读的浏览器界面 | 不是记忆系统，不生成、不改写、不缝合任何内容 |
| 首次安装时铺一份模板 | 不是 RAG，不做向量检索、不建索引 |
| 给 Agent 两个只读工具 | 不给 Agent 任何写记忆的入口 |

**内容归文件，插件只负责让人找到文件。**

## 界面

- **侧边栏图标** → 点开是全局面板
- **设置页** → 同上面板，找不到图标时的备选入口
- 左栏：所有本子，按最后改动时间倒序，每条带大小、时间和第一句摘要
- 右栏：markdown 正文，支持标题 / 段落 / 列表 / 引用 / 分隔线 / 代码块 / 粗体 / 斜体 / 行内代码

主题跟随宿主，只用 `--dsw-alias-*` token，不写死颜色。

## 配置

```yaml
- insert:
    - id: memory-viewer
      name: dsh-memory-viewer
      config:
        memoryRoot: ''      # 绝对路径；留空则用 <当前工作目录>/<dirName>
        dirName: memory     # memoryRoot 留空时的子目录名
        autoInit: true      # 目录不存在时铺模板
```

### 关于 `Config`（踩过的坑）

本插件**不导出** `export const Config`。这是刻意的：

Cordis 的 `Config` 必须是 `@deepseek-ai/schemastery` 构造的 schema。但这个插件是从
profile 的 `node_modules` **符号链接**加载的，Node 的 ESM 解析会先 realpath 回源码目录，
再逐级向上找 `node_modules`——源码目录里没有 schemastery，于是 `ERR_MODULE_NOT_FOUND`，
整个 entry `failed`，`web boot` 直接拒绝启动，GUI 起不来。

`Config` 在 Cordis 里是可选的。不声明时，patch 里的 `config:` 会**原样传给 `apply`**，
所以上面那三个字段照样生效。代价只是设置页不出现配置表单。

同理，本插件只 import `node:` 内置模块，零第三方依赖——**任何外部 import 都可能因为
符号链接解析而在冷启动时炸掉**。

## Agent 工具

两个都只读：

- `memory_list` — 列出所有本子，每本带摘要和最后改动时间
- `memory_read` — 读某一本全文

`tools` 不是硬依赖：用 `ctx.inject(['tools'], ...)` 可选注入，宿主没有这个服务时安静跳过，
不会让插件整体 failed。硬依赖只有 `webServer`。

没有写工具。插件不会替任何人改记忆。

## HTTP API

前端走自己的后端，不走 Remote 协议：

```
GET /plugins/memory-viewer/api/list            → { root, created, missing, books: [...] }
GET /plugins/memory-viewer/api/read?rel=<path> → { rel, name, text, size, mtime }
GET /plugins/memory-viewer/api/info            → { root, created, missing }
```

`rel` 会做目录穿越校验；fs 错误的原始信息只进宿主日志，不回吐给浏览器。

## 安全

- 目录穿越已拦：归一化后必须仍在 `memoryRoot` 内
- 不渲染 HTML：markdown 输出的 children 全是字符串，React 自动转义，无 `dangerouslySetInnerHTML`
- 错误信息不泄漏用户绝对路径
- 不联网、不写记忆内容

## 测试

```powershell
node test/host.mjs           # Host 端 31 项：路由、模板铺开、路径安全、工具、服务缺失容错
node test/client-load.mjs    # Client 端 15 项：模块注册、factory、slot、locale
node test/render-check.mjs   # 渲染器 50 条用例
node test/hang-isolate.mjs   # 死循环隔离（子进程 + 超时）
node test/xss-probe.mjs      # XSS 与 key 唯一性
```

全部在临时目录里跑，不碰真实记忆。

### 冷启动预演

装插件前建议先模拟一次真实加载路径（符号链接 realpath 之后的位置），确认不会因缺依赖而炸：

```powershell
node --input-type=module -e "import('./lib/index.js').then(m=>console.log(m.name, m.inject))"
```

这里能过，DSH 冷启动就能过；这里报 `ERR_MODULE_NOT_FOUND`，DSH 整个 GUI 会起不来。

## License

MIT
