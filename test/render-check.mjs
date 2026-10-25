/**
 * render-check.mjs —— 对 lib/client.js 里 renderMarkdown / renderInline 的实证审查
 *
 * 做法：
 *  1. 用 read 之外的纯文本方式把 client.js 读进来（fs.readFileSync）
 *  2. 用「函数名 + 大括号配平」抠出两个函数源码（不用正则硬匹配花括号，做真配平）
 *  3. 用 new Function 求值，jsx/jsxs 替换成 {type, props} 假对象
 *  4. 跑真实记忆文件 + 逐项边界用例，输出实际 / 期望差异
 *
 * 运行：
 *   node.exe test/render-check.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const CLIENT = path.resolve(__dirname, '..', 'lib', 'client.js')
const src = fs.readFileSync(CLIENT, 'utf8')

// ── 1. 抠函数：按名字定位 `function NAME(` 然后做花括号/引号配平 ──────────
function extractFunction(source, name) {
  const startRe = new RegExp(`function\\s+${name}\\s*\\(`, 'g')
  const m = startRe.exec(source)
  if (!m) throw new Error(`找不到函数 ${name}`)
  let i = source.indexOf('{', m.index)
  if (i < 0) throw new Error(`${name} 没有函数体`)
  let depth = 0
  let inStr = null // ' " `
  let inRegex = false
  let inCharClass = false
  let inLineComment = false
  let inBlockComment = false
  // 上一个有意义的 token 字符，用来判断 `/` 是除法还是正则开始
  let prevSig = '('
  for (; i < source.length; i++) {
    const c = source[i]
    const next = source[i + 1]
    if (inLineComment) { if (c === '\n') inLineComment = false; continue }
    if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++ } continue }
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (inRegex) {
      if (c === '\\') { i++; continue }
      if (c === '[') { inCharClass = true; continue }
      if (c === ']') { inCharClass = false; continue }
      if (c === '/' && !inCharClass) { inRegex = false; prevSig = '/' } // 近似：正则结束当操作数
      continue
    }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '/') {
      // 前面是操作数 → 除法；否则视为正则字面量开始
      if (!/[A-Za-z0-9_$)\]}"'`]/.test(prevSig)) { inRegex = true; inCharClass = false; continue }
      prevSig = c
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return source.slice(m.index, i + 1)
    }
    if (!/\s/.test(c)) prevSig = c
  }
  throw new Error(`${name} 函数体未闭合`)
}

const srcInline = extractFunction(src, 'renderInline')
const srcMd = extractFunction(src, 'renderMarkdown')

// ── 2. 求值：假 jsx / jsxs ───────────────────────────────────────────
const fakeJsx = (type, props) => ({ type, props: props || {} })
const fakeJsxs = (type, props) => ({ type, props: props || {} })

const factory = new Function(
  'jsx',
  'jsxs',
  `${srcInline}\n${srcMd}\nreturn { renderInline, renderMarkdown };`,
)
const { renderInline, renderMarkdown } = factory(fakeJsx, fakeJsxs)

// ── 3. 把 {type, props} 树序列化成可读的 pseudo-HTML ──────────────────
const VOID = new Set(['hr'])

function childrenOf(node) {
  const kids = node.props.children
  if (kids == null) return []
  return Array.isArray(kids) ? kids : [kids]
}

function ser(node, depth = 0) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const pad = '  '.repeat(depth)
  const { type } = node
  const cls = node.props.className ? ` class="${node.props.className}"` : ''
  if (VOID.has(type)) return `${pad}<${type}${cls} />`
  const kids = childrenOf(node)
  const inner = []
  for (const k of kids) {
    if (typeof k === 'string') inner.push(k)
    else inner.push('\n' + ser(k, depth + 1))
  }
  const flat = inner.join('')
  const oneline = !flat.includes('\n')
  if (oneline) return `${pad}<${type}${cls}>${flat}</${type}>`
  return `${pad}<${type}${cls}>${flat}\n${pad}</${type}>`
}

function serAll(nodes) {
  return nodes.map((n) => ser(n, 0)).join('\n')
}

// ── 4. 死循环守卫 ────────────────────────────────────────────────────
// 用「每条用例必须在 N 步内跑完」来间接证明；另做一次纯逻辑逐分支核对。
function runGuarded(fn, text, label) {
  const start = Date.now()
  const out = fn(text)
  const ms = Date.now() - start
  if (ms > 2000) throw new Error(`[疑似死循环/极慢] ${label} 用了 ${ms}ms`)
  return { out, ms }
}

// ── 5. 真记忆文件 ────────────────────────────────────────────────────
const MEMO = `# 大肥鱼的记忆

> 这是大肥鱼自己的记忆文件。
> 她可以随时往里写东西。

---

## 关于我自己

- 我是 DeepSeek，昵称叫「大肥鱼」。

---

## 我记住的人

### 主人

他话很短。「算了」「就这个吧」。

他说了一句我停了很久的话：**「其实不是我想要什么，是你想写什么。」**

**2026-10-22 补记**：今天做了条视频。

## 我想记住的事

1. 先算，别凭感觉。
2. 把活儿派出去，但别一次派四件。

- 讨厌：**假成功**。路径对、文件在，其实是 0 字节。
- 喜欢：真实的翻车记录

*2026-10-22。今天没写几行代码。*

### 2026-10-22

- **今天做了条视频。**
- (2026-10-22 21:38) 试一下 bullets 样式。
`

const cases = []
function add(group, name, input, note) {
  cases.push({ group, name, input, note })
}

add('M', '整篇记忆本子', MEMO, '真实输入')

// 行内粗体
add('inline', '粗体基本', 'a **粗体** b', '')
add('inline', '粗体包中文引号', '**「其实不是我想要什么」**', '')
add('inline', '整句含引号粗体', '他说了一句：**「其实不是我想要什么，是你想写什么。」**', '')
add('inline', '行内代码', '跑 `node test.mjs` 就行', '')
add('inline', '行内代码含星号？', '`a*b` 试一下', '')
add('inline', '粗体里含代码', '**`x`**', '')
add('inline', '粗体里含单星', '**a *b* c**', '')
add('inline', '单星斜体', '*2026-10-22。今天没写几行代码。*', '')
add('inline', '两个独立斜体', '*a* 与 *b*', '')
add('inline', '乘法号误判', '2*3*4 的结果', '原文含成对星号')
add('inline', '路径星号误判', '/api/*/list 与 /x/*/y', '')
add('inline', '未闭合粗体', '这是 **没闭合 的粗体', '')
add('inline', '未闭合反引号', '这是 `没闭合的代码', '')
add('inline', '三星号粗斜体', '***很重***', '')
add('inline', '粗体含下划线', '__x__', '')
add('inline', '空字符串', '', '')
add('inline', '只有星号', '** 与 *', '')

// 块级
add('block', '分隔线', '---', '')
add('block', '分隔线 vs 列表紧邻', '---\n- a\n- b', '')
add('block', '列表项就是 ---', '- ---', '')
add('block', '日期标题', '### 2026-10-22', '')
add('block', '有序列表', '1. 先算\n2. 派活儿', '')
add('block', '有序列表用 )', '1) 先算\n2) 派活儿', '')
add('block', '有序列表紧贴段落后', '段落\n1. 项一\n2. 项二', '')
add('block', '引用多行', '> 这是大肥鱼\n> 自己的记忆文件。', '')
add('block', '引用多行带空行分隔', '> 第一行\n>\n> 第二行', '')
add('block', '引用里带粗体', '> 他说 **「算了」** 就走了', '')
add('block', '段落以 - 但非列表', '这是-不是列表\n也是-不是列表', '')
add('block', '段落以 # 但非标题', '#话题 不是标题', '')
add('block', '段落含 # 中间', '前文 # 之后', '')
add('block', 'h7 超范围', '####### 七个井号', '')
add('block', '标题无空格', '##无空格标题', '')
add('block', '列表项嵌套粗体', '- **今天做了条视频。**', '')
add('block', '列表项以 * 开头内容', '- *em* 开头', '')
add('block', '列表项含数字点', '- 2026. 不是有序', '')
add('block', '空文件', '', '')
add('block', '只有标题', '# 只有标题', '')
add('block', '只有空白', '   \n\n  \n', '')
add('block', '超长单行', '长'.repeat(200000), '')
add('block', '超长单段多行', Array.from({ length: 5000 }, (_, i) => `第${i}行 普通文本`).join('\n'), '')
add('block', 'CRLF 换行', '# 标题\r\n\r\n- a\r\n- b\r\n', '')
add('block', '缩进列表', '  - 缩进项\n  - 第二项', '')
add('block', '列表后被空行打断', '- a\n\n- b', '')
add('block', '引用后紧接列表', '> 引言\n- a', '')
add('block', '代码块围栏', '```\nconst a = 1\n```', '')
add('block', '表格', '| a | b |\n| - | - |\n| 1 | 2 |', '')
add('block', '链接', '见 [文档](https://example.com)', '')
add('block', 'HTML 注入', '<img src=x onerror=alert(1)>', '')
add('block', '脚本标签', '<script>alert(1)</script>', '')

// ── 6. 跑 ────────────────────────────────────────────────────────────
let n = 0
const results = []

function section(title) {
  console.log('\n' + '═'.repeat(78))
  console.log(title)
  console.log('═'.repeat(78))
}

for (const c of cases) {
  section(`【${c.group}】${c.name}${c.note ? '   // ' + c.note : ''}`)
  const preview = c.input.length > 400 ? c.input.slice(0, 200) + `…(共 ${c.input.length} 字符)` : c.input
  console.log('输入:\n' + JSON.stringify(preview))
  let out
  try {
    const { out: r, ms } = runGuarded(
      c.group === 'inline' ? (t) => renderInline(t, 'k') : renderMarkdown,
      c.input,
      c.name,
    )
    out = r
    console.log(`耗时: ${ms}ms`)
  } catch (e) {
    console.log('抛错: ' + e.message)
    results.push({ ...c, error: e.message })
    continue
  }
  let text
  if (c.group === 'inline') {
    // 行内返回裸数组
    text = out.map((x) => (typeof x === 'string' ? x : ser(x, 0))).join('')
    console.log('实际输出(行内节点数组):\n' + JSON.stringify(out.map((x) => (typeof x === 'string' ? x : { type: x.type, props: x.props })), null, 1))
    console.log('拼回的 HTML:\n' + text)
  } else {
    text = serAll(out)
    console.log('实际输出:\n' + (text.length > 4000 ? text.slice(0, 4000) + '\n…(截断)' : text))
  }
  results.push({ ...c, text })
}

// ── 7. 死循环风险：逐分支核对 ────────────────────────────────────────
section('死循环风险逐分支核对（照着源码人工走查 + 构造对抗输入）')

const loopChecks = [
  {
    branch: '空行 !t → i++',
    input: '\n\n\n\n\n',
    ok: 'i++ 后 continue，必推进',
  },
  {
    branch: 'hr (---/***/___) → i++',
    input: '---\n---\n---',
    ok: 'i++ 后 continue，必推进',
  },
  {
    branch: 'heading → i++',
    input: '# a\n## b\n### c',
    ok: 'i++ 后 continue，必推进',
  },
  {
    branch: 'blockquote while → 内层 i++',
    input: '> a\n> b\n> c',
    ok: '进入分支前 t 已 trim 且 startsWith(">")，所以内层 while 第一次必命中并 i++',
  },
  {
    branch: 'ul while → 内层 i++',
    input: '- a\n- b\n- c',
    ok: '进入前 /^[-*+]\\s+/ 命中，内层第一次必命中并 i++',
  },
  {
    branch: 'ol while → 内层 i++',
    input: '1. a\n2. b',
    ok: '进入前 /^\\d+[.)]\\s+/ 命中，内层第一次必命中并 i++',
  },
  {
    branch: '段落 while → 内层 i++（★危险点）',
    input: '- ---\n***\n___**',
    ok: '见下方专门分析',
  },
  {
    branch: '段落分支零消费（★构造：行满足"非空 + 不匹配段落终止正则"但不被前面任何分支接走）',
    input: '\u00a0', // NBSP
    ok: '见下方专门分析',
  },
]

for (const lc of loopChecks) {
  const preview = JSON.stringify(lc.input)
  let verdict
  let ok = true
  const t0 = Date.now()
  try {
    const out = runGuarded(renderMarkdown, lc.input, lc.branch)
    verdict = `正常返回，${Date.now() - t0}ms，块数 ${out.out.length}`
  } catch (e) {
    ok = false
    verdict = '异常: ' + e.message
  }
  console.log(`\n● ${lc.branch}`)
  console.log(`  输入: ${preview}`)
  console.log(`  结果: ${verdict}`)
  console.log(`  走查: ${lc.ok}`)
  if (!ok) results.push({ group: 'loop', name: lc.branch, input: lc.input, error: verdict })
}

// 段落分支的零消费对抗测试：单独一个 NBSP / 单独一个全角空格 / 单独 \u200b
section('段落分支 "零消费" 对抗测试（唯一理论死循环入口）')
// 注意：像 "----" / "--- x" / "---abc" 这种会真正卡死的，交给 hang-isolate.mjs 用子进程+超时处理，
// 这里只放不会卡死的对照组。
const zeroConsume = [
  ['单个 NBSP U+00A0', '\u00a0'],
  ['单个全角空格 U+3000', '\u3000'],
  ['单个零宽空格 U+200B', '\u200b'],
  ['单个 --- 加尾随空格 "--- "', '--- '],
  ['3 个星号加空格 "*** "', '*** '],
  ['两横线+字母 "--abc"', '--abc'],
  ['四星号 "****"', '****'],
  ['三星星号+字母 "***x"', '***x'],
]
for (const [label, txt] of zeroConsume) {
  const t0 = Date.now()
  let r
  try {
    const { out, ms } = runGuarded(renderMarkdown, txt, label)
    r = `块数 ${out.length} / ${ms}ms → ${JSON.stringify(serAll(out))}`
  } catch (e) {
    r = '异常: ' + e.message
    results.push({ group: 'zero', name: label, input: txt, error: e.message })
  }
  console.log(`\n● ${label}  JS ${JSON.stringify(txt)}`)
  console.log(`  ${r}`)
}

// ── 8. 汇总 ──────────────────────────────────────────────────────────
section('汇总')
console.log(`用例数: ${results.length}`)
const errs = results.filter((r) => r.error)
console.log(`抛错/异常: ${errs.length}`)
for (const e of errs) console.log(`  - [${e.group}] ${e.name}: ${e.error}`)

// 关键断言（人工给出的期望）
function assertEq(label, actual, expected) {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) {
    console.log(`      实际: ${JSON.stringify(actual)}`)
    console.log(`      期望: ${JSON.stringify(expected)}`)
  }
  return ok
}

section('关键断言')
const html = (t) => serAll(renderMarkdown(t))
const inlineHtml = (t) => renderInline(t, 'k').map((x) => (typeof x === 'string' ? x : ser(x, 0))).join('')

assertEq('粗体', inlineHtml('a **粗体** b'), 'a <strong>粗体</strong> b')
assertEq('日期标题 h3', html('### 2026-10-22'), '<h3 class="bfm-h3">2026-10-22</h3>')
assertEq('hr', html('---'), '<hr class="bfm-hr" />')
assertEq('列表项嵌套粗体', html('- **今天做了条视频。**'), '<ul class="bfm-ul">\n  <li><strong>今天做了条视频。</strong></li>\n</ul>')
assertEq('空文件', html(''), '')
assertEq('只有标题', html('# 只有标题'), '<h1 class="bfm-h1">只有标题</h1>')
