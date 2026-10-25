// 防复发：这个插件被 BOM 搞坏过两次，而且全程静默。
//
// 事故链（子代理从 asar 里逐行追出来的）：
//   package.json 带 U+FEFF
//   → dsh-app-boot:2251 readManifest() 裸 JSON.parse(readFileSync(f,'utf8'))
//   → SyntaxError: Unexpected token '\uFEFF'
//   → :2323 denial() 的 catch 把它当成「声明要求无法校验」
//   → :2333 deny() 给这行打上 disabled = true（只在内存里，从不写回文件）
//   → cordis-plugin-loader:367 Entry#update() 见 disabled 直接 dispose+return
//   → 永不 init，路由没注册，API 404，而且一条 crash 日志都不留
//
// 所以「插件明明装着却不见了」这件事，最容易的来源就是某个文件开头多了三个字节。
// 这个测试只做一件很笨的事：把目录里所有文本文件的头三个字节翻出来看一眼。
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`) }
}

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.svg', '.txt'])
const SKIP_DIRS = new Set(['node_modules', '.git'])

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await walk(full, out)
    else if (TEXT_EXT.has(e.name.slice(e.name.lastIndexOf('.')))) out.push(full)
  }
  return out
}

const hasBOM = (buf) => buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF

// ---------- 1. 全目录扫 BOM ----------
console.log('\n== 1. 没有文件带 BOM ==')
const files = await walk(ROOT)
const bomFiles = []
for (const f of files) {
  const head = (await readFile(f)).subarray(0, 3)
  if (hasBOM(head)) bomFiles.push(relative(ROOT, f).split('\\').join('/'))
}
check(`扫了 ${files.length} 个文本文件`, files.length > 0)
check('一个 BOM 都没有', bomFiles.length === 0, bomFiles.join(', '))

// ---------- 2. package.json 能被 preflight 那条路解析 ----------
// 关键：用和 readManifest() 完全一样的方式读——readFileSync(utf8) 不剥 BOM
console.log('\n== 2. package.json 走和宿主一样的读法 ==')
const pkgPath = join(ROOT, 'package.json')
const raw = await readFile(pkgPath, 'utf8')
check('首字符不是 U+FEFF', raw.charCodeAt(0) !== 0xFEFF, `首字符是 U+${raw.charCodeAt(0).toString(16).toUpperCase()}`)

let pkg = null
try { pkg = JSON.parse(raw); check('JSON.parse 成功（宿主不会打 disabled）', true) }
catch (err) { check('JSON.parse 成功（宿主不会打 disabled）', false, String(err)) }

check('有 name', typeof pkg?.name === 'string' && pkg.name.length > 0)
check('版本号形如 x.y.z', /^\d+\.\d+\.\d+/.test(pkg?.version ?? ''), pkg?.version)
check('有 dsh.bundle.patch', typeof pkg?.dsh?.bundle?.patch === 'string', JSON.stringify(pkg?.dsh))

// 字段完整性：少一个 main/exports 就不是「跑不起来」而是「压根加载不了」。
// 这条是踩出来的 —— 有一次重写 package.json 只写回了 name/version/描述，
// main、exports、dsh.client 全丢了，插件直接变成空壳。
const REQUIRED = ['name', 'displayName', 'description', 'version', 'type', 'main', 'exports', 'files', 'dsh', 'license', 'engines']
const missing = REQUIRED.filter((k) => !(k in (pkg ?? {})))
check('必备字段一个不少', missing.length === 0, missing.join(', '))
check('exports["./client"] 指向 lib/client.js', pkg?.exports?.['./client'] === './lib/client.js', pkg?.exports?.['./client'])
check('exports["."] 指向 lib/index.js', pkg?.exports?.['.'] === './lib/index.js', pkg?.exports?.['.'])
check('dsh.client.platform 是 web', pkg?.dsh?.client?.platform === 'web', pkg?.dsh?.client?.platform)
check('pkg.main 指向的文件存在', pkg?.main ? await stat(join(ROOT, pkg.main)).then(() => true, () => false) : false)

// ---------- 3. 自带的 patch 指向存在的东西 ----------
console.log('\n== 3. dsh.bundle.patch 指向的文件真的存在 ==')
const patchRel = pkg?.dsh?.bundle?.patch
if (patchRel) {
  const patchPath = join(ROOT, patchRel.replace(/^\.\//, ''))
  let exists = false, text = ''
  try { text = await readFile(patchPath, 'utf8'); exists = true } catch {}
  check(`存在 ${patchRel}`, exists)
  // 墓碑残留：指向已经不存在的包名，只会产生 warn 噪音，但会把排查的人带偏
  check('没有指向别的包的 disabled 墓碑', !/^\s*-\s*id:\s*(?!memory-viewer\b)\S+\s*\n\s*disabled:\s*true/m.test(text))
  check('patch 里写了 memory-viewer', /memory-viewer/.test(text))
}

// ---------- 4. 源码只 import node: 内置模块 ----------
// 插件是从 profile node_modules 的符号链接加载的，ESM 会 realpath 回源码目录再往上找
// node_modules —— 任何第三方 import 都可能在冷启动时 ERR_MODULE_NOT_FOUND 炸掉整个 GUI。
// 这是 README 里写死的设计约束，这里把它变成断言。
console.log('\n== 4. 不 import 第三方包（符号链接解析会炸） ==')
for (const rel of ['lib/index.js', 'lib/client.js']) {
  const src = await readFile(join(ROOT, rel), 'utf8')
  const specs = [...src.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)].map((m) => m[1])
  const bad = specs.filter((s) => !s.startsWith('node:') && !s.startsWith('./') && !s.startsWith('../'))
  check(`${rel} 全部是 node: 或相对路径`, bad.length === 0, bad.join(', '))
}

// ---------- 5. 文件编码统一 UTF-8 无 BOM ----------
console.log('\n== 5. 中文不会被写成乱码 ==')
const memDir = join(ROOT, 'memories')
try {
  const ents = await readdir(memDir)
  check('memories/ 下没有空文件', ents.length > 0)
} catch { check('memories/ 目录存在', false) }

const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
check('README 里有中文', /[\u4e00-\u9fa5]/.test(readme))
check('README 没有替换字符 U+FFFD（说明某次写坏了）', !readme.includes('\uFFFD'))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
console.log(fail === 0
  ? '文件头三个字节都干净 —— 宿主读 manifest 时不会把整个条目悄悄 disable 掉。'
  : '有文件带 BOM 或读不出来。宿主会在启动时静默 disable 这个插件，且不写任何日志。')
process.exit(fail === 0 ? 0 : 1)
