/**
 * 邻座 · NextSeat — client half (DSH web panel).
 *
 * One panel: open a LAN room, show its code + URL + QR, watch who joined,
 * drop files / prompt cards into it, and pull the cards guests hand over
 * into the local prompt library.
 */
window.__ModuleLoader__.load({
  id: 'dsh-nearby',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const API = '/dsh-nearby/api'

    /* ---------------------------------------------------------------- */
    /* helpers                                                          */
    /* ---------------------------------------------------------------- */

    async function call(path, options) {
      const opts = options || {}
      const headers = Object.assign({ 'x-dsh-nearby': '1' }, opts.headers || {})
      if (opts.body && typeof opts.body === 'string' && !headers['content-type']) {
        headers['content-type'] = 'application/json'
      }
      let res
      try {
        res = await fetch(API + path, Object.assign({}, opts, { headers }))
      } catch {
        throw new Error('连不上宿主进程，插件可能还没加载')
      }
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        throw new Error(data.detail || data.error || 'HTTP ' + res.status)
      }
      return data
    }

    function fmtSize(n) {
      if (!n) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let v = n
      let i = 0
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i += 1
      }
      return (i === 0 ? v : v.toFixed(v >= 10 ? 0 : 1)) + ' ' + units[i]
    }

    function fmtLeft(ms) {
      if (!ms || ms <= 0) return '已到时间'
      const m = Math.floor(ms / 60000)
      const s = Math.floor((ms % 60000) / 1000)
      if (m >= 60) return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分'
      if (m > 0) return m + ' 分 ' + s + ' 秒'
      return s + ' 秒'
    }

    function fmtTime(ms) {
      const d = new Date(ms)
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text)
      }
      return Promise.reject(new Error('no-clipboard'))
    }

    const CSS = `
      .dn-root {
        height: 100%; overflow: auto; color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-base);
        font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .dn-page { max-width: 780px; margin: 0 auto; padding: 30px 26px 64px; }
      .dn-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .dn-title { font-size: 21px; font-weight: 650; letter-spacing: .01em; margin: 0; }
      .dn-sub { color: var(--dsw-alias-label-secondary); font-size: 13px; margin: 5px 0 0; }
      .dn-badge {
        flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
        color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 99px; padding: 3px 10px; white-space: nowrap;
      }
      .dn-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }
      .dn-dot.off { background: var(--dsw-alias-state-idle-primary); }

      .dn-card {
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 14px; padding: 20px; margin-top: 16px;
      }
      .dn-card.flat { background: transparent; border-style: dashed; }
      .dn-h2 { font-size: 13px; font-weight: 600; margin: 0 0 4px; letter-spacing: .02em; }
      .dn-hint { color: var(--dsw-alias-label-secondary); font-size: 12.5px; margin: 0 0 14px; }
      .dn-peers { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
      .dn-peer { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; }
      .dn-skills { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow: auto; }
      .dn-skill { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; }
      .dn-skill-main { min-width: 0; flex: 1; }
      .dn-plug { display: flex; gap: 10px; align-items: flex-start; padding: 9px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; }
      .dn-plug.pick { border-color: var(--dsw-alias-brand-primary); }
      .dn-plug input { margin-top: 3px; accent-color: var(--dsw-alias-brand-primary); }
      .dn-plug-main { min-width: 0; flex: 1; }
      .dn-code {
        font-family: var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 8px; padding: 8px 10px; margin-top: 10px;
        max-height: 110px; overflow: auto; word-break: break-all; white-space: pre-wrap;
      }
      .dn-pack-rows { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow: auto; }
      .dn-pack-row { display: flex; gap: 8px; justify-content: space-between; font-size: 12.5px; }

      .dn-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
      .dn-check {
        display: flex; align-items: center; gap: 8px; margin-top: 12px;
        font-size: 13px; color: var(--dsw-alias-label-secondary); cursor: pointer;
      }
      .dn-check input { accent-color: var(--dsw-alias-brand-primary); }

      .dn-field { flex: 1; min-width: 150px; }
      .dn-label { display: block; font-size: 12px; color: var(--dsw-alias-label-secondary); margin-bottom: 5px; }
      .dn-input, .dn-select, .dn-textarea {
        width: 100%; box-sizing: border-box; font: inherit; font-size: 13.5px; color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 9px; padding: 9px 11px; outline: none;
      }
      .dn-input:focus, .dn-select:focus, .dn-textarea:focus { border-color: var(--dsw-alias-brand-primary); }
      .dn-textarea { min-height: 92px; resize: vertical; line-height: 1.55; }

      .dn-btn {
        font: inherit; font-size: 13.5px; font-weight: 600; border-radius: 9px; padding: 9px 16px;
        cursor: pointer; border: 1px solid transparent; white-space: nowrap;
      }
      .dn-btn.primary { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
      .dn-btn.ghost { background: transparent; color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
      .dn-btn.small { font-size: 12.5px; padding: 5px 10px; }
      .dn-btn:disabled { opacity: .45; cursor: default; }
      .dn-btn.primary:hover:not(:disabled) { filter: brightness(1.06); }
      .dn-btn.ghost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }

      .dn-code {
        font: 700 46px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: .08em;
        margin: 2px 0 4px;
      }
      .dn-codewrap { display: flex; gap: 26px; align-items: flex-start; flex-wrap: wrap; }
      .dn-codewrap .dn-left { flex: 1; min-width: 210px; }
      .dn-codewrap .dn-right { flex: none; }

      .dn-qr {
        width: 168px; height: 168px; padding: 8px; background: #fff; border-radius: 12px;
        border: 1px solid var(--dsw-alias-border-l1); cursor: zoom-in; display: block;
      }
      .dn-qr.big { width: 300px; height: 300px; cursor: zoom-out; }
      .dn-qrtip { font-size: 11.5px; color: var(--dsw-alias-label-secondary); text-align: center; margin-top: 7px; }

      .dn-urls { display: grid; gap: 7px; margin-top: 12px; }
      .dn-url {
        display: flex; align-items: center; gap: 10px; border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 9px; padding: 8px 10px; background: var(--dsw-alias-bg-base);
      }
      .dn-url code {
        flex: 1; min-width: 0; font-size: 12px; font-family: ui-monospace, Menlo, monospace;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .dn-iface { font-size: 11px; color: var(--dsw-alias-label-secondary); flex: none; }

      .dn-warn {
        margin-top: 10px; font-size: 12.5px; color: var(--dsw-alias-state-warn-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
        border-radius: 9px; padding: 9px 11px;
      }

      .dn-chips { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 4px; }
      .dn-chip {
        display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px;
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 99px; padding: 3px 10px;
      }
      .dn-chip .dn-dot { width: 5px; height: 5px; }

      .dn-feed { display: grid; gap: 0; margin-top: 6px; }
      .dn-item { display: flex; gap: 12px; padding: 13px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
      .dn-item:first-child { border-top: 0; }
      .dn-ico {
        flex: none; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center;
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 11%, transparent);
        color: var(--dsw-alias-brand-primary); font-size: 15px;
      }
      .dn-item.host .dn-ico {
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 13%, transparent);
        color: var(--dsw-alias-state-warn-primary);
      }
      .dn-bd { flex: 1; min-width: 0; }
      .dn-t1 { font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }
      .dn-item.note .dn-t1 { font-weight: 500; white-space: pre-wrap; }
      .dn-item.note .dn-ico {
        background: color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent);
        color: var(--dsw-alias-label-secondary);
      }
      .dn-noteform { display: flex; gap: 8px; margin: 12px 0 2px; }
      .dn-noteform .dn-input { flex: 1; min-width: 0; }
      .dn-meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
      .dn-meta b { font-weight: 600; color: var(--dsw-alias-label-primary); }
      .dn-prev {
        font-size: 12.5px; color: var(--dsw-alias-label-secondary); margin-top: 6px;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      }
      .dn-tags { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 6px; }
      .dn-tag {
        font-size: 11px; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 99px; padding: 0 7px;
      }
      .dn-acts { display: flex; gap: 7px; margin-top: 9px; flex-wrap: wrap; }
      .dn-empty { color: var(--dsw-alias-label-secondary); font-size: 13px; text-align: center; padding: 22px 0 8px; }

      .dn-principles { display: grid; gap: 10px; margin-top: 14px; }
      .dn-principle { display: flex; gap: 10px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
      .dn-principle b { color: var(--dsw-alias-label-primary); font-weight: 600; }
      .dn-num {
        flex: none; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
        font-size: 11px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary);
      }

      .dn-path {
        font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: var(--dsw-alias-label-secondary);
        overflow-wrap: anywhere; margin-top: 12px;
      }
      .dn-toast {
        position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
        background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 99px; padding: 8px 16px;
        font-size: 13px; z-index: 40; box-shadow: 0 8px 30px rgba(0,0,0,.18); max-width: 80vw;
      }
      .dn-toast.err { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .dn-spin { font-size: 13px; color: var(--dsw-alias-label-secondary); }
      .dn-error { color: var(--dsw-alias-state-error-primary); font-size: 13px; }
      .dn-upload { margin-top: 10px; display: grid; gap: 8px; }
      .dn-upload .dn-line { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dn-bar { height: 4px; border-radius: 3px; background: var(--dsw-alias-border-l1); overflow: hidden; margin-top: 4px; }
      .dn-bar > i { display: block; height: 100%; background: var(--dsw-alias-brand-primary); transition: width .15s; }
    `

    /* ---------------------------------------------------------------- */
    /* panel                                                            */
    /* ---------------------------------------------------------------- */

    function isRemoteClient() {
      try {
        const h = (window.location && window.location.hostname) || ''
        if (!h || h === 'localhost' || h === '127.0.0.1' || h === '::1' || /\.local$/i.test(h)) return false
        if (/^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false
        if (/^(fe80|fc|fd)/i.test(h)) return false
        return true
      } catch {
        return false
      }
    }

    function NearbyPanel() {
      const [data, setData] = useState(null)
      const [qr, setQr] = useState('')
      const [bigQr, setBigQr] = useState(false)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [toast, setToast] = useState(null)
      const [name, setName] = useState('')
      const [minutes, setMinutes] = useState(120)
      const [card, setCard] = useState({ title: '', tags: '', body: '' })
      const [showCard, setShowCard] = useState(false)
      const [uploads, setUploads] = useState([])
      const [note, setNote] = useState('')
      const [nearby, setNearby] = useState(null)
      const [skills, setSkills] = useState(null)
      const [showSkills, setShowSkills] = useState(false)
      const [skillQuery, setSkillQuery] = useState('')
      const [showPacks, setShowPacks] = useState(false)
      const [packs, setPacks] = useState(null)
      const [packPick, setPackPick] = useState({})
      const [packCode, setPackCode] = useState('')
      const [showRecv, setShowRecv] = useState(false)
      const [recvCode, setRecvCode] = useState('')
      const [joinCode, setJoinCode] = useState('')
      const [recvPreview, setRecvPreview] = useState(null)
      const [remotely] = useState(isRemoteClient)
      const [remote, setRemote] = useState(remotely)
      const fileRef = useRef(null)
      const toastTimer = useRef(null)
      const qrCode = useRef('')
      const lastCount = useRef(0)
      const skillView = (skills || []).filter((sk) => {
        const t = skillQuery.trim().toLowerCase()
        return !t || (sk.name + ' ' + sk.id + ' ' + (sk.description || '')).toLowerCase().includes(t)
      })

      const say = useCallback((msg, isErr) => {
        setToast({ msg, isErr: !!isErr })
        clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 2400)
      }, [])

      const refresh = useCallback(async () => {
        try {
          const d = await call('/state', { method: 'GET' })
          setData(d)
          setErr('')
          if (!name && d.defaultHostName) setName(d.defaultHostName)
          const room = d.room
          const qrKey = room ? room.code + '|' + (room.joinUrl || '') : ''
          if (room && qrKey !== qrCode.current) {
            qrCode.current = qrKey
            try {
              const q = await call('/qr', { method: 'GET' })
              setQr(q.dataUrl || '')
            } catch {
              setQr('')
            }
          }
          if (!room) {
            qrCode.current = ''
            setQr('')
          }
          try {
            const n = await call('/nearby', { method: 'GET' })
            setNearby(n)
          } catch {
            /* discovery is optional */
          }
        } catch (e) {
          setErr(e.message || '读取失败')
        }
      }, [name])

      useEffect(() => {
        refresh()
        const t = setInterval(refresh, 2000)
        return () => {
          clearInterval(t)
          clearTimeout(toastTimer.current)
        }
      }, [refresh])

      const room = data && data.room ? data.room : null
      const left = room ? room.expiresAt - Date.now() : 0
      const itemCount = room ? room.itemCount : 0

      useEffect(() => {
        if (lastCount.current && itemCount > lastCount.current) say('房间里来了新东西')
        lastCount.current = itemCount
      }, [itemCount, say])

      async function openRoom() {
        setBusy(true)
        try {
          await call('/open', {
            method: 'POST',
            body: JSON.stringify({ hostName: name.trim(), minutes, relay: remote }),
          })
          await refresh()
          say('房间开好了')
        } catch (e) {
          say(e.message || '开房失败', true)
        } finally {
          setBusy(false)
        }
      }

      async function closeRoom() {
        setBusy(true)
        try {
          await call('/close', { method: 'POST', body: '{}' })
          await refresh()
          say('房间已关闭')
        } catch (e) {
          say(e.message || '关闭失败', true)
        } finally {
          setBusy(false)
        }
      }

      function uploadHostFiles(files) {
        if (!files || !files.length) return
        const list = Array.prototype.slice.call(files)
        list.forEach(async (file) => {
          const id = Math.random().toString(36).slice(2)
          setUploads((u) => u.concat([{ id, name: file.name, pct: 0 }]))
          try {
            await new Promise((resolve, reject) => {
              const xhr = new XMLHttpRequest()
              xhr.open('POST', API + '/share?name=' + encodeURIComponent(file.name))
              xhr.setRequestHeader('x-dsh-nearby', '1')
              xhr.upload.onprogress = (e) => {
                if (!e.lengthComputable) return
                const pct = Math.round((e.loaded / e.total) * 100)
                setUploads((u) => u.map((x) => (x.id === id ? Object.assign({}, x, { pct }) : x)))
              }
              xhr.onload = () => {
                let ok = false
                let msg = ''
                try {
                  const d = JSON.parse(xhr.responseText)
                  ok = !!(d && d.ok)
                  msg = (d && (d.detail || d.error)) || ''
                } catch {
                  /* ignore */
                }
                if (ok) resolve()
                else reject(new Error(msg || '上传失败'))
              }
              xhr.onerror = () => reject(new Error('上传中断'))
              xhr.send(file)
            })
            say('已放进房间：' + file.name)
            setUploads((u) => u.filter((x) => x.id !== id))
            refresh()
          } catch (e) {
            say(e.message || '上传失败', true)
            setUploads((u) => u.map((x) => (x.id === id ? Object.assign({}, x, { failed: true }) : x)))
          }
        })
      }

      async function shareCard() {
        if (!card.body.trim()) {
          say('卡片正文是空的', true)
          return
        }
        setBusy(true)
        try {
          await call('/share-card', {
            method: 'POST',
            body: JSON.stringify({ title: card.title, tags: card.tags, body: card.body }),
          })
          setCard({ title: '', tags: '', body: '' })
          say('卡片已投放')
          await refresh()
        } catch (e) {
          say(e.message || '投放失败', true)
        } finally {
          setBusy(false)
        }
      }

      async function sendNote() {
        const text = note.trim()
        if (!text) {
          say('说点什么吧', true)
          return
        }
        setBusy(true)
        try {
          await call('/note', { method: 'POST', body: JSON.stringify({ text }) })
          setNote('')
          await refresh()
        } catch (e) {
          say(e.message || '没发出去', true)
        } finally {
          setBusy(false)
        }
      }

      async function loadSkills() {
        if (skills) return
        try {
          const d = await call('/skills')
          setSkills(d.skills || [])
        } catch (e) {
          say(e.message || '读不到技能库', true)
          setSkills([])
        }
      }

      async function shareSkill(sk) {
        setBusy(true)
        try {
          await call('/share-skill', { method: 'POST', body: JSON.stringify({ name: sk.id }) })
          say('技能包已放进房间：' + sk.name)
          setShowSkills(false)
          await refresh()
        } catch (e) {
          say(e.message || '分享失败', true)
        } finally {
          setBusy(false)
        }
      }

      async function installSkill(item) {
        setBusy(true)
        try {
          const d = await call('/install-skill', { method: 'POST', body: JSON.stringify({ id: item.id }) })
          say('已装进技能库：' + (d.title || d.id))
        } catch (e) {
          say(e.message || '安装失败', true)
        } finally {
          setBusy(false)
        }
      }

      /* 插件包：把本机已装的插件导出成一串码，别人粘进自己的 DSH 就能装回。 */

      async function loadPacks() {
        try {
          const [d, lp] = await Promise.all([call('/plugins'), call('/local-plugins')])
          setPacks(
            Object.assign({}, d, {
              local: lp && lp.available ? lp.entries || [] : [],
            }),
          )
        } catch (e) {
          say(e.message || '读不到插件列表', true)
          setPacks({ available: false, entries: [], skipped: [], local: [] })
        }
      }

      function togglePack(name) {
        setPackPick((prev) => {
          const next = Object.assign({}, prev)
          if (next[name]) delete next[name]
          else next[name] = true
          return next
        })
      }

      async function exportPacks() {
        const names = Object.keys(packPick)
        if (!names.length) {
          say('先勾几个插件', true)
          return
        }
        setBusy(true)
        try {
          const d = await call('/export-plugins', {
            method: 'POST',
            body: JSON.stringify({ names }),
          })
          setPackCode(d.code || '')
          say('插件码好了：' + d.count + ' 个插件，' + d.chars + ' 个字符')
        } catch (e) {
          say(e.message || '生成插件码失败', true)
        } finally {
          setBusy(false)
        }
      }

      async function putPackInRoom() {
        if (!packCode) return
        setBusy(true)
        try {
          await call('/share-pack', { method: 'POST', body: JSON.stringify({ code: packCode }) })
          say('插件包已经放进房间了')
          await refresh()
        } catch (e) {
          say(e.message || '放不进房间', true)
        } finally {
          setBusy(false)
        }
      }

      async function shareLocalPluginInRoom(plugin) {
        setBusy(true)
        try {
          const d = await call('/share-local-plugin', {
            method: 'POST',
            body: JSON.stringify({ name: plugin.name }),
          })
          say('已把「' + (plugin.title || plugin.name) + '」放进房间')
          if (d && d.item) refresh()
        } catch (e) {
          say(e.message || '放进房间失败', true)
        } finally {
          setBusy(false)
        }
      }

      async function installLocalPluginItem(item) {
        setBusy(true)
        try {
          const d = await call('/install-local-plugin', {
            method: 'POST',
            body: JSON.stringify({ id: item.id }),
          })
          say(
            d.application === 'restart-required'
              ? '装好了，重启 DSH 后生效'
              : '已装成本地插件：' + (d.name || item.title || ''),
          )
          refresh()
        } catch (e) {
          say(e.message || '装失败', true)
        } finally {
          setBusy(false)
        }
      }

      async function joinByCode() {
        const code = joinCode.trim()
        if (!code) {
          say('先填分享码', true)
          return
        }
        if (/^https?:\/\//i.test(code)) {
          window.open(code, '_blank', 'noopener')
          return
        }
        setBusy(true)
        try {
          const d = await call('/match-room?code=' + encodeURIComponent(code))
          if (d && d.found && d.joinUrl) {
            say(d.self ? '这是你自己开的房间，已打开链接' : '找到了：' + (d.hostName || '邻居') + ' 的房间')
            window.open(d.joinUrl, '_blank', 'noopener')
          } else {
            say('附近没找到这个房间。让对方确认开着房、你们在同一个 Wi-Fi。', true)
          }
        } catch (e) {
          say(e.message || '找不到这个房间', true)
        } finally {
          setBusy(false)
        }
      }

      async function previewPack(code) {
        setBusy(true)
        try {
          const d = await call('/preview-plugins', {
            method: 'POST',
            body: JSON.stringify({ code }),
          })
          setRecvPreview(d)
          if (!d.rows || !d.rows.length) say('没有可装的插件')
        } catch (e) {
          setRecvPreview(null)
          say(e.message || '这串码读不出来', true)
        } finally {
          setBusy(false)
        }
      }

      async function applyPack() {
        if (!recvCode.trim()) return
        setBusy(true)
        try {
          const d = await call('/apply-plugins', {
            method: 'POST',
            body: JSON.stringify({ code: recvCode.trim() }),
          })
          const rows = d.done || []
          const failed = rows.filter((r) => !r.ok)
          if (failed.length) {
            const f = failed[0]
            say(f.name + ' 没装上：' + (f.error || '原因不明'), true)
            if (failed.length < rows.length) refresh()
            return
          }
          const okCount = rows.length
          say(
            okCount
              ? '装好了 ' + okCount + ' 个插件' + (d.restart ? '，重启 DSH 后生效' : '')
              : '这些插件本机都有，不用装',
          )
          setRecvPreview(null)
          setRecvCode('')
          refresh()
        } catch (e) {
          say(e.message || '装失败了', true)
        } finally {
          setBusy(false)
        }
      }

      async function importCard(item) {
        setBusy(true)
        try {
          const d = await call('/import', { method: 'POST', body: JSON.stringify({ id: item.id }) })
          say(d.duplicate ? '这张已经导入过了' : '已导入提示词库（共 ' + d.count + ' 张）')
          setData((prev) => (prev ? Object.assign({}, prev, { lastImport: d.path }) : prev))
        } catch (e) {
          say(e.message || '导入失败', true)
        } finally {
          setBusy(false)
        }
      }

      async function copy(text, label) {
        try {
          await copyText(text)
          say((label || '链接') + '已复制')
        } catch {
          say('复制失败，手动选中吧', true)
        }
      }

      const headerStatus = room
        ? { on: true, text: room.onlineCount + ' 人在线 · 还剩 ' + fmtLeft(left) }
        : { on: false, text: '未开房' }

      return h(
        'div',
        { className: 'dn-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dn-page' },
          h(
            'div',
            { className: 'dn-head' },
            h(
              'div',
              null,
              h('h1', { className: 'dn-title' }, '邻座'),
              h('p', { className: 'dn-sub' }, '同一个 Wi-Fi 下的临时房间。见面即连，关房即散，不建关系、不留账号。'),
            ),
            h(
              'span',
              { className: 'dn-badge' },
              h('span', { className: 'dn-dot' + (headerStatus.on ? '' : ' off') }),
              headerStatus.text,
            ),
          ),

          err ? h('div', { className: 'dn-warn' }, err) : null,
          !data && !err ? h('div', { className: 'dn-spin', style: { marginTop: 20 } }, '读取中…') : null,

          data && !room ? idleView() : null,
          data && room ? roomView() : null,
        ),
        toast
          ? h(
              'div',
              { className: 'dn-toast' + (toast.isErr ? ' err' : '') },
              h('span', null, toast.msg),
            )
          : null,
      )

      function nearbyCard() {
        if (!nearby || !nearby.enabled) return null
        const list = nearby.peers || []
        return h(
          'div',
          { className: 'dn-card' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 } },
            h('div', { className: 'dn-h2', style: { marginBottom: 0 } }, '附近的人'),
            h('span', { className: 'dn-hint', style: { margin: 0 } }, list.length ? list.length + ' 个邻居' : '暂无'),
          ),
          h(
            'p',
            { className: 'dn-hint', style: { marginTop: 4 } },
            '同一 Wi-Fi 下开着邻座的人会自动出现；对方开着房的话，点一下就进。',
          ),
          list.length
            ? h(
                'div',
                { className: 'dn-peers' },
                list.map((p) =>
                  h(
                    'div',
                    { className: 'dn-peer', key: p.id },
                    h(
                      'div',
                      { className: 'dn-skill-main' },
                      h('div', { className: 'dn-t1' }, p.name || p.host || '邻居'),
                      h(
                        'div',
                        { className: 'dn-meta' },
                        (p.host && p.host !== p.name ? p.host + ' · ' : '') +
                          (p.room
                            ? '房间 ' + p.room.code + (p.room.name ? ' · ' + p.room.name : '')
                            : '还没开房'),
                      ),
                    ),
                    p.room && p.room.joinUrl
                      ? h(
                          'button',
                          {
                            className: 'dn-btn primary small',
                            onClick: () => window.open(p.room.joinUrl, '_blank', 'noopener'),
                          },
                          '进房间',
                        )
                      : null,
                  ),
                ),
              )
            : h(
                'div',
                { className: 'dn-empty' },
                '还没有发现邻居。让对方也打开邻座面板，几秒后就会出现在这里。',
              ),
        )
      }

      function idleView() {
        return h(
          'div',
          null,
          nearbyCard(),
          h(
            'div',
            { className: 'dn-card' },
            h('div', { className: 'dn-h2' }, '有分享码？'),
            h(
              'p',
              { className: 'dn-hint' },
              '对方把房间码告诉你，填进来就能直接进他的房间；也可以直接粘完整的房间链接。',
            ),
            h(
              'div',
              { className: 'dn-row', style: { alignItems: 'flex-end' } },
              h(
                'div',
                { className: 'dn-field', style: { flex: 1 } },
                h('label', { className: 'dn-label' }, '房间码'),
                h('input', {
                  className: 'dn-input',
                  value: joinCode,
                  maxLength: 300,
                  placeholder: '4 位房间码，或粘完整链接',
                  onChange: (e) => setJoinCode(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' && !e.isComposing) {
                      e.preventDefault()
                      joinByCode()
                    }
                  },
                }),
              ),
              h('button', { className: 'dn-btn primary', disabled: busy, onClick: joinByCode }, '进房间'),
            ),
          ),
          h(
            'div',
            { className: 'dn-card' },
            h('div', { className: 'dn-h2' }, '开一间房'),
            h('p', { className: 'dn-hint' }, '开好后把二维码给对方扫，或者把链接发到群里。对方的手机浏览器直接打开，不用装任何东西。'),
            h(
              'div',
              { className: 'dn-row' },
              h(
                'div',
                { className: 'dn-field' },
                h('label', { className: 'dn-label' }, '我的称呼'),
                h('input', {
                  className: 'dn-input',
                  value: name,
                  maxLength: 40,
                  placeholder: '你的名字',
                  onChange: (e) => setName(e.target.value),
                }),
              ),
              h(
                'div',
                { className: 'dn-field', style: { maxWidth: 150 } },
                h('label', { className: 'dn-label' }, '房间存活'),
                h(
                  'select',
                  {
                    className: 'dn-select',
                    value: String(minutes),
                    onChange: (e) => setMinutes(Number(e.target.value)),
                  },
                  h('option', { value: '30' }, '30 分钟'),
                  h('option', { value: '60' }, '1 小时'),
                  h('option', { value: '120' }, '2 小时'),
                  h('option', { value: '240' }, '4 小时'),
                  h('option', { value: '480' }, '8 小时'),
                ),
              ),
              h(
                'label',
                { className: 'dn-check' },
                h('input', {
                  type: 'checkbox',
                  checked: remote,
                  onChange: (e) => setRemote(e.target.checked),
                }),
                h('span', null, '让外网的人也能进（走 Cloudflare 隧道，单文件上限 95MB）'),
              ),
              remotely
                ? h(
                    'div',
                    { className: 'dn-hint', style: { marginTop: 6 } },
                    '你正从外网打开面板（人在异地/手机流量）：这个开关已经默认打开，现场的人用链接或二维码就能进来。',
                  )
                : null,
              h(
                'button',
                { className: 'dn-btn primary', disabled: busy, onClick: openRoom },
                busy ? '开房中…' : '开一间',
              ),
            ),
            h(
              'div',
              { className: 'dn-principles' },
              principle('1', '不经过服务器', '文件在两台设备之间直传，只在当前 Wi-Fi 内。'),
              principle('2', '对方零安装', '插件顺带起一个局域网网页，扫码就能用。'),
              principle('3', '关了就散了', '到时间自动关闭，链接立刻失效，没有好友列表。'),
            ),
          ),
          h(
            'div',
            { className: 'dn-card flat' },
            h('div', { className: 'dn-h2' }, '适合什么时候用'),
            h(
              'p',
              { className: 'dn-hint', style: { marginBottom: 0 } },
              '沙龙、课堂、会议、朋友聚会——需要把一份资料同时给到在场所有人，或者收一圈作业和反馈，又不想拉群、加好友、传网盘。',
            ),
          ),
        )
      }

      function principle(num, title, text) {
        return h(
          'div',
          { className: 'dn-principle' },
          h('span', { className: 'dn-num' }, num),
          h('span', null, h('b', null, title + '：'), text),
        )
      }

      function roomView() {
        const localOnly = room.urls.length === 1 && room.urls[0].local
        return h(
          'div',
          null,
          nearbyCard(),
          h(
            'div',
            { className: 'dn-card' },
            h(
              'div',
              { className: 'dn-codewrap' },
              h(
                'div',
                { className: 'dn-left' },
                h('div', { className: 'dn-h2' }, '房间码'),
                h('div', { className: 'dn-code' }, room.code),
                h(
                  'p',
                  { className: 'dn-hint', style: { margin: '0 0 2px' } },
                  '主持人 ' + room.hostName + ' · ' + (room.name || '') + ' · 还剩 ' + fmtLeft(left),
                ),
                h(
                  'div',
                  { className: 'dn-urls' },
                  room.urls.map((u) =>
                    h(
                      'div',
                      { className: 'dn-url', key: u.url },
                      h('span', { className: 'dn-iface' }, u.local ? '本机' : u.iface),
                      h('code', null, u.url),
                      h(
                        'button',
                        { className: 'dn-btn ghost small', onClick: () => copy(u.url, '链接') },
                        '复制',
                      ),
                      h(
                        'a',
                        {
                          className: 'dn-btn ghost small',
                          href: u.url,
                          target: '_blank',
                          rel: 'noreferrer',
                          style: { textDecoration: 'none' },
                        },
                        '预览',
                      ),
                    ),
                  ),
                ),
                localOnly
                  ? h(
                      'div',
                      { className: 'dn-warn' },
                      '这台机器现在没有局域网地址（没连 Wi-Fi，或者只有回环）。对方连不进来，先连上同一个 Wi-Fi 再开一次。',
                    )
                  : null,
                room.relay
                  ? h(
                      'div',
                      { className: room.relay.state === 'failed' ? 'dn-warn' : 'dn-hint', style: { marginTop: 8 } },
                      room.relay.state === 'up'
                        ? '外网可达：' + room.relay.url + '（拿到链接的人都能进，用完记得关房）'
                        : room.relay.state === 'starting'
                          ? '正在开外网隧道…'
                          : room.relay.state === 'failed'
                            ? '外网隧道没起来：' + (room.relay.error || '未知错误')
                            : '外网隧道已断开',
                    )
                  : null,
              ),
              h(
                'div',
                { className: 'dn-right' },
                qr
                  ? h('img', {
                      className: 'dn-qr' + (bigQr ? ' big' : ''),
                      src: qr,
                      alt: '房间二维码',
                      onClick: () => setBigQr(!bigQr),
                    })
                  : h('div', { className: 'dn-qr', style: { display: 'grid', placeItems: 'center', color: '#999' } }, '二维码…'),
                h('div', { className: 'dn-qrtip' }, bigQr ? '点一下收回' : '对方扫码加入'),
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' } },
              h('button', { className: 'dn-btn ghost', disabled: busy, onClick: closeRoom }, '关闭房间'),
              h(
                'button',
                {
                  className: 'dn-btn ghost',
                  onClick: () =>
                    copy(
                      '来邻座房间 ' + room.code + '：' + room.joinUrl,
                      '邀请文案',
                    ),
                },
                '复制邀请文案',
              ),
            ),
          ),

          h(
            'div',
            { className: 'dn-card' },
            h('div', { className: 'dn-h2' }, '房间里的人'),
            h(
              'p',
              { className: 'dn-hint' },
              room.participants.length
                ? room.onlineCount + ' 人在线 · 共 ' + room.participants.length + ' 人进来过'
                : '还没有人进来。把二维码递过去，或者把链接发出去。',
            ),
            h(
              'div',
              { className: 'dn-chips' },
              room.participants.map((p) =>
                h(
                  'span',
                  { className: 'dn-chip', key: p.id },
                  h('span', { className: 'dn-dot' + (p.online ? '' : ' off') }),
                  p.name,
                ),
              ),
            ),
          ),

          h(
            'div',
            { className: 'dn-card' },
            h('div', { className: 'dn-h2' }, '放到房间里'),
            h('p', { className: 'dn-hint' }, '你放进去的东西，房间里所有人都能看到、能保存。'),
            h(
              'div',
              { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
              h(
                'button',
                { className: 'dn-btn primary', onClick: () => fileRef.current && fileRef.current.click() },
                '选文件放进去',
              ),
              h(
                'button',
                { className: 'dn-btn ghost', onClick: () => setShowCard(!showCard) },
                showCard ? '收起卡片' : '放一张提示词卡片',
              ),
              h(
                'button',
                {
                  className: 'dn-btn ghost',
                  onClick: () => {
                    const next = !showSkills
                    setShowSkills(next)
                    if (next) loadSkills()
                  },
                },
                showSkills ? '收起技能' : '分享一个技能',
              ),
              h(
                'button',
                {
                  className: 'dn-btn ghost',
                  onClick: () => {
                    const next = !showPacks
                    setShowPacks(next)
                    if (next && !packs) loadPacks()
                  },
                },
                showPacks ? '收起插件' : '分享插件',
              ),
              h('input', {
                ref: fileRef,
                type: 'file',
                multiple: true,
                style: { display: 'none' },
                onChange: (e) => {
                  uploadHostFiles(e.target.files)
                  e.target.value = ''
                },
              }),
            ),
            showSkills
              ? h(
                  'div',
                  { className: 'dn-skills' },
                  h('input', {
                    className: 'dn-input',
                    style: { margin: '10px 0 0' },
                    placeholder: '搜技能名或用途…',
                    value: skillQuery,
                    onChange: (e) => setSkillQuery(e.target.value),
                  }),
                  !skills
                    ? h('div', { className: 'dn-hint', style: { margin: '10px 0 0' } }, '读技能库…')
                    : skillView.length === 0
                      ? h(
                          'div',
                          { className: 'dn-hint', style: { margin: '10px 0 0' } },
                          skills.length === 0 ? '本机技能库是空的' : '没有匹配的技能',
                        )
                      : skillView.map((sk) =>
                          h(
                            'div',
                            { className: 'dn-skill', key: sk.id },
                            h(
                              'div',
                              { className: 'dn-skill-main' },
                              h('div', { className: 'dn-t1' }, sk.name),
                              h(
                                'div',
                                { className: 'dn-meta' },
                                sk.id + ' · ' + sk.files + ' 个文件 · ' + fmtSize(sk.bytes),
                              ),
                              sk.description
                                ? h('div', { className: 'dn-prev' }, sk.description.slice(0, 160))
                                : null,
                            ),
                            h(
                              'button',
                              { className: 'dn-btn primary small', disabled: busy, onClick: () => shareSkill(sk) },
                              '放进房间',
                            ),
                          ),
                        ),
                )
              : null,
            showPacks
              ? h(
                  'div',
                  { className: 'dn-skills' },
                  h(
                    'p',
                    { className: 'dn-hint', style: { margin: '10px 0 0' } },
                    '勾几个插件，生成一串码——别人粘进自己的 DSH 就能装回同样的插件。',
                  ),
                  !packs
                    ? h('div', { className: 'dn-hint' }, '读插件列表…')
                    : packs.available === false
                      ? h('div', { className: 'dn-hint' }, '这台机器的 DSH 没有插件管理服务')
                      : packs.entries.length === 0
                        ? h('div', { className: 'dn-hint' }, '没有能分享的插件（本地链接安装的插件别人装不了）')
                        : h(
                            'div',
                            { className: 'dn-pack-rows' },
                            packs.entries.map((p) =>
                              h(
                                'label',
                                { className: 'dn-plug' + (packPick[p.name] ? ' pick' : ''), key: p.name },
                                h('input', {
                                  type: 'checkbox',
                                  checked: !!packPick[p.name],
                                  onChange: () => togglePack(p.name),
                                }),
                                h(
                                  'div',
                                  { className: 'dn-plug-main' },
                                  h('div', { className: 'dn-t1' }, p.title || p.name),
                                  h(
                                    'div',
                                    { className: 'dn-meta' },
                                    p.name + (p.version ? '@' + p.version : '') + (p.enabled === false ? ' · 已停用' : ''),
                                  ),
                                ),
                              ),
                            ),
                          ),
                  packs && packs.entries && packs.entries.length
                    ? h(
                        'div',
                        { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6 } },
                        h(
                          'button',
                          { className: 'dn-btn primary small', disabled: busy, onClick: exportPacks },
                          '生成插件码',
                        ),
                        h(
                          'button',
                          { className: 'dn-btn ghost small', onClick: showRecv ? null : () => setShowRecv(true) },
                          showRecv ? '收插件包就在下面' : '我要收别人的',
                        ),
                      )
                    : null,
                  packs && packs.local && packs.local.length
                    ? h(
                        'div',
                        null,
                        h('div', { className: 'dn-h2', style: { marginTop: 16 } }, '本机插件（整包分享）'),
                        h(
                          'p',
                          { className: 'dn-hint' },
                          '这些插件装在本地目录里，没法用插件码；可以整包放进房间，对方下载后一键装成本地插件。',
                        ),
                        h(
                          'div',
                          { className: 'dn-pack-rows' },
                          packs.local.map((pl) =>
                            h(
                              'div',
                              { className: 'dn-plug', key: pl.name },
                              h(
                                'div',
                                { className: 'dn-plug-main' },
                                h('div', { className: 'dn-t1' }, pl.title || pl.name),
                                h(
                                  'div',
                                  { className: 'dn-meta' },
                                  pl.name +
                                    (pl.version ? '@' + pl.version : '') +
                                    ' · ' +
                                    pl.files +
                                    ' 个文件 · ' +
                                    fmtSize(pl.bytes),
                                ),
                                pl.description ? h('div', { className: 'dn-prev' }, pl.description.slice(0, 140)) : null,
                              ),
                              h(
                                'button',
                                {
                                  className: 'dn-btn ghost small',
                                  disabled: busy,
                                  onClick: () => shareLocalPluginInRoom(pl),
                                },
                                '放进房间',
                              ),
                            ),
                          ),
                        ),
                      )
                    : null,
                  packCode
                    ? h(
                        'div',
                        null,
                        h('div', { className: 'dn-code' }, packCode),
                        h(
                          'div',
                          { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
                          h(
                            'button',
                            { className: 'dn-btn ghost small', onClick: () => copy(packCode, '插件码') },
                            '复制插件码',
                          ),
                          h(
                            'button',
                            { className: 'dn-btn primary small', disabled: busy, onClick: putPackInRoom },
                            '放进房间',
                          ),
                        ),
                      )
                    : null,
                )
              : null,
            showRecv
              ? h(
                  'div',
                  { className: 'dn-skills' },
                  h(
                    'p',
                    { className: 'dn-hint', style: { margin: '10px 0 0' } },
                    '把别人给你的插件码粘进来，先看一眼要装什么，再决定装不装。',
                  ),
                  h('textarea', {
                    className: 'dn-textarea',
                    style: { minHeight: 72, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
                    placeholder: 'NSP1-…',
                    value: recvCode,
                    onChange: (e) => {
                      setRecvCode(e.target.value)
                      setRecvPreview(null)
                    },
                  }),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
                    h(
                      'button',
                      {
                        className: 'dn-btn ghost small',
                        disabled: busy || !recvCode.trim(),
                        onClick: () => previewPack(recvCode.trim()),
                      },
                      '看看要装什么',
                    ),
                    recvPreview && recvPreview.rows && recvPreview.rows.some((r) => r.action === 'install' || r.action === 'enable')
                      ? h(
                          'button',
                          { className: 'dn-btn primary small', disabled: busy, onClick: applyPack },
                          '装进我的 DSH',
                        )
                      : null,
                  ),
                  recvPreview && recvPreview.rows
                    ? h(
                        'div',
                        { className: 'dn-pack-rows' },
                        recvPreview.rows.map((r) =>
                          h(
                            'div',
                            { className: 'dn-pack-row', key: r.name },
                            h(
                              'span',
                              null,
                              r.name + (r.version ? '@' + r.version : '') + ' · ' + r.note,
                              r.action === 'skip' ? '' : ' → ' + (r.action === 'enable' ? '启用' : r.action === 'install' ? '装' : '需手动升级'),
                            ),
                          ),
                        ),
                      )
                    : null,
                )
              : null,
            uploads.length
              ? h(
                  'div',
                  { className: 'dn-upload' },
                  uploads.map((u) =>
                    h(
                      'div',
                      { key: u.id },
                      h(
                        'div',
                        { className: 'dn-line' },
                        u.name + (u.failed ? ' · 失败' : ' · ' + u.pct + '%'),
                      ),
                      h(
                        'div',
                        { className: 'dn-bar' },
                        h('i', { style: { width: u.pct + '%' } }),
                      ),
                    ),
                  ),
                )
              : null,
            showCard
              ? h(
                  'div',
                  { style: { marginTop: 16 } },
                  h(
                    'div',
                    { className: 'dn-row' },
                    h(
                      'div',
                      { className: 'dn-field' },
                      h('label', { className: 'dn-label' }, '标题'),
                      h('input', {
                        className: 'dn-input',
                        value: card.title,
                        maxLength: 120,
                        placeholder: '比如：周报精简提示词',
                        onChange: (e) => setCard(Object.assign({}, card, { title: e.target.value })),
                      }),
                    ),
                    h(
                      'div',
                      { className: 'dn-field' },
                      h('label', { className: 'dn-label' }, '标签'),
                      h('input', {
                        className: 'dn-input',
                        value: card.tags,
                        maxLength: 120,
                        placeholder: '写作 周报',
                        onChange: (e) => setCard(Object.assign({}, card, { tags: e.target.value })),
                      }),
                    ),
                  ),
                  h('label', { className: 'dn-label', style: { marginTop: 12 } }, '正文'),
                  h('textarea', {
                    className: 'dn-textarea',
                    value: card.body,
                    maxLength: 20000,
                    placeholder: '把提示词原样贴进来。只是一张卡片，不会被自动执行。',
                    onChange: (e) => setCard(Object.assign({}, card, { body: e.target.value })),
                  }),
                  h(
                    'div',
                    { style: { marginTop: 12 } },
                    h('button', { className: 'dn-btn primary', disabled: busy, onClick: shareCard }, '放进去'),
                  ),
                )
              : null,
          ),

          h(
            'div',
            { className: 'dn-card' },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 } },
              h('div', { className: 'dn-h2', style: { marginBottom: 0 } }, '房间里的东西'),
              h(
                'span',
                { className: 'dn-hint', style: { margin: 0 } },
                room.itemCount + ' 件 · ' + fmtSize(room.totalBytes),
              ),
            ),
            h('p', { className: 'dn-hint', style: { marginTop: 4 } }, '主持人放的可以直接拿走；别人递上来的卡片可以一键收进提示词库。'),
            h(
              'div',
              { className: 'dn-noteform' },
              h('input', {
                className: 'dn-input',
                value: note,
                maxLength: 2000,
                placeholder: '说一句，房间里的人都看得到（回车发送）',
                onChange: (e) => setNote(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter' && !e.isComposing) {
                    e.preventDefault()
                    sendNote()
                  }
                },
              }),
              h('button', { className: 'dn-btn primary', disabled: busy, onClick: sendNote }, '发'),
            ),
            room.items.length
              ? h(
                  'div',
                  { className: 'dn-feed' },
                  room.items.map((it) =>
                    h(
                      'div',
                      { className: 'dn-item' + (it.dir === 'to-guests' ? ' host' : ''), key: it.id },
                      h('div', { className: 'dn-ico' }, it.kind === 'file' ? '▤' : it.kind === 'note' ? '“' : it.kind === 'skill' ? '⌘' : it.kind === 'pack' ? '⊕' : it.kind === 'plugin' ? '⚙' : '✎'),
                      h(
                        'div',
                        { className: 'dn-bd' },
                        h('div', { className: 'dn-t1' }, it.kind === 'note' ? (it.text || it.preview || '（空）') : (it.title || '未命名')),
                        h(
                          'div',
                          { className: 'dn-meta' },
                          h('b', null, it.dir === 'to-guests' ? '我 · 发给大家' : '来自 ' + (it.from || '访客')),
                          ' · ' +
                            fmtTime(it.at) +
                            (it.kind === 'file' || it.kind === 'skill' || it.kind === 'plugin'
                              ? ' · ' + fmtSize(it.size)
                              : ''),
                        ),
                        it.tags && it.tags.length
                          ? h(
                              'div',
                              { className: 'dn-tags' },
                              it.tags.map((t) => h('span', { className: 'dn-tag', key: t }, t)),
                            )
                          : null,
                        (it.kind === 'card' || it.kind === 'skill' || it.kind === 'plugin') && it.preview
                          ? h('div', { className: 'dn-prev' }, it.preview)
                          : null,
                        h(
                          'div',
                          { className: 'dn-acts' },
                          it.kind === 'card'
                            ? h(
                                'button',
                                { className: 'dn-btn ghost small', disabled: busy, onClick: () => importCard(it) },
                                '导入提示词库',
                              )
                            : it.kind === 'skill'
                              ? h(
                                  'a',
                                  {
                                    className: 'dn-btn primary small',
                                    href: API + '/file?id=' + encodeURIComponent(it.id),
                                    style: { textDecoration: 'none' },
                                    download: it.name,
                                  },
                                  '下载技能包',
                                )
                              : it.kind === 'file'
                                ? h(
                                    'a',
                                    {
                                      className: 'dn-btn primary small',
                                      href: API + '/file?id=' + encodeURIComponent(it.id),
                                      style: { textDecoration: 'none' },
                                      download: it.name,
                                    },
                                    '保存',
                                  )
                                : it.kind === 'pack'
                                  ? h(
                                      'button',
                                      {
                                        className: 'dn-btn primary small',
                                        disabled: busy,
                                        onClick: () => {
                                          setShowPacks(false)
                                          setShowRecv(true)
                                          setRecvCode(it.pack && it.pack.code ? it.pack.code : '')
                                          previewPack(it.pack && it.pack.code ? it.pack.code : '')
                                        },
                                      },
                                      '装进我的 DSH',
                                    )
                                  : it.kind === 'plugin'
                                    ? h(
                                        'a',
                                        {
                                          className: 'dn-btn primary small',
                                          href: API + '/file?id=' + encodeURIComponent(it.id),
                                          style: { textDecoration: 'none' },
                                          download: it.name,
                                        },
                                        '下载插件包',
                                      )
                                    : null,
                          it.kind === 'file'
                            ? h(
                                'button',
                                {
                                  className: 'dn-btn ghost small',
                                  onClick: () =>
                                    copy(
                                      it.sha256 ? 'sha256:' + it.sha256 : it.name,
                                      '校验前缀',
                                    ),
                                },
                                '复制校验前缀',
                              )
                            : it.kind === 'plugin'
                              ? h(
                                  'button',
                                  {
                                    className: 'dn-btn ghost small',
                                    disabled: busy,
                                    onClick: () => installLocalPluginItem(it),
                                  },
                                  '装成本地插件',
                                )
                              : null,
                          it.kind === 'file' && /\.zip$/i.test(it.name || '')
                            ? h(
                                'button',
                                { className: 'dn-btn ghost small', disabled: busy, onClick: () => installSkill(it) },
                                '装成技能',
                              )
                            : null,
                        ),
                      ),
                    ),
                  ),
                )
              : h('div', { className: 'dn-empty' }, '还没有东西。放一个进去，或者等对方递过来。'),
            h('div', { className: 'dn-path' }, '收件目录：' + room.inboxDir),
          ),
        )
      }
    }

    /* ---------------------------------------------------------------- */
    /* icon                                                             */
    /* ---------------------------------------------------------------- */

    function PanelIcon(props) {
      const size = (props && props.size) || 16
      const active = !!(props && props.active)
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 12, cy: 12, r: 2.2, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M7.7 7.7a6 6 0 0 0 0 8.6' }),
        h('path', { d: 'M16.3 7.7a6 6 0 0 1 0 8.6' }),
        h('path', { d: 'M4.9 4.9a10 10 0 0 0 0 14.2' }),
        h('path', { d: 'M19.1 4.9a10 10 0 0 1 0 14.2' }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'dsh-nearby', order: 40, label: '邻座' },
            PanelIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'dsh-nearby' }, NearbyPanel),
        )
      },
    }
  },
})
