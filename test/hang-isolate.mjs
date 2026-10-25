/**
 * hang-isolate.mjs —— 在子进程里隔离验证死循环，父进程用超时杀
 *
 * 用法：
 *   node hang-isolate.mjs            → 跑全部样本，每个样本 2s 超时
 *   node hang-isolate.mjs worker "----x"  → 单样本 worker 模式（内部用）
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const CLIENT = path.resolve(__dirname, '..', 'lib', 'client.js')

// ── worker 模式：真正 eval 渲染器并跑单条输入 ─────────────────────────
if (process.argv[2] === 'worker') {
  const payload = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'))
  const src = fs.readFileSync(CLIENT, 'utf8')
  // 直接 eval 整个 factory 里的两个函数：用简单切片（两个函数相邻，中间无其他代码）
  const a = src.indexOf('function renderInline')
  const b = src.indexOf('// ── 样式')
  const code = src.slice(a, b)
  const factory = new Function('jsx', 'jsxs', `${code}\nreturn { renderInline, renderMarkdown };`)
  const fake = (t, p) => ({ type: t, props: p || {} })
  const { renderMarkdown } = factory(fake, fake)
  const out = renderMarkdown(payload.text)
  process.stdout.write(JSON.stringify({ ok: true, blocks: out.length, types: out.map((x) => x.type) }))
  process.exit(0)
}

// ── 父进程：超时判死 ─────────────────────────────────────────────────
const node = process.execPath

function runOne(text, ms = 2500) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(JSON.stringify({ text }), 'utf8').toString('base64')
    const child = spawn(node, [url.fileURLToPath(import.meta.url), 'worker', b64], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill('SIGKILL')
      resolve({ hang: true })
    }, ms)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (code === 0 && out) {
        try { resolve({ ...JSON.parse(out) }) } catch { resolve({ raw: out }) }
      } else {
        resolve({ crash: true, code, tail: (err || out).split('\n').filter(Boolean).slice(-3).join(' | ') })
      }
    })
  })
}

const samples = [
  ['---abc', '三横线+紧贴文字'],
  ['--- x', '三横线+空格+文字'],
  ['--- title', '三横线当 setext 标题的常见写法'],
  ['----', '四横线'],
  ['-----', '五横线'],
  ['--abc', '两横线+文字'],
  ['****', '四星号'],
  ['***x', '三星号+文字'],
  ['*** 粗斜体 ***', '三星号包文字带空格'],
  ['___x', '三下划线+文字'],
  ['_x_', '单下划线斜体'],
  ['---', '纯三横线（对照，应正常）'],
  ['> 引言\n--x', '引用后跟 --x'],
  ['正常段落\n----', '段落后跟四横线'],
  ['# 标题\n\n--- \n\n正文', '正常记忆本子片段'],
]

console.log('样本数:', samples.length, ' 每个超时 2500ms\n')
let hangs = []
for (const [text, label] of samples) {
  const r = await runOne(text)
  const verdict = r.hang
    ? '★★ 卡死（判定为死循环，强杀）'
    : r.crash
      ? `崩溃 code=${r.code}: ${r.tail}`
      : `OK blocks=${r.blocks} [${r.types.join(',')}]`
  if (r.hang) hangs.push([text, label])
  console.log(`${JSON.stringify(text).padEnd(28)} ${verdict}   // ${label}`)
}

console.log('\n=== 结论 ===')
if (hangs.length === 0) console.log('未发现卡死样本')
else {
  console.log(`确认死循环样本 ${hangs.length} 个：`)
  for (const [t, l] of hangs) console.log(`  - ${JSON.stringify(t)}  (${l})`)
}
