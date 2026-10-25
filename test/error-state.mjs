/**
 * error-state.mjs —— 面板错误态实证测试
 *
 * 回归的 bug：
 *   「读某一本失败」时右栏永远停在「正在翻…」，用户以为卡死。
 *   根因是三种错误共用一个 `err`，而渲染只看 `doc` / `active`：
 *     - setErr 之后 doc 仍是 null → 落到 hint 分支 → 显示 loading
 *     - `if (err && !books)` 让错误页在列表加载成功后永久失效
 *     - reveal() 失败也写同一个 err，同样看不见
 *
 * 这个测试用一个能真正跑 effect / 重渲染的最小 React 实现，
 * 喂三种失败场景，检查最后渲染出来的树里到底出现了什么。
 *
 * 运行：node test/error-state.mjs
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
// MV_CLIENT 可指向任意一份 client.js —— 用来回放旧版本，确认这个测试真能抓住那个 bug。
const CLIENT = process.env.MV_CLIENT || join(HERE, '..', 'lib', 'client.js')
const source = await readFile(CLIENT, 'utf8')

let pass = 0, fail = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label} ${extra}`) }
}

// ── 最小 React：state 存在 hook 数组里，能手动重渲染 ──────────────
const hooks = []
const effectSlots = []
let cursor = 0
let effects = []
let dirty = 0

const ReactShim = {
  createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
  useState(init) {
    const i = cursor++
    if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init
    const set = (v) => {
      const next = typeof v === 'function' ? v(hooks[i]) : v
      if (!Object.is(next, hooks[i])) { hooks[i] = next; dirty++ }
    }
    return [hooks[i], set]
  },
  useEffect(fn, deps) { effects.push({ fn, deps }) },
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
  useRef(init) {
    const i = cursor++
    if (!(i in hooks)) hooks[i] = { current: typeof init === 'function' ? init() : init }
    return hooks[i]
  },
}
const jsxRuntimeShim = {
  jsx: (type, props) => ({ type, props: props || {} }),
  jsxs: (type, props) => ({ type, props: props || {} }),
}

// ── 可编排的 fetch ──────────────────────────────────────────────
// 每个端点一个 handler，返回 {status, body} 或抛错。
let routes = {}
const fetchCalls = []
function fetchStub(url) {
  fetchCalls.push(String(url))
  const u = String(url)
  const hit = Object.keys(routes).find((k) => u.includes(k))
  const handler = hit ? routes[hit] : () => ({ status: 404, body: '{}' })
  return Promise.resolve().then(async () => {
    const r = await handler(u)
    if (r instanceof Error) throw r
    // 模拟真实 Response 的最小面
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
      json: async () => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body),
    }
  })
}

let registered = null
const sandbox = {
  window: {
    __ModuleLoader__: { load({ id, factory }) { registered = { id, factory } } },
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  navigator: { language: 'zh-CN' },
  fetch: fetchStub,
  setTimeout,
  clearTimeout,
  console,
  document: undefined,
}
sandbox.globalThis = sandbox

vm.runInNewContext(source, sandbox, { filename: CLIENT })
const exported = registered.factory((name) => {
  if (name === 'react') return ReactShim
  if (name === 'react/jsx-runtime') return jsxRuntimeShim
  throw new Error('unknown require: ' + name)
})

// ── 渲染驱动 ────────────────────────────────────────────────────
function renderOnce() {
  cursor = 0
  effects = []
  return exported.MemoryPanel({ locale: 'zh' })
}
function runEffects() {
  effects.forEach((e, n) => {
    const prev = effectSlots[n]
    const same = prev && e.deps && prev.deps &&
      e.deps.length === prev.deps.length &&
      e.deps.every((d, i) => Object.is(d, prev.deps[i]))
    if (same) return
    if (prev?.cleanup) prev.cleanup()
    const cleanup = e.fn()
    effectSlots[n] = { deps: e.deps, cleanup }
  })
}
const tick = () => new Promise((r) => setTimeout(r, 0))

/** 反复 渲染 → 跑 effect → 等 promise 落地，直到没有新 state */
async function settle(max = 12) {
  let tree = null
  for (let s = 0; s < max; s++) {
    tree = renderOnce()
    runEffects()
    dirty = 0
    for (let t = 0; t < 4; t++) await tick()
    if (dirty === 0) break
  }
  return tree
}

/** 从假树里抠出纯文本，用来断言「屏幕上到底显示了什么」 */
function textOf(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const kids = node.props?.children
  return textOf(kids)
}

/** 找树里第一个 className 含指定串的节点 */
function find(node, cls) {
  if (!node || typeof node !== 'object') return null
  if (typeof node.props?.className === 'string' && node.props.className.includes(cls)) return node
  const kids = node.props?.children
  const list = Array.isArray(kids) ? kids : (kids == null ? [] : [kids])
  for (const k of list) {
    const found = find(k, cls)
    if (found) return found
  }
  return null
}

const BOOKS = [
  { rel: 'a.md', name: 'a.md', dir: '', size: 100, mtime: '2026-10-22T08:00:00.000Z', excerpt: '甲' },
  { rel: 'sub/b.md', name: 'b.md', dir: 'sub', size: 200, mtime: '2026-10-21T08:00:00.000Z', excerpt: '乙' },
]
const LIST_OK = {
  status: 200,
  body: { root: 'R', created: false, missing: false, books: BOOKS, groups: [{ key: '', books: [BOOKS[0]] }, { key: 'sub', books: [BOOKS[1]] }] },
}
const DOC_OK = { status: 200, body: { rel: 'a.md', name: 'a.md', text: '# 标题\n\n正文。', size: 100, mtime: '2026-10-22T08:00:00.000Z' } }

// ═══════════════════════════════════════════════════════════════
console.log('== 1. 正常路径：列表 + 正文都成功，右栏显示正文 ==')
routes = { '/api/list': () => LIST_OK, '/api/read': () => DOC_OK }
let tree = await settle()
let body = find(tree, 'bfm-body')
check('列表加载出 2 本', (textOf(find(tree, 'bfm-list')) || '').includes('共 2 本'), textOf(find(tree, 'bfm-list')).slice(0, 60))
check('右栏是正文容器', !!find(tree, 'bfm-doc'))
check('正文标题渲染出来', textOf(body).includes('标题'), textOf(body).slice(0, 80))
check('正文段落渲染出来', textOf(body).includes('正文。'))
check('没有残留错误提示', !textOf(body).includes('没能翻开'))

// ═══════════════════════════════════════════════════════════════
console.log('\n== 2. 回归核心：读某一本失败时必须把错误显示出来 ==')
// 这是原来那个 bug —— 修复前这里会永远显示「正在翻…」
routes = {
  '/api/list': () => LIST_OK,
  '/api/read': () => ({ status: 500, body: { error: '这本不存在' } }),
}
hooks.length = 0; effectSlots.length = 0
tree = await settle()
body = find(tree, 'bfm-body')
const bodyText = textOf(body)
check('不再卡在「正在翻…」', !bodyText.includes('正在翻'), bodyText.slice(0, 100))
check('显示「这本没能翻开」', bodyText.includes('这本没能翻开'), bodyText.slice(0, 120))
check('带上后端给的原因', bodyText.includes('这本不存在'), bodyText.slice(0, 120))
check('显示是哪一本失败的', bodyText.includes('a.md'), bodyText.slice(0, 120))
check('列表没有被顶掉，仍然是 2 本', textOf(find(tree, 'bfm-list')).includes('共 2 本'))
check('提供了重试按钮', !!find(body, 'bfm-reload'), textOf(body).slice(0, 80))

// ═══════════════════════════════════════════════════════════════
console.log('\n== 3. 重试：点一次「再试一次」，后端恢复后能读出来 ==')
// 找到重试按钮，触发 onClick（这里会 setReadKey +1 → effect 重跑）
let readAttempts = 0
routes = {
  '/api/list': () => LIST_OK,
  '/api/read': () => {
    readAttempts++
    return readAttempts === 1 ? { status: 500, body: { error: '这本不存在' } } : DOC_OK
  },
}
hooks.length = 0; effectSlots.length = 0
readAttempts = 0
tree = await settle()
body = find(tree, 'bfm-body')
check('第一次失败', textOf(body).includes('这本没能翻开'))
const retryBtn = find(body, 'bfm-reload')
retryBtn?.props?.onClick?.()
tree = await settle()
body = find(tree, 'bfm-body')
check('点重试后读到了正文', !!find(tree, 'bfm-doc'), textOf(body).slice(0, 100))
check('错误提示已消失', !textOf(body).includes('没能翻开'))
check('确实又请求了一次', readAttempts === 2, String(readAttempts))

// ═══════════════════════════════════════════════════════════════
console.log('\n== 4. reveal 失败不能污染正文与列表 ==')
routes = {
  '/api/list': () => LIST_OK,
  '/api/read': () => DOC_OK,
  '/api/reveal': () => ({ status: 500, body: { error: '路径越界' } }),
}
hooks.length = 0; effectSlots.length = 0
tree = await settle()
// 触发「打开文件夹」
const openBtn = find(find(tree, 'bfm-list'), 'bfm-reload')
openBtn?.props?.onClick?.()
tree = await settle()
body = find(tree, 'bfm-body')
check('正文仍然在', !!find(tree, 'bfm-doc'), textOf(body).slice(0, 100))
check('正文里没有出现错误', !textOf(body).includes('打不开文件夹'), textOf(body).slice(0, 100))
const noteEl = find(find(tree, 'bfm-list'), 'bfm-note')
check('左栏飘出一行提示', !!noteEl, textOf(find(tree, 'bfm-list')).slice(0, 200))
check('提示里说明了原因', textOf(noteEl).includes('打不开文件夹') && textOf(noteEl).includes('路径越界'), textOf(noteEl))

// ═══════════════════════════════════════════════════════════════
console.log('\n== 5. 换本时要清掉上一本的错误 ==')
// 先让 a.md 失败，再切到 sub/b.md 让它成功 —— 错误不能跟过去
routes = {
  '/api/list': () => LIST_OK,
  '/api/read': (u) => (u.includes('a.md')
    ? { status: 500, body: { error: '这本不存在' } }
    : { status: 200, body: { rel: 'sub/b.md', name: 'b.md', text: '乙的正文', size: 200, mtime: '2026-10-21T08:00:00.000Z' } }),
}
hooks.length = 0; effectSlots.length = 0
tree = await settle()
check('先显示 a.md 的错误', textOf(find(tree, 'bfm-body')).includes('这本没能翻开'))
// 点第二本
const secondItem = (() => {
  const list = find(tree, 'bfm-list')
  let hit = null
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (typeof n.props?.className === 'string' && n.props.className.includes('bfm-item')) {
      if (!hit && textOf(n).includes('b.md')) hit = n
    }
    const kids = n.props?.children
    const arr = Array.isArray(kids) ? kids : (kids == null ? [] : [kids])
    arr.forEach(walk)
  })(list)
  return hit
})()
check('找到第二本书的条目', !!secondItem, textOf(find(tree, 'bfm-list')).slice(0, 160))
secondItem?.props?.onClick?.()
tree = await settle()
body = find(tree, 'bfm-body')
check('换本后显示 b.md 正文', textOf(body).includes('乙的正文'), textOf(body).slice(0, 100))
check('旧错误没有跟过来', !textOf(body).includes('没能翻开'))

// ═══════════════════════════════════════════════════════════════
console.log('\n== 6. 列表整体失败：仍走整页错误页 ==')
routes = { '/api/list': () => ({ status: 500, body: { error: '读取失败' } }) }
hooks.length = 0; effectSlots.length = 0
tree = await settle()
check('显示整页错误', textOf(tree).includes('出错了'), textOf(tree).slice(0, 100))
check('带后端原因', textOf(tree).includes('读取失败'))
check('有重读按钮', !!find(tree, 'bfm-reload'))

// ═══════════════════════════════════════════════════════════════
console.log('\n== 7. 后端返回非 JSON 时给出可读信息，而不是崩在解析上 ==')
routes = {
  '/api/list': () => LIST_OK,
  '/api/read': () => ({ status: 500, body: '' }),   // 空 body
}
hooks.length = 0; effectSlots.length = 0
tree = await settle()
body = find(tree, 'bfm-body')
check('空 body 不抛解析错', !textOf(body).includes('Unexpected end of JSON'), textOf(body).slice(0, 120))
check('给出版本可读的失败信息', textOf(body).includes('这本没能翻开'), textOf(body).slice(0, 120))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
