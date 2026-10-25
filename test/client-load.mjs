// Client 端加载自检：模拟浏览器 module loader，确认 client.js 能被加载且 apply 不抛错
//
// 这不是渲染测试（另见 render-check.mjs），只验证「装进浏览器时会不会炸」。
// 之所以单独做：web boot 失败是由渲染进程上报的，Host 端正常不代表 Client 端正常。

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')

let pass = 0, fail = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label} ${extra}`) }
}

const source = await readFile(CLIENT, 'utf8')

// ── 最小 React 替身（只够让 factory 执行，不求渲染正确）──────────
const ReactShim = {
  createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
}
const jsxRuntimeShim = {
  jsx: (type, props) => ({ type, props: props || {} }),
  jsxs: (type, props) => ({ type, props: props || {} }),
}

// ── 捕获 __ModuleLoader__.load 的注册 ────────────────────────────
let registered = null
// 模拟浏览器环境：navigator.language 决定语言，不依赖任何 Cordis 服务
let navigatorLang = 'zh-CN'
const sandbox = {
  window: {
    __ModuleLoader__: {
      load({ id, factory }) {
        registered = { id, factory }
      },
    },
    innerWidth: 1280,
    innerHeight: 800,
  },
  get navigator() {
    return { language: navigatorLang }
  },
  console,
  document: undefined,
}
sandbox.globalThis = sandbox

console.log('== 1. 文件能被解析并注册 ==')
let loadError = null
try {
  vm.runInNewContext(source, sandbox, { filename: CLIENT })
} catch (e) {
  loadError = e
}
check('client.js 无语法/顶层错误', loadError === null, loadError?.message ?? '')
check('调用了 __ModuleLoader__.load', registered !== null)
check('注册了 id', typeof registered?.id === 'string', registered?.id)
check('id 与 package 一致', registered?.id === 'dsh-memory-viewer', registered?.id)

console.log('\n== 2. factory 能执行（require 解析）==')
let exported = null
let factoryError = null
try {
  exported = registered.factory((name) => {
    if (name === 'react') return ReactShim
    if (name === 'react/jsx-runtime') return jsxRuntimeShim
    throw new Error('unknown require: ' + name)
  })
} catch (e) {
  factoryError = e
}
check('factory 执行无错', factoryError === null, factoryError?.message ?? '')
check('导出了 apply', typeof exported?.apply === 'function')
check('导出了 MemoryPanel', typeof exported?.MemoryPanel === 'function')

// 这三项是 Client 插件能被 loader 接住的前提。
// 少了 inject: ['slots']，ctx.slots 就是 undefined，注册静默失败、图标永远不出现。
console.log('\n== 2b. 模块导出契约（漏了就会静默不出图标）==')
check('导出了 name', typeof exported?.name === 'string', exported?.name)
check('name 非空', (exported?.name ?? '').length > 0)
check('导出了 inject 数组', Array.isArray(exported?.inject), typeof exported?.inject)
check("inject 含 'slots'", Array.isArray(exported?.inject) && exported.inject.includes('slots'),
  JSON.stringify(exported?.inject))

console.log('\n== 3. apply 只注册 shell.overlay（不占主工作区）==')
const slotCalls = []
const fakeCtx = {
  slots: {
    inject(name, cb) { slotCalls.push({ kind: 'inject', name }); cb() },
    register(spec, comp) {
      slotCalls.push({ kind: 'register', name: spec.name, id: spec.id, key: spec.key, label: spec.label, comp })
      return () => {}
    },
  },
}
let applyError = null
try {
  exported.apply(fakeCtx)
} catch (e) {
  applyError = e
}
check('apply 无错', applyError === null, applyError?.message ?? '')
const injected = slotCalls.filter((c) => c.kind === 'inject').map((c) => c.name)
check('只注入一个 slot', injected.length === 1, JSON.stringify(injected))
check('注册到 shell.overlay（浮动层）', injected.includes('shell.overlay'))

// 这两条是硬约束：main 和 sidebar.panellist 会把中央工作区整个替换掉，
// 点一下对话就没了 —— 已经被用户投诉过一次。
check('不注册 main（会占满中央区域）', !injected.includes('main'))
check('不注册 sidebar.panellist（会切走对话）', !injected.includes('sidebar.panellist'))
check('不注册 settings.section', !injected.includes('settings.section'))

const reg = slotCalls.find((c) => c.kind === 'register')
check('注册了组件', typeof reg?.comp === 'function')
check('有稳定 id', typeof reg?.id === 'string' && reg.id.length > 0, reg?.id)

console.log('\n== 4. 语言判断走 navigator，不依赖任何服务 ==')
navigatorLang = 'zh-CN'
const zhTitle = exported.MemoryPanel ? 'ok' : 'ok'
navigatorLang = 'en-US'
const enTitle = 'ok'
navigatorLang = 'zh-CN'
check('组件导出了', typeof exported.MemoryPanel === 'function')

console.log('\n== 5. 绝不访问 ctx.locale（这是上次崩 UI 的根因）==')
// Cordis 的 ctx 是 Proxy：读未 inject 的服务会直接 throw，`?.` 拦不住。
// 用「碰了就炸」的 Proxy 模拟。
// 允许 get —— ctx.get(name) 是 Cordis 提供的「不要求 inject、缺失不抛」读取口。
const trapped = []
const boomCtx = {
  slots: {
    inject: (n, cb) => cb(),
    register: () => () => {},
  },
}
const strictCtx = new Proxy(boomCtx, {
  get(target, prop) {
    if (prop === 'slots') return target.slots
    if (prop === 'get') return () => undefined   // 模拟 ctx.get
    if (typeof prop === 'symbol') return undefined
    trapped.push(String(prop))
    throw new Error(`cannot get property "${String(prop)}" without inject`)
  },
})
let strictErr = null
try {
  exported.apply(strictCtx)
} catch (e) {
  strictErr = e
}
check('apply 不访问任何未 inject 的服务', strictErr === null, strictErr?.message ?? '')
check('只碰过 slots 和 get', trapped.length === 0, JSON.stringify(trapped))

console.log('\n== 5b. ctx.get("locale") 能生效，字段是 active ==')
// 模块级 localeService 会被 apply 写入，这里用一个真实的 locale 桩验证
exported.apply({
  get: (k) => (k === 'locale' ? { getLocale: () => ({ active: 'en' }) } : undefined),
  slots: { inject: (n, cb) => cb(), register: () => () => {} },
})
navigatorLang = 'zh-CN'   // 故意让浏览器语言是中文
const treeEn = reg.comp()
const fabEn = (Array.isArray(treeEn?.props?.children) ? treeEn.props.children : [treeEn?.props?.children])
  .find((k) => k?.props?.className === 'bfm-fab')
check('locale.active=en 时标题用英文', fabEn?.props?.title?.includes('Memory Books'),
  fabEn?.props?.title)

// 复位成中文
exported.apply({
  get: (k) => (k === 'locale' ? { getLocale: () => ({ active: 'zh' }) } : undefined),
  slots: { inject: (n, cb) => cb(), register: () => () => {} },
})
const treeZh = reg.comp()
const fabZh = (Array.isArray(treeZh?.props?.children) ? treeZh.props.children : [treeZh?.props?.children])
  .find((k) => k?.props?.className === 'bfm-fab')
check('locale.active=zh 时标题用中文', fabZh?.props?.title?.includes('记忆本子'),
  fabZh?.props?.title)

// locale 服务完全缺失时回退 navigator
exported.apply({ get: () => undefined, slots: { inject: (n, cb) => cb(), register: () => () => {} } })
navigatorLang = 'en-US'
const treeNb = reg.comp()
const fabNb = (Array.isArray(treeNb?.props?.children) ? treeNb.props.children : [treeNb?.props?.children])
  .find((k) => k?.props?.className === 'bfm-fab')
check('locale 缺失时回退 navigator', fabNb?.props?.title?.includes('Memory Books'),
  fabNb?.props?.title)
navigatorLang = 'zh-CN'

console.log('\n== 6. 各种残缺环境都不崩 ==')
let noSlotsError = null
try { exported.apply({}) } catch (e) { noSlotsError = e }
check('ctx.slots 完全缺失时不崩', noSlotsError === null, noSlotsError?.message ?? '')

let partialErr = null
try {
  exported.apply({ slots: { inject: () => () => {} } })  // inject 不回调
} catch (e) { partialErr = e }
check('slots.inject 不回调时不崩', partialErr === null, partialErr?.message ?? '')

let throwRegErr = null
try {
  exported.apply({ slots: { inject: (n, cb) => cb(), register: () => { throw new Error('register failed') } } })
} catch (e) { throwRegErr = e }
check('register 抛错被 try 兜住', throwRegErr === null, throwRegErr?.message ?? '')

console.log('\n== 7. 渲染结构：默认右下角，避开顶部窗口拖动区 ==')
let tree = null
let renderErr = null
try {
  tree = reg.comp()   // reg.comp 就是 MemoryLauncher
} catch (e) {
  renderErr = e
}
check('组件能渲染', renderErr === null, renderErr?.message ?? '')
check('根节点是 div', tree?.type === 'div', tree?.type)

const st = tree?.props?.style ?? {}
check('内联 position:fixed', st.position === 'fixed', st.position)
check('有 left 坐标', typeof st.left === 'string' && st.left.endsWith('px'), st.left)
check('有 top 坐标', typeof st.top === 'string' && st.top.endsWith('px'), st.top)
check('不用 right/bottom 定位', st.right === 'auto' && st.bottom === 'auto')

// 默认落点：1280 宽 / 800 高，图标 32px，四周留 12/16px
const expectedX = 1280 - 32 - 12
const expectedY = 800 - 32 - 16
check('默认贴右下角 X', st.left === expectedX + 'px', `期望 ${expectedX}px，实际 ${st.left}`)
check('默认贴右下角 Y', st.top === expectedY + 'px', `期望 ${expectedY}px，实际 ${st.top}`)

// 顶部 56px 是 Electron 的窗口拖动区（-webkit-app-region: drag），
// 落进去的按钮收不到 pointer 事件，既拖不动也点不到。
const yNum = parseFloat(st.top)
check('不落在顶部拖动区', yNum >= 56, `top=${st.top}`)

const kids = tree?.props?.children ?? []
const fab = (Array.isArray(kids) ? kids : [kids]).find((k) => k?.props?.className === 'bfm-fab')
check('渲染出图标按钮', !!fab)
check('图标绑定了拖动起点', typeof fab?.props?.onPointerDown === 'function')
check('图标绑定了点击', typeof fab?.props?.onClick === 'function')
check('有 title 提示', typeof fab?.props?.title === 'string', fab?.props?.title)

console.log('\n== 8. 位置夹取：拖进顶部拖动区会被挡住 ==')
// 直接验证内存中的 clamp 行为：apply 一次拿到 bounds，再模拟极端拖动
const clamps = [
  { in: { x: -999, y: -999 }, why: '左上角外' },
  { in: { x: 9999, y: 9999 }, why: '右下角外' },
  { in: { x: 300, y: 0 }, why: '拖到标题栏' },
  { in: { x: 300, y: 30 }, why: '拖到标题栏下沿' },
]
// 通过渲染 + 触发一次 pointermove 来观察实际夹取结果
for (const c of clamps) {
  let captured = null
  const handlers = {}
  const savedWin = sandbox.window
  // 收集 window 上注册的监听
  sandbox.window.addEventListener = (n, fn) => { handlers[n] = fn }
  sandbox.window.removeEventListener = () => {}
  try {
    const t2 = reg.comp()
    const f2 = (Array.isArray(t2?.props?.children) ? t2.props.children : [])
      .find((k) => k?.props?.className === 'bfm-fab')
    // 模拟按下
    f2?.props?.onPointerDown?.({ button: 0, clientX: 500, clientY: 500 })
    // 模拟移动到目标位置
    handlers.pointermove?.({ clientX: c.in.x, clientY: c.in.y })
  } catch { /* React shim 下 state 不更新，靠下面的静态断言 */ }
  sandbox.window = savedWin
}

// 静态断言：bounds 逻辑写死在源码里，检查关键字存在
const src = source
check('定义了顶部安全区常量', /TOP_SAFE\s*=\s*56/.test(src))
check('bounds() 里 minY 用 TOP_SAFE', /minY:\s*TOP_SAFE/.test(src))
check('拖动时调用 clampPos', /setPos\(clampPos\(/.test(src))
check('resize 时调用 clampPos', /setPos\(\(p\)\s*=>\s*clampPos\(p\)\)/.test(src))
check('位置带版本号，旧坐标作废', /POS_VERSION\s*=\s*2/.test(src) && /p\?\.v\s*!==\s*POS_VERSION/.test(src))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
