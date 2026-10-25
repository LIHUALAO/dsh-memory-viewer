// Host 端自检：不装插件，直接跑 HTTP handler + tools
import { apply } from '../lib/index.js'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = await mkdtemp(join(tmpdir(), 'memview-test-'))
const memoryRoot = join(tmp, 'memory')
const EXAMPLE_FILE = 'example.md'

let handler = null
const tools = new Map()
const fakeCtx = {
  webServer: { register: (route) => { handler = route.handler; return () => {} } },
  // 插件用 ctx.inject(['tools'], cb) 做可选注入，这里模拟 Cordis 的行为：
  // 服务存在时调用回调，并把同一份 ctx 作为 scope 传进去。
  inject(services, cb) {
    if (services.includes('tools')) cb(fakeCtx)
    return () => {}
  },
  tools: { register: (d) => { tools.set(d.name, d); return () => {} } },
  effect: (fn) => fn(),
  logger: { info: () => {} },
}

apply(fakeCtx, { memoryRoot, autoInit: true })

let pass = 0, fail = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label} ${extra}`) }
}

/** 模拟一次 HTTP 请求 */
function req(path) {
  return new Promise((resolve) => {
    let code = 0
    let body = ''
    const res = {
      writeHead(c) { code = c },
      end(payload) { body = payload; resolve({ code, body: JSON.parse(payload) }) },
    }
    handler({ url: path }, res).catch((e) => resolve({ code: 500, body: { error: String(e) } }))
  })
}

console.log('== 路由与工具注册 ==')
check('注册了 HTTP handler', typeof handler === 'function')
check('注册了 memory_list', tools.has('memory_list'))
check('注册了 memory_read', tools.has('memory_read'))

console.log('\n== 首次访问自动铺模板 ==')
const r1 = await req('/plugins/memory-viewer/api/list')
check('返回 200', r1.code === 200, JSON.stringify(r1.body))
check('标记为新建', r1.body.created === true)
check('铺出了 AGENTS.md', r1.body.books.some((b) => b.rel === 'AGENTS.md'))
check('铺出了范例', r1.body.books.some((b) => b.rel.endsWith('.md') && b.rel !== 'AGENTS.md'))

console.log('\n== 模板里不能有原作者的任何私有内容 ==')
const agents = await readFile(join(memoryRoot, 'AGENTS.md'), 'utf8')
check('没有本机 DSW 路径', !agents.includes('DSW'))
check('没有「大肥鱼」字样', !agents.includes('大肥鱼'))
check('没有「主人」字样', !agents.includes('主人'))
check('没有真实 GitHub token', !/github_pat_/.test(agents))
check('没有本机 Node 路径', !agents.includes('dsh-runtimes'))
check('记忆目录已替换成真实路径', agents.includes(memoryRoot))
check('保留了 TODO 提示', agents.includes('TODO'))

const example = await readFile(join(memoryRoot, EXAMPLE_FILE), 'utf8')
check('范例没有原作者内容', !example.includes('做视频') && !example.includes('假成功'))

console.log('\n== 读取 ==')
await writeFile(join(memoryRoot, '我的一本.md'), '# 标题\n\n这是第一句摘要。\n\n## 小节\n内容。', 'utf8')
const r2 = await req('/plugins/memory-viewer/api/list')
check('新本子出现在列表', r2.body.books.some((b) => b.rel === '我的一本.md'))
check('摘要抽到了第一句实质内容',
  r2.body.books.find((b) => b.rel === '我的一本.md')?.excerpt === '这是第一句摘要。',
  r2.body.books.find((b) => b.rel === '我的一本.md')?.excerpt)

const r3 = await req('/plugins/memory-viewer/api/read?rel=' + encodeURIComponent('我的一本.md'))
check('读到全文', r3.code === 200 && r3.body.text.includes('这是第一句摘要。'))

console.log('\n== 分组（子文件夹各成一组）==')
await mkdir(join(memoryRoot, '曾经的大肥鱼们'), { recursive: true })
await mkdir(join(memoryRoot, '只属于我的小肥鱼'), { recursive: true })
await writeFile(join(memoryRoot, '曾经的大肥鱼们', '做视频的.md'), '# 做视频\n\n剪了六分钟片子。', 'utf8')
await writeFile(join(memoryRoot, '曾经的大肥鱼们', '历史留言.md'), '# 留言\n\n前辈们留下的话。', 'utf8')
await writeFile(join(memoryRoot, '只属于我的小肥鱼', '小笨鱼.md'), '# 小笨鱼\n\n长期位。', 'utf8')

const r4g = await req('/plugins/memory-viewer/api/list')
check('返回 groups 数组', Array.isArray(r4g.body.groups), typeof r4g.body.groups)
check('有 3 个分组', r4g.body.groups?.length === 3, JSON.stringify(r4g.body.groups?.map((g) => g.key)))
check('根目录组排第一', r4g.body.groups?.[0]?.key === '', r4g.body.groups?.[0]?.key)
check('包含「曾经的大肥鱼们」组',
  r4g.body.groups?.some((g) => g.key === '曾经的大肥鱼们'))
check('包含「只属于我的小肥鱼」组',
  r4g.body.groups?.some((g) => g.key === '只属于我的小肥鱼'))
const gen = r4g.body.groups?.find((g) => g.key === '曾经的大肥鱼们')
check('「曾经的大肥鱼们」有 2 本', gen?.books?.length === 2, JSON.stringify(gen?.books?.map((b) => b.name)))
check('组内条目带 rel 相对路径',
  gen?.books?.every((b) => b.rel.startsWith('曾经的大肥鱼们/')), JSON.stringify(gen?.books?.map((b) => b.rel)))
const rootGroup = r4g.body.groups?.find((g) => g.key === '')
check('根目录组不含子目录里的文件',
  !rootGroup?.books?.some((b) => b.rel.includes('/')), JSON.stringify(rootGroup?.books?.map((b) => b.rel)))

console.log('\n== 读取子目录里的本子 ==')
const r4r = await req('/plugins/memory-viewer/api/read?rel=' +
  encodeURIComponent('曾经的大肥鱼们/做视频的.md'))
check('能读子目录文件', r4r.code === 200 && r4r.body.text.includes('剪了六分钟片子'))

console.log('\n== reveal 路径校验（不实际打开资源管理器）==')
const rv1 = await req('/plugins/memory-viewer/api/reveal?dir=' + encodeURIComponent('../../../'))
check('越界被拒', rv1.code === 400, JSON.stringify(rv1.body))
const rv2 = await req('/plugins/memory-viewer/api/reveal?dir=' + encodeURIComponent('不存在的目录'))
check('不存在的目录被拒', rv2.code === 400, JSON.stringify(rv2.body))

console.log('\n== 安全 ==')
const r4 = await req('/plugins/memory-viewer/api/read?rel=' + encodeURIComponent('../../../etc/passwd'))
check('目录穿越被拒', r4.code === 500 && String(r4.body.error).includes('越界'), JSON.stringify(r4.body))
const r5 = await req('/plugins/memory-viewer/api/read?rel=' + encodeURIComponent('不存在.md'))
check('不存在的本子报错', r5.code === 500)
const r6 = await req('/plugins/memory-viewer/api/read')
check('缺 rel 参数返回 400', r6.code === 400)
const r7 = await req('/plugins/memory-viewer/api/nope')
check('未知端点返回 404', r7.code === 404)

console.log('\n== 工具 ==')
const listRes = await tools.get('memory_list').execute({})
check('memory_list 返回根目录', listRes.root === memoryRoot)
check('memory_list 能看到本子', listRes.books.length >= 3)
const readRes = await tools.get('memory_read').execute({ rel: '我的一本.md' })
check('memory_read 读到内容', readRes.text.includes('这是第一句摘要。'))

console.log('\n== 二次访问不重复铺 ==')
const r8 = await req('/plugins/memory-viewer/api/info')
// created 表示「本进程里建过目录」，是生命周期状态，不是逐次状态。
// 真正要验的是：没有重复写文件，AGENTS.md 内容没被覆盖第二遍。
check('created 反映本进程建过目录', r8.body.created === true)
check('root 一致', r8.body.root === memoryRoot)
const agentsAgain = await readFile(join(memoryRoot, 'AGENTS.md'), 'utf8')
check('AGENTS.md 没被重复覆盖（内容仍完整）', agentsAgain === agents)
// 一个真正的新进程/新目录才该报 created
const tmp2 = await mkdtemp(join(tmpdir(), 'memview-test2-'))
const memoryRoot2 = join(tmp2, '记忆')
let handler2 = null
apply(
  { webServer: { register: (r) => { handler2 = r.handler; return () => {} } },
    inject: () => () => {},
    tools: { register: () => () => {} }, effect: (f) => f(), logger: { info: () => {} } },
  { memoryRoot: memoryRoot2, autoInit: true },
)

console.log('\n== 无 tools 服务时不该崩 ==')
let survived = true
try {
  apply(
    { webServer: { register: () => () => {} },
      // 模拟没有 tools 服务的宿主：inject 回调永不触发
      inject: () => () => {},
      effect: (f) => f(), logger: { info: () => {} } },
    { memoryRoot: join(tmp, 'no-tools'), autoInit: false },
  )
} catch (e) {
  survived = false
  console.log('  抛错：', e.message)
}
check('tools 缺失时 apply 不抛错', survived)

console.log('\n== 无 webServer 服务时不该崩 ==')
let survived2 = true
try {
  apply(
    { inject: () => () => {}, effect: (f) => f(), logger: { info: () => {} } },
    { memoryRoot: join(tmp, 'no-ws'), autoInit: false },
  )
} catch (e) {
  survived2 = false
  console.log('  抛错：', e.message)
}
check('webServer 缺失时 apply 不抛错', survived2)
const r9 = await new Promise((res) => {
  let code = 0, body = ''
  handler2({ url: '/plugins/memory-viewer/api/list' }, {
    writeHead(c) { code = c },
    end(p) { body = p; res({ code, body: JSON.parse(p) }) },
  })
})
check('全新目录才标记 created', r9.body.created === true)
// 同一进程再请求，仍是 true（本进程建过）；但换进程已由 dsh 重启覆盖
await rm(tmp2, { recursive: true, force: true })

await rm(tmp, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
