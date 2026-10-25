/**
 * 记忆本子浏览器 · Client 端
 *
 * 左侧栏一个图标 → 点开就是面板 → 左边列出所有本子，右边显示正文。
 * 纯 markdown 呈现，不引第三方库。
 */

window.__ModuleLoader__.load({
  id: 'dsh-memory-viewer',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    const API = '/plugins/memory-viewer/api'

    const zh = {
      title: '记忆本子',
      hint: '记忆本子 · 点开翻翻，拖动能挪位置',
      empty: '这里还什么都没有。',
      rootGroup: '规则与说明',
      openFolder: '打开文件夹',
      pick: '左边选一本翻开。',
      loading: '正在翻…',
      error: '出错了',
      reload: '重新读一遍',
      readFailed: '这本没能翻开',
      openFailed: '打不开文件夹',
      retry: '再试一次',
      root: '目录',
      created: '刚给这个目录铺了一份模板出来。',
      count: (n) => `共 ${n} 本`,
      emptyBook: '这本还是空白的。',
      size: (b) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`),
      when: (iso) => {
        if (!iso) return ''
        const d = new Date(iso)
        const p = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      },
    }

    const en = {
      title: 'Memory Books',
      hint: 'Memory Books · click to browse, drag to move',
      empty: 'Nothing here yet.',
      rootGroup: 'Rules & notes',
      openFolder: 'Open folder',
      pick: 'Pick a book on the left.',
      loading: 'Turning pages…',
      error: 'Something went wrong',
      reload: 'Read again',
      readFailed: "This book wouldn't open",
      openFailed: "Couldn't open the folder",
      retry: 'Try again',
      root: 'Folder',
      created: 'Just laid out a template in this folder.',
      count: (n) => `${n} book${n === 1 ? '' : 's'}`,
      emptyBook: 'This book is still blank.',
      size: (b) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`),
      when: (iso) => {
        if (!iso) return ''
        const d = new Date(iso)
        const p = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      },
    }

    // ── 极简 markdown 渲染 ────────────────────────────────
    // 不做完整 CommonMark，只覆盖记忆本子里真实会出现的语法。

    function renderInline(text, keyBase) {
      // 行内：`代码`、**粗体**、*斜体*
      // 星号必须带词边界（前后不能是空格），否则 2*3*4 和 /api/*/list 会被吞成斜体。
      const nodes = []
      let i = 0
      const re = /(`[^`]+`|\*\*(?=\S)[^*]+?(?<=\S)\*\*|(?<![*\w])\*(?=\S)[^*]+?(?<=\S)\*(?![*\w]))/g
      let m
      let last = 0
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) nodes.push(text.slice(last, m.index))
        const tok = m[0]
        if (tok.startsWith('`')) {
          nodes.push(jsx('code', { key: `${keyBase}-c${i++}`, className: 'bfm-code', children: tok.slice(1, -1) }))
        } else if (tok.startsWith('**')) {
          nodes.push(jsx('strong', { key: `${keyBase}-b${i++}`, children: tok.slice(2, -2) }))
        } else {
          nodes.push(jsx('em', { key: `${keyBase}-i${i++}`, children: tok.slice(1, -1) }))
        }
        last = m.index + tok.length
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function renderMarkdown(text) {
      const lines = text.split('\n')
      const out = []
      let i = 0
      let key = 0

      while (i < lines.length) {
        const line = lines[i]
        const t = line.trim()

        if (!t) { i++; continue }

        // 围栏代码块 ```lang ... ```
        if (/^```/.test(t)) {
          const lang = t.slice(3).trim()
          const buf = []
          i++
          while (i < lines.length && !/^```/.test(lines[i].trim())) {
            buf.push(lines[i])
            i++
          }
          if (i < lines.length) i++ // 吃掉收尾的 ```
          out.push(
            jsx('pre', {
              key: `pre${key++}`,
              className: 'bfm-pre',
              children: jsx('code', { className: 'bfm-precode', 'data-lang': lang, children: buf.join('\n') }),
            }),
          )
          continue
        }

        if (t === '---' || t === '***' || t === '___' || /^([-*_])\1{2,}$/.test(t)) {
          out.push(jsx('hr', { key: `hr${key++}`, className: 'bfm-hr' }))
          i++
          continue
        }

        const h = /^(#{1,6})\s+(.*)$/.exec(t)
        if (h) {
          const level = h[1].length
          const Tag = `h${level}`
          out.push(
            jsx(Tag, { key: `h${key++}`, className: `bfm-h${level}`, children: renderInline(h[2], `k${key}`) }),
          )
          i++
          continue
        }

        if (t.startsWith('>')) {
          const buf = []
          while (i < lines.length && lines[i].trim().startsWith('>')) {
            buf.push(lines[i].trim().replace(/^>\s?/, ''))
            i++
          }
          out.push(
            jsx('blockquote', { key: `q${key++}`, className: 'bfm-quote', children: renderInline(buf.join(' '), `qk${key}`) }),
          )
          continue
        }

        if (/^[-*+]\s+/.test(t)) {
          const items = []
          while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
            items.push(lines[i].trim().replace(/^[-*+]\s+/, ''))
            i++
          }
          out.push(
            jsx('ul', {
              key: `ul${key++}`,
              className: 'bfm-ul',
              children: items.map((it, n) =>
                jsx('li', { key: n, children: renderInline(it, `li${key}-${n}`) }),
              ),
            }),
          )
          continue
        }

        if (/^\d+[.)]\s+/.test(t)) {
          const items = []
          while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
            items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''))
            i++
          }
          out.push(
            jsx('ol', {
              key: `ol${key++}`,
              className: 'bfm-ol',
              children: items.map((it, n) =>
                jsx('li', { key: n, children: renderInline(it, `oli${key}-${n}`) }),
              ),
            }),
          )
          continue
        }

        // 普通段落：吞掉连续非空行
        // 注意：这里必须保证 i 一定推进，否则遇到「---abc」「----」这种
        // 既不是 hr、又不匹配其它分支的行会死循环。所以先无条件吃掉当前行。
        const para = []
        para.push(t)
        i++
        while (
          i < lines.length &&
          lines[i].trim() &&
          !/^(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|---|===)/.test(lines[i].trim())
        ) {
          para.push(lines[i].trim())
          i++
        }
        out.push(jsx('p', { key: `p${key++}`, className: 'bfm-p', children: renderInline(para.join(' '), `pk${key}`) }))
      }

      return out
    }

    // ── 样式 ─────────────────────────────────────────────
    const CSS = `
/* ── 浮动图标：可拖动，位置持久化；面板居中弹出 ── */
.bfm-launcher { position:fixed; z-index:250; }
.bfm-fab {
  width:32px; height:32px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2,#d9d9d9);
  background:var(--dsw-alias-bg-layer-2,#fff); color:var(--dsw-alias-label-secondary,#666);
  cursor:grab; display:flex; align-items:center; justify-content:center;
  box-shadow:0 1px 4px rgba(0,0,0,.1);
  transition:background-color .15s ease, color .15s ease, box-shadow .15s ease;
  user-select:none; -webkit-user-select:none; touch-action:none;
}
.bfm-fab:hover {
  background:var(--dsw-alias-interactive-bg-hover,#f0f0f0);
  color:var(--dsw-alias-label-primary,#1a1a1a);
  box-shadow:0 2px 8px rgba(0,0,0,.16);
}
.bfm-fab[data-dragging="1"] { cursor:grabbing; box-shadow:0 4px 14px rgba(0,0,0,.22); }
.bfm-fab[data-open="1"] {
  background:var(--dsw-alias-interactive-bg-active,#e6f0ff);
  color:var(--dsw-alias-brand-primary,#2b6cb0);
  border-color:var(--dsw-alias-brand-primary,#2b6cb0);
}
/* 拖动时给个轻提示，避免用户以为是点击 */
.bfm-tip {
  position:absolute; top:50%; transform:translateY(-50%);
  white-space:nowrap; font-size:11px; line-height:1.4;
  padding:2px 7px; border-radius:5px;
  background:var(--dsw-alias-bg-layer-1,#fff);
  border:1px solid var(--dsw-alias-border-l1,#e5e5e5);
  color:var(--dsw-alias-label-secondary,#666);
  box-shadow:0 1px 5px rgba(0,0,0,.12);
  pointer-events:none;
}
.bfm-modal {
  position:fixed; left:50%; top:50%; transform:translate(-50%,-50%);
  width:min(760px, calc(100vw - 48px));
  height:min(560px, calc(100vh - 120px));
  display:flex; flex-direction:column;
  background:var(--dsw-alias-bg-layer-1,#fff);
  border:1px solid var(--dsw-alias-border-l2,#dcdcdc);
  border-radius:12px; overflow:hidden;
  box-shadow:0 12px 40px rgba(0,0,0,.22);
}
.bfm-modalhead {
  display:flex; align-items:center; gap:8px; flex:none;
  padding:9px 12px; border-bottom:1px solid var(--dsw-alias-border-l1,#e8e8e8);
  background:var(--dsw-alias-bg-layer-2,#fafafa);
}
.bfm-modaltitle { font-size:13px; font-weight:600; }
.bfm-close {
  margin-left:auto; width:24px; height:24px; border:0; background:transparent;
  color:var(--dsw-alias-label-secondary,#666); cursor:pointer; border-radius:5px;
  font-size:18px; line-height:1; display:flex; align-items:center; justify-content:center;
}
.bfm-close:hover { background:var(--dsw-alias-interactive-bg-hover,#eee); color:var(--dsw-alias-label-primary,#1a1a1a); }
.bfm-modalbody { flex:1 1 auto; min-height:0; display:flex; }
.bfm-wrap { display:flex; flex:1 1 auto; min-height:0; width:100%; font-size:13px; color:var(--dsw-alias-text-1,#1a1a1a); }
.bfm-list {
  width:236px; flex:0 0 236px; border-right:1px solid var(--dsw-alias-border-1,#e5e5e5);
  overflow-y:auto; padding:8px 6px; box-sizing:border-box;
  background:var(--dsw-alias-bg-2,#fafafa);
}
.bfm-listhead {
  font-size:11px; letter-spacing:.04em; text-transform:uppercase;
  color:var(--dsw-alias-text-3,#8a8a8a); padding:4px 8px 8px;
  display:flex; justify-content:space-between; align-items:center; gap:6px;
}
.bfm-headbtns { display:flex; gap:2px; align-items:center; }
/* ── 分组 ── */
.bfm-group { margin-bottom:10px; }
.bfm-grouphead {
  display:flex; align-items:center; gap:4px;
  padding:4px 8px 3px; margin-top:2px;
}
.bfm-grouptitle {
  flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-size:11px; font-weight:700; letter-spacing:.02em;
  color:var(--dsw-alias-label-secondary,#666);
  border-bottom:1px solid var(--dsw-alias-border-l1,#ececec);
  padding-bottom:3px;
}
.bfm-groupexpand {
  flex:none; width:18px; height:18px; border:0; background:transparent; cursor:pointer;
  color:var(--dsw-alias-label-tertiary,#999); border-radius:4px;
  display:flex; align-items:center; justify-content:center; opacity:0;
  transition:opacity .12s ease, background-color .12s ease;
}
.bfm-group:hover .bfm-groupexpand { opacity:1; }
.bfm-groupexpand:hover {
  background:var(--dsw-alias-interactive-bg-hover,#eee);
  color:var(--dsw-alias-label-primary,#1a1a1a);
}
.bfm-reload {
  border:none; background:transparent; cursor:pointer; font-size:11px;
  color:var(--dsw-alias-text-2,#666); padding:2px 6px; border-radius:4px;
}
.bfm-reload:hover { background:var(--dsw-alias-bg-hover,#eee); }
.bfm-item {
  display:block; width:100%; text-align:left; border:none; cursor:pointer;
  background:transparent; padding:8px 10px; border-radius:6px; margin-bottom:2px;
  font:inherit; color:inherit; line-height:1.4;
}
.bfm-item:hover { background:var(--dsw-alias-bg-hover,#eee); }
.bfm-item[data-on="1"] { background:var(--dsw-alias-bg-selected,#e6f0ff); }
.bfm-item[data-on="1"] .bfm-name { font-weight:600; }
.bfm-name { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bfm-meta { display:block; font-size:11px; color:var(--dsw-alias-text-3,#8a8a8a); margin-top:2px; }
.bfm-excerpt {
  display:block; font-size:11.5px; color:var(--dsw-alias-text-2,#666);
  margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.bfm-body { flex:1 1 auto; min-width:0; overflow-y:auto; padding:20px 26px 40px; box-sizing:border-box; }
.bfm-bodyhead {
  display:flex; align-items:baseline; gap:10px; margin-bottom:4px;
  padding-bottom:10px; border-bottom:1px solid var(--dsw-alias-border-1,#e5e5e5);
}
.bfm-title { font-size:15px; font-weight:600; }
.bfm-sub { font-size:11.5px; color:var(--dsw-alias-text-3,#8a8a8a); }
.bfm-doc { max-width:70ch; line-height:1.75; }
.bfm-h1 { font-size:19px; font-weight:650; margin:18px 0 10px; }
.bfm-h2 { font-size:15.5px; font-weight:650; margin:22px 0 8px; }
.bfm-h3 { font-size:13.5px; font-weight:650; margin:16px 0 6px; color:var(--dsw-alias-text-2,#555); }
.bfm-h4,.bfm-h5,.bfm-h6 { font-size:13px; font-weight:600; margin:12px 0 4px; }
.bfm-p { margin:8px 0; }
.bfm-ul,.bfm-ol { margin:8px 0; padding-left:22px; }
.bfm-ul li,.bfm-ol li { margin:3px 0; }
.bfm-quote {
  margin:10px 0; padding:6px 12px; border-left:3px solid var(--dsw-alias-border-1,#dcdcdc);
  color:var(--dsw-alias-text-2,#555); background:var(--dsw-alias-bg-2,#fafafa);
  border-radius:0 4px 4px 0;
}
.bfm-hr { border:none; border-top:1px solid var(--dsw-alias-border-1,#e5e5e5); margin:18px 0; }
.bfm-code {
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px;
  background:var(--dsw-alias-bg-2,#f2f2f2); padding:1px 5px; border-radius:4px;
}
.bfm-pre {
  margin:10px 0; padding:10px 12px; overflow-x:auto; border-radius:6px;
  background:var(--dsw-alias-bg-2,#f5f5f5); border:1px solid var(--dsw-alias-border-1,#e5e5e5);
}
.bfm-precode {
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px;
  line-height:1.6; white-space:pre;
}
.bfm-hint {
  color:var(--dsw-alias-text-3,#8a8a8a); font-size:12.5px;
  display:flex; height:100%; align-items:center; justify-content:center; padding:40px;
}
.bfm-err { color:var(--dsw-alias-danger,#c33); font-size:12.5px; }
/* 左栏底部的临时提示（只在「打开文件夹」失败时出现） */
.bfm-note {
  margin:6px 8px 2px; padding:5px 8px; border-radius:5px;
  font-size:11.5px; line-height:1.5; word-break:break-all;
  color:var(--dsw-alias-danger,#c33);
  background:var(--dsw-alias-bg-layer-2,#fafafa);
  border:1px solid var(--dsw-alias-border-l1,#ececec);
}
`

    /**
     * 样式表必须在「模块激活时」就注入，不能等到面板渲染。
     *
     * 之前把注入写在 MemoryPanel 里 —— 面板没打开时组件不渲染，
     * `.bfm-launcher` / `.bfm-fab` 就没样式，按普通文档流排到容器左上角，
     * 表现为「按钮跑到最左上角且点不到」。
     */
    let cssInjected = false
    function ensureCSS() {
      if (cssInjected) return
      if (typeof document === 'undefined' || !document.head) return
      cssInjected = true
      try {
        if (document.querySelector('style[data-bfm]') !== null) return
        const el = document.createElement('style')
        el.dataset.bfm = '1'
        el.textContent = CSS
        document.head.appendChild(el)
      } catch (e) {
        console.error('[memory-viewer] style injection failed', e)
      }
    }

    // ── 主面板 ───────────────────────────────────────────
    function MemoryPanel(props) {
      const t = props.locale && props.locale.startsWith('en') ? en : zh
      const [books, setBooks] = useState(null)
      const [groups, setGroups] = useState([])
      const [root, setRoot] = useState('')
      const [created, setCreated] = useState(false)
      const [active, setActive] = useState(null)
      const [doc, setDoc] = useState(null)
      // 三种错误必须分开存，否则互相吞：
      //   err      —— 列表加载失败，整块换成错误页
      //   docErr   —— 某本翻开失败，只顶掉右栏正文
      //   note     —— 打开文件夹失败，只在左栏飘一行
      // 曾经三种共用一个 err，而渲染只看 doc / active，结果「读失败」时
      // 右栏永远停在「正在翻…」，用户以为卡死。
      const [err, setErr] = useState(null)
      const [docErr, setDocErr] = useState(null)
      const [note, setNote] = useState(null)
      // 点「再试一次」时 +1，用来重跑读取 effect
      const [readKey, setReadKey] = useState(0)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async (keepActive) => {
        setBusy(true)
        setErr(null)
        try {
          const r = await fetch(`${API}/list`, { cache: 'no-store' })
          const j = await r.json()
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
          const list = j.books || []
          setBooks(list)
          setGroups(Array.isArray(j.groups) ? j.groups : [{ key: '', books: list }])
          setRoot(j.root || '')
          setCreated(!!j.created)
          if (!keepActive) {
            setActive((cur) => cur ?? (list[0]?.rel ?? null))
          } else {
            setActive((cur) => {
              const still = list.some((b) => b.rel === cur)
              return still ? cur : (list[0]?.rel ?? null)
            })
          }
        } catch (e) {
          setErr(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }, [])

      /** 在系统文件管理器里打开某个子目录（'' 表示记忆根目录） */
      const reveal = useCallback(async (dir) => {
        setNote(null)
        try {
          const q = dir ? `?dir=${encodeURIComponent(dir)}` : ''
          const r = await fetch(`${API}/reveal${q}`, { cache: 'no-store' })
          const j = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
        } catch (e) {
          // 只影响「打开文件夹」这一个动作，不能把正文和列表也顶掉
          setNote(`${t.openFailed}：${String(e.message || e)}`)
        }
      }, [t])

      useEffect(() => { load(false) }, [load])

      useEffect(() => {
        // 换本时上一本的失败提示要清掉，否则新的一本一打开就顶着旧错误
        setDocErr(null)
        setNote(null)
        if (!active) { setDoc(null); return }
        let dead = false
        setDoc(null)
        fetch(`${API}/read?rel=${encodeURIComponent(active)}`, { cache: 'no-store' })
          .then(async (r) => {
            // 先按文本取，再自己 parse —— 后端 500 时回的是 JSON，
            // 但如果路由层抛了未捕获异常，body 可能是空的，直接 r.json() 会
            // 抛一个几乎不可读的 "Unexpected end of JSON input"。
            const raw = await r.text()
            let j = null
            try { j = raw ? JSON.parse(raw) : null } catch { j = null }
            if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
            if (!j) throw new Error(`HTTP ${r.status} 返回内容无法解析`)
            if (!dead) setDoc(j)
          })
          .catch((e) => { if (!dead) setDocErr(String(e.message || e)) })
        return () => { dead = true }
      }, [active, readKey])

      const rendered = useMemo(() => (doc ? renderMarkdown(doc.text) : null), [doc])

      if (err && !books) {
        return jsx('div', {
          className: 'bfm-hint',
          children: jsxs('div', {
            children: [
              jsx('div', { className: 'bfm-err', children: `${t.error}: ${err}` }),
              jsx('button', { className: 'bfm-reload', onClick: () => load(false), children: t.reload }),
            ],
          }),
        })
      }

      if (!books) {
        return jsx('div', { className: 'bfm-hint', children: t.loading })
      }

      const renderBook = (b) =>
        jsxs('button', {
          className: 'bfm-item',
          'data-on': active === b.rel ? '1' : '0',
          onClick: () => setActive(b.rel),
          title: b.rel,
          children: [
            jsx('span', { className: 'bfm-name', children: b.name }),
            jsx('span', { className: 'bfm-meta', children: `${t.size(b.size)} · ${t.when(b.mtime)}` }),
            b.excerpt ? jsx('span', { className: 'bfm-excerpt', children: b.excerpt }) : null,
          ],
        })

      // 右栏三态：正文 / 读失败 / 加载中（或还没选）
      // 读失败必须能显示出来，并且在浏览器里给一次重试的机会。
      const renderBody = () => {
        if (doc) {
          return jsxs('div', {
            className: 'bfm-doc',
            children: [
              jsxs('div', {
                className: 'bfm-bodyhead',
                children: [
                  jsx('span', { className: 'bfm-title', children: doc.name }),
                  jsx('span', { className: 'bfm-sub', children: `${t.size(doc.size)} · ${t.when(doc.mtime)}` }),
                ],
              }),
              ...(rendered || []),
            ],
          })
        }
        if (docErr) {
          return jsxs('div', {
            className: 'bfm-hint',
            children: jsxs('div', {
              children: [
                jsx('div', { className: 'bfm-err', children: `${t.readFailed}：${docErr}` }),
                jsx('div', { className: 'bfm-sub', style: { margin: '6px 0 10px' }, children: active || '' }),
                jsx('button', {
                  className: 'bfm-reload',
                  onClick: () => setReadKey((k) => k + 1),
                  children: t.retry,
                }),
              ],
            }),
          })
        }
        return jsx('div', { className: 'bfm-hint', children: active ? t.loading : t.pick })
      }

      // 按分区渲染：根目录散装文件一组，每个子文件夹一组。
      // 每组带标题和一个「在文件管理器里打开」的小按钮。
      const renderGroup = (g, gi) => {
        const list = g.books || []
        if (list.length === 0) return null
        const title = g.key || t.rootGroup
        return jsxs('div', {
          className: 'bfm-group',
          children: [
            jsxs('div', {
              className: 'bfm-grouphead',
              children: [
                jsx('span', { className: 'bfm-grouptitle', title, children: title }),
                jsx('button', {
                  className: 'bfm-groupexpand',
                  onClick: (e) => { e.stopPropagation(); reveal(g.key) },
                  title: t.openFolder,
                  'aria-label': t.openFolder,
                  children: jsx('svg', {
                    viewBox: '0 0 24 24', width: 12, height: 12, fill: 'none',
                    stroke: 'currentColor', strokeWidth: 2,
                    strokeLinecap: 'round', strokeLinejoin: 'round',
                    children: jsx('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }),
                  }),
                }),
              ],
            }),
            ...list.map(renderBook),
          ],
        })
      }

      return jsxs('div', {
        className: 'bfm-wrap',
        children: [
          jsxs('div', {
            className: 'bfm-list',
            children: [
              jsxs('div', {
                className: 'bfm-listhead',
                children: [
                  jsx('span', { children: t.count(books.length) }),
                  jsxs('span', {
                    className: 'bfm-headbtns',
                    children: [
                      jsx('button', {
                        className: 'bfm-reload',
                        onClick: () => reveal(''),
                        title: t.openFolder,
                        children: t.openFolder,
                      }),
                      jsx('button', {
                        className: 'bfm-reload',
                        onClick: () => load(true),
                        children: busy ? '…' : t.reload,
                      }),
                    ],
                  }),
                ],
              }),
              ...(books.length === 0
                ? [jsx('div', { className: 'bfm-hint', style: { padding: '20px 10px' }, children: t.empty })]
                : groups.map(renderGroup)),
              // 打开文件夹失败只在这里飘一行，不占正文
              note ? jsx('div', { className: 'bfm-note', children: note }) : null,
            ],
          }),
          jsx('div', { className: 'bfm-body', children: renderBody() }),
        ],
      })
    }

    /**
     * 启动器：右下角一个圆形按钮，点开弹出浮动面板，再点收起。
     *
     * 不注册 main / sidebar.panellist —— 那两个会把中央工作区整个替换掉
     * （main 是「Central panel selected by sidebar entry id」，占满整块中央区域，
     *  切过去对话就没了）。浮动层不参与主布局，开关自便。
     */
    // ── 浮动图标的位置：默认右下角，可拖动，位置记在 localStorage ──
    const POS_KEY = 'dsh-memory-viewer-pos'
    // 位置格式版本。升级后旧坐标一律作废（早期版本默认放在顶部，
    // 那些坐标落在窗口拖动区里，会让图标点不到）。
    const POS_VERSION = 2
    const FAB_SIZE = 32
    const EDGE = 12
    // 顶部安全区：DSH 标题栏是 Electron 的窗口拖动区（-webkit-app-region: drag），
    // 落在里面的按钮收不到 pointer 事件 —— 既拖不动也点不到。整条带子都避开。
    const TOP_SAFE = 56
    // 底部/右侧也留一条，避免贴着边缘被裁掉
    const BOTTOM_SAFE = 16

    function clamp(v, lo, hi) {
      return Math.min(Math.max(v, lo), Math.max(lo, hi))
    }

    function viewport() {
      return {
        w: typeof window !== 'undefined' ? window.innerWidth : 1280,
        h: typeof window !== 'undefined' ? window.innerHeight : 800,
      }
    }

    /** 可放置区间：避开顶部标题栏、四周留白 */
    function bounds() {
      const { w, h } = viewport()
      return {
        minX: EDGE,
        maxX: Math.max(EDGE, w - FAB_SIZE - EDGE),
        minY: TOP_SAFE,
        maxY: Math.max(TOP_SAFE, h - FAB_SIZE - BOTTOM_SAFE),
      }
    }

    function clampPos(p) {
      const b = bounds()
      return {
        x: clamp(p.x, b.minX, b.maxX),
        y: clamp(p.y, b.minY, b.maxY),
      }
    }

    /** 默认落点：右下角 */
    function defaultPos() {
      const b = bounds()
      return { x: b.maxX, y: b.maxY }
    }

    function loadPos() {
      const def = defaultPos()
      try {
        const raw = localStorage.getItem(POS_KEY)
        if (!raw) return def
        const p = JSON.parse(raw)
        // 旧版本存的位置直接丢弃
        if (p?.v !== POS_VERSION) return def
        if (typeof p.x !== 'number' || typeof p.y !== 'number') return def
        return clampPos(p)
      } catch {
        return def
      }
    }

    function savePos(p) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ x: p.x, y: p.y, v: POS_VERSION }))
      } catch { /* 隐私模式下写不进去，忽略 */ }
    }

    function MemoryLauncher() {
      const [open, setOpen] = React.useState(false)
      const [pos, setPos] = React.useState(loadPos)
      const [dragging, setDragging] = React.useState(false)
      const dragRef = React.useRef(null)
      const posRef = React.useRef(pos)
      const suppressClick = React.useRef(false)
      posRef.current = pos

      const t = isEnglish() ? en : zh

      // 拖动过程中跟手；松手时持久化
      React.useEffect(() => {
        const onMove = (e) => {
          const d = dragRef.current
          if (!d) return
          const dx = e.clientX - d.sx
          const dy = e.clientY - d.sy
          // 超过阈值才算拖动，否则保持「点击」
          if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
          d.moved = true
          suppressClick.current = true
          // clampPos 会挡在顶部安全区之外，拖进标题栏也停得住
          setPos(clampPos({ x: d.ox + dx, y: d.oy + dy }))
        }
        const onUp = () => {
          if (!dragRef.current) return
          dragRef.current = null
          setDragging(false)
          savePos(posRef.current)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
      }, [])

      // 窗口尺寸变了要把图标拉回合法区间（含顶部安全区）
      React.useEffect(() => {
        const onResize = () => {
          setPos((p) => clampPos(p))
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      const onPointerDown = (e) => {
        // 只响应左键 / 触摸
        if (e.button !== undefined && e.button !== 0) return
        dragRef.current = {
          sx: e.clientX, sy: e.clientY,
          ox: posRef.current.x, oy: posRef.current.y,
          moved: false,
        }
        setDragging(true)
      }

      const onClick = () => {
        // 拖动结束后的那一次 click 要吞掉，否则一拖就顺带开合面板
        if (suppressClick.current) {
          suppressClick.current = false
          return
        }
        setOpen((v) => !v)
      }

      return jsxs('div', {
        className: 'bfm-launcher',
        // 内联样式兜底：样式表万一没进来，也要钉在可视区内可点
        style: {
          position: 'fixed',
          left: pos.x + 'px',
          top: pos.y + 'px',
          right: 'auto',
          bottom: 'auto',
          zIndex: 250,
          display: 'block',
          pointerEvents: 'auto',
        },
        children: [
          open
            ? jsxs('div', {
                className: 'bfm-modal',
                children: [
                  jsxs('div', {
                    className: 'bfm-modalhead',
                    children: [
                      jsx('span', { className: 'bfm-modaltitle', children: t.title }),
                      jsx('button', {
                        className: 'bfm-close',
                        onClick: () => setOpen(false),
                        'aria-label': 'close',
                        children: '×',
                      }),
                    ],
                  }),
                  jsx('div', {
                    className: 'bfm-modalbody',
                    children: jsx(MemoryPanel, { locale: isEnglish() ? 'en' : 'zh' }),
                  }),
                ],
              })
            : null,
          jsx('button', {
            className: 'bfm-fab',
            'data-dragging': dragging ? '1' : '0',
            'data-open': open ? '1' : '0',
            onPointerDown,
            onClick,
            title: t.hint || t.title,
            'aria-label': t.title,
            children: jsx('svg', {
              viewBox: '0 0 24 24', width: 17, height: 17, fill: 'none',
              stroke: 'currentColor', strokeWidth: 2,
              strokeLinecap: 'round', strokeLinejoin: 'round',
              children: jsxs('g', {
                children: [
                  jsx('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z' }),
                  jsx('path', { d: 'M4 18.5A2.5 2.5 0 0 1 6.5 16H20' }),
                  jsx('path', { d: 'M9 7h7M9 11h7' }),
                ],
              }),
            }),
          }),
        ],
      })
    }

    function apply(ctx) {
      // 样式先注入：面板没打开时按钮也要有定位样式，
      // 否则它会按普通文档流排到 overlay 容器的左上角。
      ensureCSS()

      // 探测 locale 服务。用 ctx.get —— 缺服务时返回 undefined，不抛错。
      // 绝不写 ctx.locale：那是 Proxy 读取，未 inject 会直接 throw。
      try {
        localeService = (typeof ctx.get === 'function' ? ctx.get('locale') : null) ?? null
      } catch {
        localeService = null
      }

      // 只注册 shell.overlay：Frame-wide floating layer, above every column
      // and outside their scroll containers —— 不跟任何列抢位置。
      try {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'memory-viewer-fab', order: 70 },
            MemoryLauncher,
          ),
        )
      } catch (e) {
        console.error('[memory-viewer] shell.overlay registration failed', e)
      }
    }

    /**
     * 语言判断。
     *
     * 第一优先：apply 时用 `ctx.get('locale')` 拿到的 locale 服务。
     *   `ctx.get` 是 Cordis 提供的「不要求 inject 的读取」，服务没就绪时返回
     *   undefined 而**不抛错** —— 这一点和 `ctx.locale` 有本质区别：
     *   `ctx.locale` 走 Proxy 的 get trap，未 inject 会在属性读取处直接 throw，
     *   `?.` 只能拦「返回 undefined」，拦不住 throw。
     *
     * 第二优先：浏览器 navigator.language。
     * 这样即使 locale 服务缺失或还没起来，标题也不会错、更不会崩。
     *
     * 注意 LocaleSnapshot 的字段是 `active`（不是 id / current）。
     */
    let localeService = null

    function isEnglish() {
      try {
        const snap = localeService?.getLocale?.()
        const active = String(snap?.active ?? '')
        if (active) return active.toLowerCase().startsWith('en')
      } catch { /* 服务内部出错就往下走 */ }
      try {
        const l = typeof navigator !== 'undefined'
          ? (navigator.language || navigator.userLanguage || '')
          : ''
        return String(l).toLowerCase().startsWith('en')
      } catch {
        return false
      }
    }

    // Client 插件必须导出这三样才能被 loader 接住：
    //   name   —— 模块名
    //   inject —— 依赖的 client 服务；少了 'slots' 时 ctx.slots 是 undefined，
    //             apply 里的注册会静默失败（图标永远不出现）
    //   apply  —— 入口
    // 对照官方模板 templates/decoration/client.js 与 dsh-workbuddy-switcher-plus。
    const name = 'dsh-memory-viewer-client'
    const inject = ['slots']

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    exports.MemoryPanel = MemoryPanel
    return module.exports
  },
})
