/**
 * 记忆本子浏览器（dsh-memory-viewer）· Host 端
 *
 * 只做三件事：
 *   1. 扫记忆目录，列出有哪些本子（多大、什么时候改的、第一句是什么）
 *   2. 读某一本的全文
 *   3. 第一次装的时候把空白模板铺出来（AGENTS.md 是骨架，example 是范例）
 *
 * 不写记忆内容，不改用户的字。所有写操作只有初始化那一次。
 *
 * 前端通过 /plugins/memory-viewer/api/* 访问，不用 Remote 协议。
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { join, resolve, basename, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = join(HERE, '..', 'template')

export const name = 'memory-viewer'
export const inject = ['webServer']

const API_PREFIX = '/plugins/memory-viewer/api'

const EXAMPLE_FILENAME = 'example.md'

/**
 * 不声明 Config。
 *
 * 曾经声明过 `Schema.object({...})`，但 `@deepseek-ai/schemastery` 在本插件里
 * import 不到：插件是从 profile 的 node_modules 符号链接加载的，Node 的 ESM
 * 解析会先 realpath 回工作区源码目录，再逐级向上找 node_modules —— 工作区里
 * 没有这个包，于是 ERR_MODULE_NOT_FOUND，整个 entry failed，web boot 直接崩。
 *
 * Cordis 的 Config 是可选的。不声明时，patch 里的 `config:` 会原样传给 apply，
 * 所以 memoryRoot / dirName / autoInit 依然可以在 cordis.patch.yml 里配。
 * 代价只是设置页不出现这个插件的配置表单。
 */
const DEFAULT_CONFIG = {
  memoryRoot: '',
  dirName: 'memory',
  autoInit: true,
}

function defaultRoot(dirName) {
  return join(process.cwd(), dirName || 'memory')
}

async function safeStat(p) {
  try { return await stat(p) } catch { return null }
}

async function walk(dir, prefix = '', out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) {
      await walk(full, rel, out)
    } else if (e.name.toLowerCase().endsWith('.md')) {
      const st = await safeStat(full)
      out.push({
        rel,
        name: e.name,
        dir: prefix || '',
        size: st?.size ?? 0,
        mtime: st?.mtime?.toISOString() ?? null,
      })
    }
  }
  return out
}

function excerpt(text, max = 100) {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('#') || t.startsWith('>') || t.startsWith('---')) continue
    return t.length > max ? t.slice(0, max) + '…' : t
  }
  return ''
}

function json(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * 在系统文件管理器里打开一个目录。
 *
 * 用 detached + unref：explorer.exe 常常不立即退出、退出码也非 0，
 * 不能等它，否则宿主会被挂住。
 * 路径校验在调用方完成 —— 这里只管开。
 */
function revealInFileManager(dir) {
  const opts = { detached: true, stdio: 'ignore' }
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [dir], opts).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [dir], opts).unref()
    } else {
      spawn('xdg-open', [dir], opts).unref()
    }
    return true
  } catch (e) {
    console.error('[memory-viewer] reveal failed', e)
    return false
  }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  const root = resolve(cfg.memoryRoot || defaultRoot(cfg.dirName))
  const autoInit = cfg.autoInit !== false

  let initialized = null
  async function ensureInitialized() {
    if (initialized) return initialized
    const st = await safeStat(root)
    if (st?.isDirectory()) {
      // 已存在：只记「这次不是新建的」，不要把它当成永远的状态
      initialized = { createdThisRun: false, missing: false }
      return initialized
    }
    if (!autoInit) {
      initialized = { createdThisRun: false, missing: true }
      return initialized
    }
    await mkdir(root, { recursive: true })
    const agentsTpl = await readFile(join(TEMPLATE_DIR, 'AGENTS.md'), 'utf8')
    const exampleTpl = await readFile(join(TEMPLATE_DIR, 'example.md'), 'utf8')
    await writeFile(join(root, 'AGENTS.md'), agentsTpl.replaceAll('<MEMORY_ROOT>', root), 'utf8')
    await writeFile(join(root, EXAMPLE_FILENAME), exampleTpl, 'utf8')
    initialized = { createdThisRun: true, missing: false }
    return initialized
  }

  /** 扫出所有本子，并按所在子目录分组 */
  async function listBooks() {
    await ensureInitialized()
    const books = await walk(root)
    const out = []
    for (const b of books) {
      let ex = ''
      try {
        ex = excerpt(await readFile(join(root, b.rel), 'utf8'))
      } catch { /* 读不到就空着 */ }
      out.push({ ...b, excerpt: ex })
    }
    out.sort((a, b) => {
      if (!a.mtime) return 1
      if (!b.mtime) return -1
      return b.mtime.localeCompare(a.mtime)
    })

    // 分组：根目录的散装文件一组，每个子目录一组。
    // 前端按 groups 渲染成分区，而不是把所有本子排成一个长列表。
    const byDir = new Map()
    for (const b of out) {
      const key = b.dir || ''
      if (!byDir.has(key)) byDir.set(key, [])
      byDir.get(key).push(b)
    }
    const groups = [...byDir.entries()].map(([key, list]) => ({ key, books: list }))
    // 根目录组永远排最前，其余按目录名排
    groups.sort((a, b) => {
      if (a.key === '') return -1
      if (b.key === '') return 1
      return a.key.localeCompare(b.key, 'zh')
    })

    return { books: out, groups }
  }

  async function readBook(rel) {
    await ensureInitialized()
    const target = resolve(root, rel)
    const rootWithSep = root + (root.endsWith('\\') || root.endsWith('/') ? '' : sep)
    if (target !== root && !target.startsWith(rootWithSep)) {
      throw new Error('路径越界')
    }
    const st = await safeStat(target)
    if (!st?.isFile()) throw new Error('这本不存在')
    return {
      rel,
      name: basename(target),
      text: await readFile(target, 'utf8'),
      size: st.size,
      mtime: st.mtime.toISOString(),
    }
  }

  // ── HTTP 路由 ───────────────────────────────────────────
  if (ctx.webServer?.register) {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        async handler(req, res) {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const sub = url.pathname.slice(API_PREFIX.length) || '/'

            if (sub === '/list' || sub === '/') {
              const init = await ensureInitialized()
              const listing = await listBooks()
              return json(res, 200, {
                root,
                created: init.createdThisRun,
                missing: init.missing,
                books: listing.books,
                groups: listing.groups,
              })
            }

            if (sub === '/read') {
              const rel = url.searchParams.get('rel')
              if (!rel) return json(res, 400, { error: '缺少 rel 参数' })
              return json(res, 200, await readBook(rel))
            }

            if (sub === '/info') {
              const init = await ensureInitialized()
              return json(res, 200, { root, created: init.createdThisRun, missing: init.missing })
            }

            // 打开文件位置：只接受「记忆根目录」或它的子目录，别的路径一律拒绝。
            if (sub === '/reveal') {
              const sub2 = url.searchParams.get('dir') ?? ''
              const target = resolve(root, sub2)
              const rootWithSep = root + (root.endsWith('\\') || root.endsWith('/') ? '' : sep)
              if (target !== root && !target.startsWith(rootWithSep)) {
                return json(res, 400, { error: '路径越界' })
              }
              const st = await safeStat(target)
              if (!st?.isDirectory()) return json(res, 400, { error: '目录不存在' })
              revealInFileManager(target)
              return json(res, 200, { ok: true, opened: target })
            }

            return json(res, 404, { error: 'unknown endpoint', sub })
          } catch (e) {
            // 不要把 fs 错误的原始 message 直接吐给浏览器 —— 那里往往带用户的绝对路径。
            // 业务上我们自己抛的两种错误可以原样返回，其余泛化并记日志。
            const msg = String(e?.message ?? e)
            const known = msg === '路径越界' || msg === '这本不存在'
            if (!known) ctx.logger?.warn?.(`[memory-viewer] ${e?.code ?? 'ERR'}: ${msg}`)
            return json(res, 500, { error: known ? msg : '读取失败，详情见宿主日志' })
          }
        },
      }),
    )
  }

  // ── 给 Agent 用的只读工具 ────────────────────────────────
  // tools 不是硬依赖：用可选注入，服务不在时安静跳过，
  // 避免整个插件因为拿不到 tools 而 failed。
  ctx.inject(['tools'], (scope) => {
    const tools = scope.tools
    if (!tools?.register) return

    ctx.effect(() =>
      tools.register({
        name: 'memory_list',
        description: '列出记忆目录里有哪些本子，每本带一句摘要和最后改动时间。只读。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: 'object',
            properties: {
              root: { type: 'string' },
              books: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    rel: { type: 'string' },
                    size: { type: 'number' },
                    mtime: { type: 'string' },
                    excerpt: { type: 'string' },
                  },
                },
              },
              groups: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string' },
                    books: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
          render: (a, v) => {
            // 按分区渲染，跟面板里的分组一致
            const groups = Array.isArray(v.groups) && v.groups.length
              ? v.groups
              : [{ key: '', books: v.books ?? [] }]
            const lines = [`${v.root}`]
            for (const g of groups) {
              const title = g.key ? `【${g.key}】` : '【根目录】'
              lines.push('', title)
              for (const b of g.books ?? []) {
                const mb = (b.size / 1024).toFixed(1)
                lines.push(`- ${b.rel} (${mb}KB)`)
                if (b.excerpt) lines.push(`  ${b.excerpt}`)
              }
            }
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        async execute() {
          const listing = await listBooks()
          return { root, books: listing.books, groups: listing.groups }
        },
      }),
    )

    ctx.effect(() =>
      tools.register({
        name: 'memory_read',
        description: '读记忆目录里某一本的全文。只读，不修改。',
        parameters: {
          type: 'object',
          properties: {
            rel: { type: 'string', description: '相对路径，如 example.md' },
          },
          required: ['rel'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              rel: { type: 'string' },
              text: { type: 'string' },
              size: { type: 'number' },
            },
          },
          render: (a, v) => [{ type: 'text', text: v.text }],
        },
        async execute(args) {
          const r = await readBook(String(args?.rel ?? ''))
          return { rel: r.rel, text: r.text, size: r.size }
        },
      }),
    )
  })

  ctx.logger?.info?.(`[memory-viewer] 记忆目录 → ${root}，API ${API_PREFIX}`)
}
