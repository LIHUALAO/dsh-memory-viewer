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

- **右下角浮动图标** → 点开是全局面板，可以拖动，位置记在 localStorage
- 左栏：所有本子，**按目录分组**，每组标题右侧 hover 出现「打开文件夹」
- 右栏：markdown 正文，支持标题 / 段落 / 列表 / 引用 / 分隔线 / 代码块 / 粗体 / 斜体 / 行内代码

主题跟随宿主，只用 `--dsw-alias-*` token，不写死颜色。

### 三态错误处理（别把它们混成一个 `err`）

面板里同时存在三种互不相干的失败，各自有各自的归宿：

| 失败 | 落到哪 | 为什么 |
|---|---|---|
| 列表加载失败 | 整页错误页 + 重读按钮 | 没东西可显示 |
| **某一本读失败** | 只顶掉右栏，带原因 + 「再试一次」 | 左栏列表还在，别一起消失 |
| 打开文件夹失败 | 左栏底部飘一行 | 跟正文毫无关系 |

上一版三种共用同一个 `err`，而渲染只看 `doc` / `active`，结果「读失败」时右栏永远停在
「正在翻…」——**`setErr` 确实被调用了，只是没人渲染它**。测试见 `test/error-state.mjs`。

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
node test/manifest.mjs       # 清单与编码 20 项：BOM、必需字段、exports、第三方 import
node test/host.mjs           # Host 端 42 项：路由、模板铺开、路径安全、工具、服务缺失容错
node test/client-load.mjs    # Client 端 46 项：模块注册、factory、slot、locale、位置夹取
node test/error-state.mjs    # 面板错误态 28 项：读失败/重试/换本/reveal 失败/非 JSON 响应
node test/render-check.mjs   # 渲染器 50 条用例
node test/hang-isolate.mjs   # 死循环隔离（子进程 + 超时）
node test/xss-probe.mjs      # XSS 与 key 唯一性
```

全部在临时目录里跑，不碰真实记忆。`npm run preflight` 跑前四个（改完代码最该先跑的四个）。

`error-state.mjs` 里有个最小 React + 可编排 fetch，能真的跑 effect、真的重渲染。
它验证的是「屏幕上到底显示了什么」，不是「代码里有没有那句话」——
两条失败路径都是这么漏过去的：`setErr` 被调用了，但没人渲染它。

可以拿它回放旧版本，确认测试本身没骗人：

```powershell
$env:MV_CLIENT = '_backups/旧版/lib/client.js'
node test/error-state.mjs   # 旧版会在这里挂掉 12 项
```

### 为什么非要一个 manifest 测试

`package.json` 开头多一个 U+FEFF，插件就会**静默消失**，而且不会留下任何日志：

```
带 BOM 的 package.json
→ dsh-app-boot readManifest() 裸 JSON.parse(readFileSync(f,'utf8'))    抛 SyntaxError
→ 同一个函数里的 denial() catch 住，说成「声明要求无法校验」
→ deny() 给这行打上 disabled = true —— 只在内存里，从不写回 cordis.patch.yml
→ cordis-plugin-loader 的 Entry#update() 见 disabled 就直接 dispose + return
→ 永不 init，路由没注册，/api/* 全 404，fiberPhase 是 null，crash 日志一条没有
```

表现就是「插件明明装着，可是不见了」，配置文件里还查不到任何 `disabled: true`。
这个坑踩过两次，`manifest.mjs` 就是为它写的：把所有文本文件的头三个字节翻一遍。

顺带拦住另外两类：**重写 `package.json` 时漏字段**（少了 `main` / `exports` / `dsh.client`
插件直接变空壳，但 JSON 完全合法，不会报错），以及**手滑 import 了第三方包**
（符号链接 realpath 之后找不到 `node_modules`，冷启动整个 GUI 起不来）。

这三条都做过故障注入回放，确认测试真的会红。

### 冷启动预演

装插件前建议先模拟一次真实加载路径（符号链接 realpath 之后的位置），确认不会因缺依赖而炸：

```powershell
node --input-type=module -e "import('./lib/index.js').then(m=>console.log(m.name, m.inject))"
```

这里能过，DSH 冷启动就能过；这里报 `ERR_MODULE_NOT_FOUND`，DSH 整个 GUI 会起不来。

## License

MIT
