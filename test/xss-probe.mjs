/**
 * xss-probe.mjs —— 验证渲染出的 children 是字符串还是 React 元素
 *
 * 关键点：React 会把 string children 自动转义成文本，不会当 HTML 解析。
 * 所以「<img onerror> 原样出现在输出里」并不等于 XSS —— 取决于宿主是否
 * 用了 dangerouslySetInnerHTML。
 */

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const client = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

console.log('=== 1. client.js 是否出现危险的 HTML 注入 API ===')
for (const pat of ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function']) {
  const n = (client.match(new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
  console.log(`  ${pat.padEnd(24)} 出现 ${n} 次`)
}

console.log('\n=== 2. 渲染出的 children 类型 ===')
const src = client
const a = src.indexOf('function renderInline')
const b = src.indexOf('// ── 样式')
const factory = new Function('jsx', 'jsxs', `${src.slice(a, b)}\nreturn { renderInline, renderMarkdown };`)
const fake = (t, p) => ({ type: t, props: p || {} })
const { renderMarkdown } = factory(fake, fake)

for (const input of ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '文本 **粗** 后面']) {
  const blocks = renderMarkdown(input)
  const p = blocks[0]
  const kids = p.props.children
  const kinds = kids.map((k) => (typeof k === 'string' ? 'string' : `ELEMENT(${k.type})`))
  console.log(`  输入 ${JSON.stringify(input)}`)
  console.log(`    <p> 的 children: ${JSON.stringify(kids)}`)
  console.log(`    类型: ${kinds.join(', ')}`)
  console.log(`    → ${kinds.every((k) => k === 'string' || k.startsWith('ELEMENT'))
      ? '全部是 string / React 元素，React 渲染时会自动转义，不构成 XSS'
      : '有未知类型，需人工确认'}`)
}

console.log('\n=== 3. React 元素被塞进字符串位置的情况（潜在的 [object Object] 风险）===')
const blocks = renderMarkdown('| a | **b** |')
console.log(`  表格行输入 "| a | **b** |" 的 children:`, JSON.stringify(blocks[0].props.children))

console.log('\n=== 4. key 是否唯一（React 重复 key 只是警告，但值得记录）===')
function walk(node, depth, acc) {
  if (!node || typeof node === 'string') return
  const kids = node.props?.children
  const arr = Array.isArray(kids) ? kids : kids != null ? [kids] : []
  const ks = arr.filter((k) => k && typeof k === 'object').map((k) => k.props?.key)
  if (ks.length) acc.push(`<${node.type}> keys=${JSON.stringify(ks)}`)
  arr.forEach((k) => walk(k, depth + 1, acc))
}
for (const input of ['- **a** **b**\n- **c**', '**a** **b** 和 **c**']) {
  const bs = renderMarkdown(input)
  const acc = []
  bs.forEach((x) => walk(x, 0, acc))
  const allKeys = acc.map((l) => l.match(/\[.*\]/)[0]).join(' ')
  console.log(`  输入 ${JSON.stringify(input)}`)
  acc.forEach((l) => console.log('    ' + l))
  const nums = [...allKeys.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  const dup = nums.filter((v, i) => nums.indexOf(v) !== i)
  console.log(`    重复 key: ${dup.length ? JSON.stringify([...new Set(dup)]) : '无'}`)
}
