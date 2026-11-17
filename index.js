/**
 * 邻座 · NextSeat — host half.
 *
 * A room is a temporary, LAN-only drop box. The host opens a room in the
 * DSH panel; anyone on the same Wi-Fi opens the printed URL (QR) in a phone
 * browser and can hand files / prompt cards over. Nothing leaves the LAN,
 * nothing is uploaded to a server, the room dies on close or after its TTL.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, promises as fsp, readFileSync, statSync } from 'node:fs'
import { createSocket } from 'node:dgram'
import { createServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { createRequire } from 'node:module'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const requireCjs = createRequire(import.meta.url)
const qrcode = requireCjs('./vendor/qrcode.cjs')

const ROOT = join(homedir(), '.dsh', 'storages', 'dsh_nearby')
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_REMOTE_FILE_BYTES = 95 * 1024 * 1024
const CHUNK_BYTES = 32 * 1024 * 1024
const MAX_ITEMS = 300
const MAX_GUESTS = 200
const DEFAULT_TTL_MIN = 120
const MAX_CARD_BODY = 20000
const MAX_CARD_TITLE = 120
const MAX_TAGS = 10
const MAX_NOTE_CHARS = 2000
const ONLINE_WINDOW_MS = 45_000

/** @type {null | Room} */
let room = null
// 关房后保留监听一小会儿，让还开着页面的访客刷新时能看到「房间已关闭」，
// 而不是浏览器的连接失败页。
const CLOSE_GRACE_MS = 60_000
const closing = new Set()
let guestHtmlCache = null

/* 局域网自动发现：同一 Wi-Fi 下开着邻座的实例互相广播存在 */
const DISCOVERY_PORT = 53981
const DISCOVERY_INTERVAL_MS = 3500
const PEER_TTL_MS = 15000
const INSTANCE_ID = randomBytes(8).toString('hex')
const peers = new Map()
let discoSocket = null
let discoTimer = null
let discoLastBeacon = 0

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  if (res.headersSent) return
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(data)
}

function sendHtml(res, html) {
  const data = Buffer.from(html)
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  })
  res.end(data)
}

function readJsonBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('body-too-large'), { code: 'BODY_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = chunks.length ? Buffer.concat(chunks).toString('utf8') : ''
        resolve(text.trim() ? JSON.parse(text) : {})
      } catch {
        reject(Object.assign(new Error('bad-json'), { code: 'BAD_JSON' }))
      }
    })
    req.on('error', reject)
  })
}

function isPrivateAddress(raw) {
  if (!raw) return false
  let a = String(raw)
  if (a.startsWith('::ffff:')) a = a.slice(7)
  if (a === '::1') return true
  if (a.includes(':')) {
    const l = a.toLowerCase()
    return (
      l.startsWith('fc') ||
      l.startsWith('fd') ||
      l.startsWith('fe8') ||
      l.startsWith('fe9') ||
      l.startsWith('fea') ||
      l.startsWith('feb')
    )
  }
  const p = a.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  if (p[0] === 127) return true
  if (p[0] === 10) return true
  if (p[0] === 192 && p[1] === 168) return true
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
  if (p[0] === 169 && p[1] === 254) return true
  return false
}

const IFACE_SKIP = /^(bridge|utun|awdl|llw|anpi|vmenet|vmnet|lo|gif|stf|tap|tun)/i

/**
 * The address a guest would actually reach: ask the routing table by
 * "connecting" a UDP socket (no packet is sent) and reading the local end.
 */
function primaryAddress() {
  return new Promise((resolve) => {
    let settled = false
    const sock = createSocket('udp4')
    const done = (v) => {
      if (settled) return
      settled = true
      try {
        sock.close()
      } catch {
        /* already closed */
      }
      resolve(v || '')
    }
    sock.once('error', () => done(''))
    sock.connect(53, '223.5.5.5', () => {
      try {
        done(sock.address().address)
      } catch {
        done('')
      }
    })
    const t = setTimeout(() => done(''), 400)
    t.unref?.()
  })
}

async function lanAddresses() {
  const primary = await primaryAddress()
  const out = []
  for (const [iface, list] of Object.entries(networkInterfaces())) {
    if (IFACE_SKIP.test(iface)) continue
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue
      if (!isPrivateAddress(ni.address)) continue
      if (out.some((x) => x.address === ni.address)) continue
      out.push({ iface, address: ni.address })
    }
  }
  if (primary && isPrivateAddress(primary) && !out.some((x) => x.address === primary)) {
    out.unshift({ iface: 'default', address: primary })
  }
  const score = (x) => (x.address.startsWith('192.168.') ? 0 : x.address.startsWith('10.') ? 1 : 2)
  out.sort((a, b) => {
    if (a.address === primary) return -1
    if (b.address === primary) return 1
    return score(a) - score(b)
  })
  return out.slice(0, 3)
}

function safeName(raw) {
  let n = String(raw || '').normalize('NFC')
  n = n
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^\.+/, '')
    .trim()
  if (!n) n = 'file'
  if (n.length > 120) {
    const dot = n.lastIndexOf('.')
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : ''
    n = n.slice(0, 120 - ext.length) + ext
  }
  return n
}

function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

function defaultHostName() {
  const h = String(hostname() || '').split('.')[0]
  return h || '主持人'
}

function publicItem(it) {
  const card = it.card
  const skill = it.kind === 'skill' ? it.skill || {} : null
  const noteText = it.kind === 'note' ? String(it.text || '') : ''
  return {
    id: it.id,
    kind: it.kind,
    dir: it.dir,
    title:
      it.kind === 'card'
        ? card.title
        : it.kind === 'note'
          ? ''
          : it.kind === 'skill'
            ? skill.name || it.name
            : it.name,
    name: it.name || '',
    size: it.size || 0,
    sha256: it.sha256 ? it.sha256.slice(0, 16) : '',
    at: it.at,
    from: it.from || '',
    tags: card ? card.tags : [],
    preview: card
      ? card.body.slice(0, 180)
      : it.kind === 'skill'
        ? String(skill.description || '').slice(0, 200)
        : noteText.slice(0, 200),
    text: it.kind === 'note' ? noteText.slice(0, 400) : '',
    truncated: it.kind === 'note' ? noteText.length > 400 : false,
    skill,
  }
}

function normalizeCard(input) {
  const card = input && typeof input === 'object' ? input : {}
  const title = String(card.title || '')
    .trim()
    .slice(0, MAX_CARD_TITLE)
  let tags = Array.isArray(card.tags) ? card.tags : String(card.tags || '').split(/[,，\s]+/)
  tags = tags
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .slice(0, MAX_TAGS)
    .map((t) => t.slice(0, 24))
  const body = String(card.body || '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, MAX_CARD_BODY)
  return { title: title || '未命名卡片', tags, body, author: String(card.author || '').trim().slice(0, 40) }
}

function touchGuest(r, id, name) {
  let gid = String(id || '').slice(0, 40)
  if (!gid) gid = 'g-' + randomBytes(4).toString('hex')
  let g = r.participants.get(gid)
  const nm = String(name || '').trim().slice(0, 24)
  if (!g) {
    g = { id: gid, name: nm || '访客', joinedAt: Date.now(), lastSeen: Date.now() }
    if (r.participants.size < MAX_GUESTS) r.participants.set(gid, g)
  } else {
    g.lastSeen = Date.now()
    if (nm) g.name = nm
  }
  return g
}

/* ------------------------------------------------------------------ */
/* room lifecycle                                                      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* discovery (LAN broadcast, no dependency)                           */
/* ------------------------------------------------------------------ */

function broadcastTargets() {
  const out = new Set(['255.255.255.255'])
  const ifaces = networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal || !ni.netmask) continue
      const ip = ni.address.split('.').map(Number)
      const mask = ni.netmask.split('.').map(Number)
      if (ip.length !== 4 || mask.length !== 4) continue
      if (ip.some((n) => Number.isNaN(n)) || mask.some((n) => Number.isNaN(n))) continue
      out.add(ip.map((n, i) => ((n & mask[i]) | (~mask[i] & 255))).join('.'))
    }
  }
  return [...out]
}

function discoveryPayload() {
  return JSON.stringify({
    v: 1,
    kind: 'hello',
    id: INSTANCE_ID,
    name: defaultHostName(),
    host: hostname(),
    room: room
      ? {
          code: room.code,
          name: room.name || '',
          hostName: room.hostName || '',
          joinUrl: room.joinUrl || '',
          expiresAt: room.expiresAt || 0,
        }
      : null,
  })
}

function prunePeers() {
  const now = Date.now()
  for (const [id, p] of peers) {
    if (now - p.lastSeen > PEER_TTL_MS) peers.delete(id)
  }
}

function beacon() {
  if (!discoSocket) return
  const payload = Buffer.from(discoveryPayload())
  discoLastBeacon = Date.now()
  for (const addr of broadcastTargets()) {
    try {
      discoSocket.send(payload, DISCOVERY_PORT, addr)
    } catch {
      /* one bad interface must not stop the rest */
    }
  }
  try {
    discoSocket.send(payload, DISCOVERY_PORT, '127.0.0.1')
  } catch {
    /* ignore */
  }
  prunePeers()
}

function onDiscoveryMessage(buf, rinfo) {
  if (!buf || buf.length > 4096) return
  if (!rinfo || !isPrivateAddress(rinfo.address)) return
  let msg
  try {
    msg = JSON.parse(buf.toString('utf8'))
  } catch {
    return
  }
  if (!msg || msg.v !== 1 || msg.kind !== 'hello' || typeof msg.id !== 'string') return
  if (msg.id === INSTANCE_ID || msg.id.length > 64) return
  if (!peers.has(msg.id) && peers.size >= 64) return

  let info = null
  if (msg.room && typeof msg.room === 'object') {
    let okUrl = ''
    try {
      const u = new URL(String(msg.room.joinUrl || ''))
      if (u.protocol === 'http:' && isPrivateAddress(u.hostname)) okUrl = u.toString()
    } catch {
      /* ignore bad url */
    }
    if (okUrl) {
      info = {
        code: String(msg.room.code || '').slice(0, 8),
        name: String(msg.room.name || '').slice(0, 60),
        hostName: String(msg.room.hostName || '').slice(0, 40),
        joinUrl: okUrl,
        expiresAt: Number(msg.room.expiresAt) || 0,
      }
      if (info.expiresAt && info.expiresAt < Date.now()) info = null
    }
  }

  peers.set(msg.id, {
    id: msg.id,
    name: String(msg.name || '').slice(0, 60),
    host: String(msg.host || '').slice(0, 60),
    ip: rinfo.address,
    room: info,
    lastSeen: Date.now(),
  })
}

function startDiscovery() {
  if (discoSocket) return
  let sock
  try {
    sock = createSocket({ type: 'udp4', reuseAddr: true })
  } catch {
    return
  }
  discoSocket = sock
  sock.on('error', () => {
    try {
      sock.close()
    } catch {
      /* ignore */
    }
    if (discoSocket === sock) discoSocket = null
  })
  sock.on('message', (buf, rinfo) => {
    try {
      onDiscoveryMessage(buf, rinfo)
    } catch {
      /* never crash the host on a bad datagram */
    }
  })
  sock.bind(DISCOVERY_PORT, () => {
    try {
      sock.setBroadcast(true)
    } catch {
      /* ignore */
    }
    beacon()
    discoTimer = setInterval(beacon, DISCOVERY_INTERVAL_MS)
    if (discoTimer.unref) discoTimer.unref()
  })
}

function stopDiscovery() {
  if (discoTimer) {
    clearInterval(discoTimer)
    discoTimer = null
  }
  if (discoSocket) {
    try {
      discoSocket.close()
    } catch {
      /* ignore */
    }
    discoSocket = null
  }
  peers.clear()
}

function nearbySnapshot() {
  prunePeers()
  const list = [...peers.values()]
    .sort((a, b) => (b.room ? 1 : 0) - (a.room ? 1 : 0) || b.lastSeen - a.lastSeen)
    .slice(0, 32)
    .map((p) => ({ id: p.id, name: p.name, host: p.host, ip: p.ip, room: p.room, lastSeen: p.lastSeen }))
  return {
    ok: true,
    enabled: !!discoSocket,
    port: DISCOVERY_PORT,
    self: { id: INSTANCE_ID, name: defaultHostName(), room: room ? { code: room.code } : null },
    peers: list,
  }
}

async function openRoom({ hostName, name, minutes, relay = false } = {}) {
  await closeRoom('reopen')

  const code = String(randomInt(1000, 10000))
  const token = randomBytes(16).toString('hex')
  const ttlMin = clamp(minutes || DEFAULT_TTL_MIN, 5, 480)
  const dir = join(ROOT, 'rooms', code)
  await fsp.mkdir(join(dir, 'files'), { recursive: true })
  await fsp.mkdir(join(dir, 'cards'), { recursive: true })

  const r = {
    code,
    token,
    dir,
    hostName: String(hostName || defaultHostName()).trim().slice(0, 40) || defaultHostName(),
    name: String(name || '').trim().slice(0, 60),
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMin * 60_000,
    items: [],
    participants: new Map(),
    port: 0,
    urls: [],
    joinUrl: '',
    server: null,
    timer: null,
    qrCache: null,
    uploads: new Map(),
  }

  const srv = createServer((req, res) => {
    handleGuest(req, res).catch(() => {
      try {
        sendJson(res, 500, { ok: false, error: 'server-error' })
      } catch {
        /* socket already gone */
      }
    })
  })
  srv.on('clientError', (_err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    } catch {
      /* ignore */
    }
  })

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err)
    srv.once('error', onError)
    srv.listen(0, '0.0.0.0', () => {
      srv.off('error', onError)
      resolve()
    })
  })

  const port = srv.address().port
  const urls = (await lanAddresses()).map(({ iface, address }) => ({
    iface,
    ip: address,
    url: `http://${address}:${port}/r/${code}?k=${token}`,
  }))
  if (!urls.length) {
    urls.push({ iface: 'loopback', ip: '127.0.0.1', url: `http://127.0.0.1:${port}/r/${code}?k=${token}`, local: true })
  }

  r.server = srv
  r.port = port
  r.urls = urls
  r.joinUrl = urls[0].url
  r.timer = setTimeout(() => {
    if (room === r) void closeRoom('expired')
  }, r.expiresAt - Date.now())
  r.timer.unref?.()

  room = r
  beacon()
  if (relay) void startRelay(r)
  return r
}

async function closeRoom(reason, { immediate = false } = {}) {
  const r = room
  if (!r) return
  room = null
  if (r.timer) clearTimeout(r.timer)
  stopRelay(r)
  void reason
  beacon()
  if (immediate) {
    await shutdownServer(r)
    return
  }
  closing.add(r)
  while (closing.size > 3) {
    // 反复开关房时最多保留 3 个宽限期监听，超出立刻收掉最早的
    const oldest = closing.values().next().value
    closing.delete(oldest)
    void shutdownServer(oldest)
  }
  const t = setTimeout(() => {
    closing.delete(r)
    void shutdownServer(r)
  }, CLOSE_GRACE_MS)
  t.unref?.()
  r.graceTimer = t
}

async function shutdownServer(r) {
  if (r.graceTimer) {
    clearTimeout(r.graceTimer)
    r.graceTimer = null
  }
  const srv = r.server
  if (!srv) return
  r.server = null
  await new Promise((resolve) => {
    try {
      srv.close(() => resolve())
      srv.closeAllConnections?.()
    } catch {
      resolve()
    }
    setTimeout(resolve, 1500).unref?.()
  })
}

async function shutdownAll() {
  const pending = [...closing]
  closing.clear()
  await Promise.all(pending.map((r) => shutdownServer(r)))
}

/* ------------------------------------------------------------------ */
/* public relay: ssh reverse tunnel + a tiny TCP forwarder on the VPS  */
/* ------------------------------------------------------------------ */

const RELAY_SCRIPT = `#!/usr/bin/env python3
import socket, sys, threading

listen, target = int(sys.argv[1]), int(sys.argv[2])


def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(cli):
    try:
        up = socket.create_connection(("127.0.0.1", target), timeout=10)
    except OSError:
        cli.close()
        return
    up.settimeout(None)
    cli.settimeout(None)
    t = threading.Thread(target=pipe, args=(cli, up), daemon=True)
    t.start()
    pipe(up, cli)
    t.join(30)
    cli.close()
    up.close()


srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", listen))
srv.listen(64)
while True:
    cli, _ = srv.accept()
    threading.Thread(target=handle, args=(cli,), daemon=True).start()
`

let relayCfg = null
let relayCfgAt = 0

function relayConfig() {
  if (relayCfg && Date.now() - relayCfgAt < 60_000) return relayCfg
  let file = {}
  try {
    file = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')) || {}
  } catch {
    file = {}
  }
  const rc = file.relay || {}
  const tn = file.tunnel || {}
  const lo = clamp(rc.portMin || 39000, 1024, 65000)
  const hi = clamp(rc.portMax || 39999, lo + 1, 65534)
  relayCfg = {
    kind: process.env.DSH_NEARBY_TUNNEL || tn.kind || 'cloudflare',
    cloudflared: process.env.CLOUDFLARED_BIN || tn.cloudflared || 'cloudflared',
    sshHost: process.env.DSH_NEARBY_RELAY_SSH || rc.sshHost || '',
    publicHost: process.env.DSH_NEARBY_RELAY_HOST || rc.publicHost || '',
    portMin: lo,
    portMax: hi,
  }
  relayCfgAt = Date.now()
  return relayCfg
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sshExec(cfg, cmd, input) {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok, err) => {
      if (done) return
      done = true
      resolve({ ok, err: err || '' })
    }
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', cfg.sshHost, cmd], {
      stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'],
    })
    let err = ''
    p.stderr.on('data', (b) => {
      err = (err + b.toString()).slice(-400)
    })
    p.on('error', (e) => finish(false, e.message))
    p.on('close', (code) => finish(code === 0, err))
    if (input) p.stdin.end(input)
  })
}

function probePort(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false
    const sock = netConnect({ host, port })
    const finish = (ok) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => finish(false))
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
  })
}

async function runRelayOnce(r, cfg, st) {
  const ssh = spawn(
    'ssh',
    [
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'BatchMode=yes',
      '-R', `127.0.0.1:${st.tun}:127.0.0.1:${r.port}`,
      cfg.sshHost,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  st.ssh = ssh
  let stderr = ''
  ssh.stderr.on('data', (b) => {
    stderr = (stderr + b.toString()).slice(-300)
  })
  ssh.on('error', (e) => {
    st.error = e.message
    st.state = 'failed'
  })
  ssh.on('exit', (code) => {
    if (st.state !== 'up') {
      st.state = 'failed'
      st.error = 'ssh ' + code + (stderr ? ': ' + stderr.trim() : '')
    } else {
      st.state = 'closed'
    }
  })

  await sleep(800)
  if (st.state === 'failed' || room !== r) return false

  const put = await sshExec(cfg, 'cat > /root/nearby-relay.py', RELAY_SCRIPT)
  if (!put.ok) {
    st.state = 'failed'
    st.error = 'relay-script-failed ' + put.err
    return false
  }
  const launch = await sshExec(
    cfg,
    `nohup python3 /root/nearby-relay.py ${st.pub} ${st.tun} >/tmp/nearby-relay-${st.pub}.log 2>&1 & echo started`,
  )
  if (!launch.ok) {
    st.state = 'failed'
    st.error = 'relay-launch-failed ' + launch.err
    return false
  }
  if (room !== r || st.state === 'failed') return false
  if (!(await probePort(cfg.publicHost, st.pub))) {
    st.state = 'failed'
    st.error = 'relay-port-unreachable'
    return false
  }
  st.state = 'up'
  st.url = `http://${cfg.publicHost}:${st.pub}`
  const guestUrl = `${st.url}/r/${r.code}?k=${r.token}`
  r.joinUrl = guestUrl
  r.urls = [{ iface: 'relay', ip: cfg.publicHost, url: guestUrl }, ...r.urls]
  r.qrCache = null
  beacon()
  return true
}

async function runCloudflareOnce(r, cfg, st) {
  return new Promise((resolve) => {
    let finished = false
    let buf = ''
    let child = null
    const finish = (ok) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => {
      st.state = 'failed'
      st.error = 'tunnel-timeout ' + buf.slice(-160).replace(/\s+/g, ' ')
      finish(false)
    }, 25_000)
    timer.unref?.()
    try {
      child = spawn(cfg.cloudflared || 'cloudflared', ['tunnel', '--url', `http://127.0.0.1:${r.port}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      st.state = 'failed'
      st.error = 'cloudflared: ' + (err instanceof Error ? err.message : String(err))
      finish(false)
      return
    }
    st.child = child
    const onData = (b) => {
      buf = (buf + b.toString()).slice(-4000)
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (m && st.state === 'starting') {
        st.state = 'up'
        st.url = m[0]
        const guestUrl = `${st.url}/r/${r.code}?k=${r.token}`
        r.joinUrl = guestUrl
        r.urls = [{ iface: 'tunnel', ip: 'cloudflare', url: guestUrl }, ...r.urls]
        r.qrCache = null
        beacon()
        finish(true)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (e) => {
      st.state = 'failed'
      st.error = 'cloudflared: ' + e.message
      finish(false)
    })
    child.on('exit', (code) => {
      if (st.state !== 'up') {
        st.state = 'failed'
        st.error = 'cloudflared exit ' + code
        finish(false)
      } else {
        st.state = 'closed'
      }
    })
  })
}

async function startSshRelay(r, cfg) {
  if (!cfg.sshHost || !cfg.publicHost) {
    r.relay = { state: 'failed', pub: 0, tun: 0, url: '', error: 'relay-not-configured' }
    return
  }
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const pub = randomInt(cfg.portMin, cfg.portMax + 1)
    let tun = randomInt(cfg.portMin, cfg.portMax + 1)
    if (tun === pub) tun = tun === cfg.portMax ? cfg.portMin : tun + 1
    const st = { state: 'starting', pub, tun, url: '', error: '', child: null, ssh: null }
    r.relay = st
    if (await runRelayOnce(r, cfg, st)) return
    lastError = st.error || 'relay-failed'
    stopRelay(r)
    if (room !== r) return
  }
  r.relay = { state: 'failed', pub: 0, tun: 0, url: '', error: lastError }
}

async function startRelay(r) {
  const cfg = relayConfig()
  if (cfg.kind === 'ssh') {
    await startSshRelay(r, cfg)
    return
  }
  const st = { state: 'starting', pub: 0, tun: 0, url: '', error: '', child: null }
  r.relay = st
  if (!(await runCloudflareOnce(r, cfg, st))) {
    try {
      st.child?.kill()
    } catch {
      /* ignore */
    }
    if (room === r) {
      r.relay = { state: 'failed', pub: 0, tun: 0, url: '', error: st.error || 'tunnel-failed' }
    }
  }
}

function stopRelay(r) {
  const st = r && r.relay
  if (!st) return
  r.relay = null
  try {
    st.child?.kill()
  } catch {
    /* ignore */
  }
  try {
    st.ssh?.kill()
  } catch {
    /* ignore */
  }
  const cfg = relayConfig()
  if (cfg.sshHost && st.pub) {
    void sshExec(cfg, `pkill -f "nearby-relay.py ${st.pub} " >/dev/null 2>&1 || true`)
  }
}

function relaySnapshot() {
  const cfg = relayConfig()
  const st = room && room.relay
  return {
    ok: true,
    configured: !!(cfg.sshHost && cfg.publicHost),
    sshHost: cfg.sshHost,
    publicHost: cfg.publicHost,
    state: st ? st.state : 'idle',
    url: st && st.state === 'up' ? room.joinUrl : '',
    error: st ? st.error : '',
  }
}

function roomSnapshot() {
  if (!room) return null
  const now = Date.now()
  const participants = [...room.participants.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .slice(0, MAX_GUESTS)
    .map((p) => ({ id: p.id, name: p.name, at: p.joinedAt, online: now - p.lastSeen < ONLINE_WINDOW_MS }))
  return {
    code: room.code,
    name: room.name || `邻座 ${room.code}`,
    hostName: room.hostName,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    port: room.port,
    urls: room.urls,
    joinUrl: room.joinUrl,
    participants,
    onlineCount: participants.filter((p) => p.online).length,
    items: room.items
      .slice(-MAX_ITEMS)
      .reverse()
      .map(publicItem),
    itemCount: room.items.length,
    totalBytes: room.items.reduce((s, i) => s + (i.size || 0), 0),
    inboxDir: join(room.dir, 'files'),
    root: ROOT,
    relay: room.relay
      ? {
          state: room.relay.state,
          pub: room.relay.pub,
          url: room.relay.state === 'up' ? room.joinUrl : '',
          error: room.relay.error,
        }
      : null,
  }
}

/* ------------------------------------------------------------------ */
/* item creation (shared by host and guest uploads)                    */
/* ------------------------------------------------------------------ */

function makeHasher() {
  const hash = createHash('sha256')
  let size = 0
  const stream = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length
      if (size > MAX_FILE_BYTES) {
        cb(Object.assign(new Error('too-large'), { code: 'TOO_LARGE' }))
        return
      }
      hash.update(chunk)
      cb(null, chunk)
    },
  })
  return {
    stream,
    get size() {
      return size
    },
    digest: () => hash.digest('hex'),
  }
}

async function receiveFile(r, req, { name, dir, from }) {
  if (room !== r) {
    const err = new Error('room-closed')
    err.code = 'ROOM_CLOSED'
    throw err
  }
  if (r.items.length >= MAX_ITEMS) {
    const err = new Error('room-full')
    err.code = 'ROOM_FULL'
    throw err
  }
  const declared = Number(req.headers['content-length'] || 0)
  const cap = r.relay && r.relay.state === 'up' ? MAX_REMOTE_FILE_BYTES : MAX_FILE_BYTES
  if (declared > cap) {
    const err = new Error('too-large')
    err.code = 'TOO_LARGE'
    throw err
  }

  const id = randomBytes(6).toString('hex')
  const clean = safeName(name)
  const finalPath = join(r.dir, 'files', `${id}-${clean}`)
  const tmpPath = finalPath + '.part'
  const hasher = makeHasher()
  try {
    await pipeline(req, hasher.stream, createWriteStream(tmpPath))
    await fsp.rename(tmpPath, finalPath)
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }

  const item = {
    id,
    kind: 'file',
    dir,
    name: clean,
    size: hasher.size,
    sha256: hasher.digest(),
    at: Date.now(),
    path: finalPath,
    from,
  }
  r.items.push(item)
  return item
}

function addCard(r, cardInput, { dir, from }) {
  if (r.items.length >= MAX_ITEMS) {
    const err = new Error('room-full')
    err.code = 'ROOM_FULL'
    throw err
  }
  const card = normalizeCard(cardInput)
  if (!card.body) {
    const err = new Error('empty-card')
    err.code = 'EMPTY_CARD'
    throw err
  }
  const id = randomBytes(6).toString('hex')
  const item = {
    id,
    kind: 'card',
    dir,
    name: '',
    at: Date.now(),
    card: { ...card, author: card.author || from },
    from,
  }
  r.items.push(item)
  const payload = JSON.stringify({ ...item, at: new Date(item.at).toISOString() }, null, 2)
  void fsp
    .writeFile(join(r.dir, 'cards', `${id}.json`), payload + '\n')
    .catch(() => {})
  return item
}

function addNote(r, text, from) {
  if (r.items.length >= MAX_ITEMS) {
    const err = new Error('room-full')
    err.code = 'ROOM_FULL'
    throw err
  }
  const body = String(text || '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, MAX_NOTE_CHARS)
  if (!body) {
    const err = new Error('empty-note')
    err.code = 'EMPTY_NOTE'
    throw err
  }
  const item = {
    id: randomBytes(6).toString('hex'),
    kind: 'note',
    dir: 'to-all',
    name: '',
    at: Date.now(),
    text: body,
    from: from || '访客',
  }
  r.items.push(item)
  return item
}

function fmtBytes(n) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return (i === 0 ? v : v.toFixed(v >= 10 ? 0 : 1)) + ' ' + units[i]
}

/**
 * 把宿主本机的一个文件复制进房间（供 Agent 工具使用）。
 * 和访客上传走同一条落盘路径：限流、sha256、净化文件名。
 */
async function shareLocalFile(r, rawPath, from) {
  const want = String(rawPath || '').trim()
  const fail = (code, message) => {
    const err = new Error(message)
    err.code = code
    return err
  }
  if (!want) throw fail('NO_PATH', '缺少文件路径')
  const abs = want.startsWith('~/')
    ? join(homedir(), want.slice(2))
    : isAbsolute(want)
      ? want
      : resolve(want)
  let stat
  try {
    stat = await fsp.stat(abs)
  } catch {
    throw fail('NO_FILE', `找不到这个文件：${abs}`)
  }
  if (!stat.isFile()) throw fail('NO_FILE', `这不是一个文件：${abs}`)
  if (stat.size > MAX_FILE_BYTES) throw fail('TOO_LARGE', '文件超过 2 GB 上限')
  if (r.items.length >= MAX_ITEMS) throw fail('ROOM_FULL', '房间里的东西太多了')

  const clean = safeName(basename(abs))
  const filesDir = join(r.dir, 'files')
  await fsp.mkdir(filesDir, { recursive: true })
  const dest = join(filesDir, `${Date.now().toString(36)}-${clean}`)
  const tmp = dest + '.part'
  const hasher = makeHasher()
  try {
    await pipeline(createReadStream(abs), hasher.stream, createWriteStream(tmp))
    await fsp.rename(tmp, dest)
  } catch (err) {
    void fsp.rm(tmp, { force: true }).catch(() => {})
    if (err && err.code === 'TOO_LARGE') throw err
    throw fail('COPY_FAILED', '复制文件时出错了')
  }
  const item = {
    id: randomBytes(6).toString('hex'),
    kind: 'file',
    dir: 'to-guests',
    name: clean,
    size: hasher.size,
    sha256: hasher.digest(),
    at: Date.now(),
    path: dest,
    from,
  }
  r.items.push(item)
  return item
}

async function importCard(item, code) {
  const promptsDir = join(ROOT, 'prompts')
  const libPath = join(promptsDir, 'library.json')
  let lib = []
  try {
    const parsed = JSON.parse(await fsp.readFile(libPath, 'utf8'))
    if (Array.isArray(parsed)) lib = parsed
  } catch {
    /* first import */
  }
  const fingerprint = createHash('sha256').update(item.card.body).digest('hex').slice(0, 16)
  const existing = lib.find((e) => e && e.fingerprint === fingerprint)
  if (existing) return { ok: true, duplicate: true, path: libPath, count: lib.length, id: existing.id }

  const entry = {
    id: 'p-' + randomBytes(5).toString('hex'),
    title: item.card.title,
    tags: item.card.tags,
    body: item.card.body,
    author: item.card.author || item.from || '',
    fingerprint,
    importedAt: new Date().toISOString(),
    room: code,
  }
  lib.push(entry)
  await fsp.mkdir(promptsDir, { recursive: true })
  await fsp.writeFile(libPath, JSON.stringify(lib, null, 2) + '\n')
  return { ok: true, path: libPath, count: lib.length, id: entry.id }
}

/* ------------------------------------------------------------------ */
/* skills                                                              */
/* ------------------------------------------------------------------ */

let skillsService = null
const skillStatsCache = new Map()
const SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function skillRoots() {
  const home = homedir()
  const roots = [
    join(home, '.dsh', 'skills'),
    join(home, '.agents', 'skills'),
    join(home, '.cc-switch', 'skills'),
    join(home, '.codex', 'skills'),
    join(home, '.claude', 'skills'),
    join(home, '.cursor', 'skills'),
    join(home, '.gemini', 'skills'),
    join(home, '.config', 'opencode', 'skills'),
    join(home, '.codeium', 'windsurf', 'skills'),
    join(home, '.roo', 'skills'),
    join(process.cwd(), 'skills'),
  ]
  const seen = new Set()
  return roots.filter((r) => {
    const key = resolve(r)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseSkillMeta(text) {
  const meta = {}
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''))
  if (!m) return meta
  for (const raw of m[1].split(/\r?\n/)) {
    const i = raw.indexOf(':')
    if (i <= 0) continue
    const key = raw.slice(0, i).trim()
    let val = raw.slice(i + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (key) meta[key] = val
  }
  return meta
}

async function collectFiles(dir, base = dir, out = [], cap = Infinity) {
  if (out.length >= cap) return out
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (out.length >= cap) return out
    if (e.name === '.DS_Store' || e.name === '__MACOSX') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      await collectFiles(full, base, out, cap)
    } else if (e.isFile()) {
      let bytes = 0
      try {
        bytes = (await fsp.stat(full)).size
      } catch {
        /* ignore */
      }
      out.push({ rel: full.slice(base.length + 1), bytes })
    }
  }
  return out
}

async function skillStats(dir) {
  const hit = skillStatsCache.get(dir)
  if (hit && Date.now() - hit.at < 60_000) return hit
  const files = await collectFiles(dir, dir, [], 2000)
  const stat = {
    at: Date.now(),
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    capped: files.length >= 2000,
  }
  skillStatsCache.set(dir, stat)
  return stat
}

function describeDirSkill(dir, name, description, whenToUse, st, extra) {
  return {
    id: basename(dir),
    name: name || basename(dir),
    description: String(description || '').slice(0, 300),
    whenToUse: String(whenToUse || '').slice(0, 240),
    files: st.files,
    bytes: st.bytes,
    capped: st.capped,
    root: dirname(dir),
    dir,
    ...extra,
  }
}

async function listSkills() {
  const seen = new Set()
  const found = []

  // 首选宿主 skills 服务：它聚合了 DSH、各 Agent（Claude/Codex/WorkBuddy…）
  // 与项目级技能，覆盖面远大于固定目录扫描。
  if (skillsService && typeof skillsService.list === 'function') {
    try {
      const catalog = await skillsService.list({ cwd: process.cwd() })
      for (const s of catalog) {
        if (!s || typeof s.name !== 'string') continue
        const docPath = typeof s.path === 'string' ? s.path : ''
        if (!docPath || basename(docPath) !== 'SKILL.md') continue
        const dir = dirname(docPath)
        let real = dir
        try {
          real = await fsp.realpath(dir)
        } catch {
          /* keep raw path */
        }
        if (seen.has(real)) continue
        seen.add(real)
        const st = await skillStats(dir)
        found.push(
          describeDirSkill(dir, s.name, s.description, s.whenToUse, st, {
            source: String(s.source || ''),
            provider: String(s.provider || ''),
          }),
        )
      }
    } catch (err) {
      console.warn('[dsh-nearby] 读取技能目录失败：' + String(err && err.message ? err.message : err))
    }
  }

  // 服务不可用时的兜底：扫描常见技能根目录。
  if (!found.length) {
    for (const root of skillRoots()) {
      let entries = []
      try {
        entries = await fsp.readdir(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (!e.isDirectory() || !SKILL_ID_RE.test(e.name)) continue
        const dir = join(root, e.name)
        let doc
        try {
          doc = await fsp.readFile(join(dir, 'SKILL.md'), 'utf8')
        } catch {
          continue
        }
        let real = dir
        try {
          real = await fsp.realpath(dir)
        } catch {
          /* keep raw path */
        }
        if (seen.has(real)) continue
        seen.add(real)
        const meta = parseSkillMeta(doc)
        const st = await skillStats(dir)
        found.push(describeDirSkill(dir, meta.name || e.name, meta.description, meta.whenToUse, st))
      }
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name))
}

function pickSkill(skills, want) {
  const key = String(want || '').trim().toLowerCase()
  if (!key) return null
  return (
    skills.find((s) => s.id.toLowerCase() === key) ||
    skills.find((s) => String(s.name).toLowerCase() === key) ||
    skills.find((s) => s.id.toLowerCase().includes(key)) ||
    null
  )
}

function runCapture(cmd, args, opts) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => {
      out += String(c)
    })
    child.stderr.on('data', (c) => {
      err += String(c)
    })
    child.on('error', rejectRun)
    child.on('exit', (code) => {
      if (code === 0) resolveRun(out)
      else rejectRun(new Error(err.trim() || `${cmd} exit ${code}`))
    })
  })
}

async function assertNoSymlinks(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = join(dir, e.name)
    const st = await fsp.lstat(full)
    if (st.isSymbolicLink()) {
      const err = new Error('技能包里有软链接：' + e.name)
      err.code = 'BAD_ZIP'
      throw err
    }
    if (st.isDirectory()) await assertNoSymlinks(full)
  }
}

/**
 * 把本机技能库里的一个技能打包成 zip 放进房间。
 * 技能目录必须在 skillRoots() 里，压缩走系统 zip（-X 去掉额外属性）。
 */
async function shareSkill(r, want, from) {
  const fail = (code, message) => {
    const err = new Error(message)
    err.code = code
    return err
  }
  if (r.items.length >= MAX_ITEMS) throw fail('ROOM_FULL', '房间里的东西太多了')
  const skill = pickSkill(await listSkills(), want)
  if (!skill) throw fail('NO_SKILL', '本机技能库里没有这个技能：' + want)

  const tmpDir = join(ROOT, 'tmp')
  await fsp.mkdir(tmpDir, { recursive: true })
  const zipPath = join(tmpDir, `${skill.id}-${randomBytes(5).toString('hex')}.zip`)
  try {
    await runCapture('zip', ['-r', '-q', '-X', zipPath, '.'], { cwd: skill.dir })
    const stat = await fsp.stat(zipPath)
    if (stat.size > MAX_FILE_BYTES) throw fail('TOO_LARGE', '技能包超过 2 GB 上限')
    const filesDir = join(r.dir, 'files')
    await fsp.mkdir(filesDir, { recursive: true })
    const clean = safeName(`${skill.id}.skill.zip`)
    const dest = join(filesDir, `${Date.now().toString(36)}-${clean}`)
    const hasher = makeHasher()
    await pipeline(createReadStream(zipPath), hasher.stream, createWriteStream(dest))
    const item = {
      id: randomBytes(6).toString('hex'),
      kind: 'skill',
      dir: 'to-guests',
      name: clean,
      size: hasher.size,
      sha256: hasher.digest(),
      at: Date.now(),
      path: dest,
      from,
      skill: {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        files: skill.files,
        bytes: skill.bytes,
      },
    }
    r.items.push(item)
    return item
  } finally {
    void fsp.rm(zipPath, { force: true }).catch(() => {})
  }
}

/**
 * 把房间里的技能包装进本机技能库（~/.dsh/skills/<id>）。
 * 只解压到临时目录、校验 SKILL.md 与路径，再整体搬过去；同名不覆盖。
 */
async function installSkill(item) {
  const fail = (code, message) => {
    const err = new Error(message)
    err.code = code
    return err
  }
  if (!item) throw fail('NOT_SKILL', '这不是一个技能包')
  if (!/\.zip$/i.test(String(item.name || item.path || ''))) {
    throw fail('NOT_SKILL', '这不是一个技能包（需要一个 .zip）')
  }
  let entries = []
  try {
    entries = (await runCapture('zipinfo', ['-1', item.path]))
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    throw fail('BAD_ZIP', '技能包读不出来')
  }
  if (!entries.length) throw fail('BAD_ZIP', '技能包是空的')
  for (const name of entries) {
    if (name.startsWith('/') || name.split('/').includes('..')) {
      throw fail('BAD_ZIP', '技能包里有可疑路径：' + name)
    }
  }

  const meta = item.skill || {}
  const skillsRoot = join(homedir(), '.dsh', 'skills')
  const work = join(ROOT, 'tmp', 'install-' + randomBytes(6).toString('hex'))
  await fsp.mkdir(work, { recursive: true })
  try {
    await runCapture('unzip', ['-q', '-o', item.path, '-d', work])
    let doc = ''
    try {
      doc = await fsp.readFile(join(work, 'SKILL.md'), 'utf8')
    } catch {
      throw fail('BAD_SKILL', '技能包里没有 SKILL.md')
    }
    await assertNoSymlinks(work)

    const fromDoc = parseSkillMeta(doc).name || ''
    const guessed = String(item.name || '').replace(/\.zip$/i, '').replace(/[^A-Za-z0-9._-]/g, '-')
    const candidates = [meta.id, fromDoc.replace(/\s+/g, '-'), guessed]
    const id = candidates.find((x) => x && SKILL_ID_RE.test(String(x))) || 'skill'
    const title = fromDoc || meta.name || id
    const target = join(skillsRoot, String(id))
    let exists = true
    try {
      await fsp.stat(target)
    } catch {
      exists = false
    }
    if (exists) throw fail('ALREADY_THERE', `本机已经有同名技能：~/.dsh/skills/${id}`)
    await fsp.mkdir(skillsRoot, { recursive: true })
    await fsp.cp(work, target, { recursive: true })
    return { ok: true, id, title, installedTo: target }
  } finally {
    void fsp.rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

/* ------------------------------------------------------------------ */
/* QR                                                                  */
/* ------------------------------------------------------------------ */

function qrDataUrl(text) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const svg = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true })
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64')
}

/* ------------------------------------------------------------------ */
/* guest server                                                        */
/* ------------------------------------------------------------------ */

async function guestHtml() {
  if (!guestHtmlCache) guestHtmlCache = await fsp.readFile(join(HERE, 'guest.html'), 'utf8')
  return guestHtmlCache
}

function sendClosedPage(res) {
  const html =
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>房间已关闭</title><style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;background:#faf8f4;color:#2a2724;' +
    'display:grid;place-items:center;height:100vh;margin:0}div{text-align:center;padding:24px}h1{font-size:20px;margin:0 0 8px}' +
    'p{color:#7a736c;margin:0}</style><div><h1>这个房间已经关了</h1><p>让主持人重新开一间，再扫一次新的二维码。</p></div>'
  sendHtml(res, html)
}

async function handleGuest(req, res) {
  const r = room
  const u = new URL(req.url || '/', 'http://localhost')
  const seg = u.pathname.split('/').filter(Boolean)

  const remoteOk = !!(r && r.relay && (r.relay.state === 'up' || r.relay.state === 'starting'))
  if (!remoteOk && !isPrivateAddress(req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, error: '仅限局域网访问' })
    return
  }
  if (u.pathname === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'content-length': '0' })
    res.end()
    return
  }

  if (req.method === 'GET' && seg[0] === 'r' && seg.length === 2) {
    if (!r || seg[1] !== r.code) {
      sendClosedPage(res)
      return
    }
    sendHtml(res, await guestHtml())
    return
  }

  if (seg[0] !== 'api' || seg[1] !== 'room' || seg.length < 4) {
    sendJson(res, 404, { ok: false, error: 'not-found' })
    return
  }
  if (!r || seg[2] !== r.code) {
    sendJson(res, 410, { ok: false, error: 'closed', message: '房间已关闭' })
    return
  }
  if (u.searchParams.get('k') !== r.token) {
    sendJson(res, 403, { ok: false, error: 'bad-token' })
    return
  }

  const action = seg[3]

  if (action === 'state' && req.method === 'GET') {
    const gid = u.searchParams.get('g')
    if (gid) touchGuest(r, gid, u.searchParams.get('n'))
    const ps = [...r.participants.values()]
    sendJson(res, 200, {
      ok: true,
      room: {
        code: r.code,
        name: r.name || `邻座 ${r.code}`,
        hostName: r.hostName,
        expiresAt: r.expiresAt,
        serverNow: Date.now(),
        participants: ps.length,
        online: ps.filter((p) => Date.now() - p.lastSeen < ONLINE_WINDOW_MS).length,
      },
      items: r.items
        .slice(-MAX_ITEMS)
        .reverse()
        .map(publicItem),
    })
    return
  }

  if (action === 'join' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req, 8 * 1024)
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad-request' })
      return
    }
    const g = touchGuest(r, body.id, body.name)
    sendJson(res, 200, { ok: true, id: g.id, name: g.name })
    return
  }

  if (action === 'upload' && req.method === 'POST') {
    const g = touchGuest(r, u.searchParams.get('g'), u.searchParams.get('n'))
    try {
      const item = await receiveFile(r, req, {
        name: u.searchParams.get('name') || 'file',
        dir: 'to-host',
        from: g.name,
      })
      sendJson(res, 200, { ok: true, item: publicItem(item) })
    } catch (err) {
      const code = err && err.code
      if (code === 'TOO_LARGE') sendJson(res, 413, { ok: false, error: '文件超过 2 GB 上限' })
      else if (code === 'ROOM_FULL') sendJson(res, 507, { ok: false, error: '房间里的东西太多了' })
      else sendJson(res, 500, { ok: false, error: '上传中断' })
    }
    return
  }

  if (action === 'upload-init' && req.method === 'POST') {
    const g = touchGuest(r, u.searchParams.get('g'), u.searchParams.get('n'))
    let body
    try {
      body = await readJsonBody(req, 8 * 1024)
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad-request' })
      return
    }
    const size = Number(body.size || 0)
    if (!Number.isFinite(size) || size <= 0) {
      sendJson(res, 400, { ok: false, error: '文件大小不对' })
      return
    }
    if (size > MAX_FILE_BYTES) {
      sendJson(res, 413, { ok: false, error: '文件超过 2 GB 上限' })
      return
    }
    if (r.items.length >= MAX_ITEMS) {
      sendJson(res, 507, { ok: false, error: '房间里的东西太多了' })
      return
    }
    const now = Date.now()
    for (const [key, up] of r.uploads) {
      if (now - up.at > 30 * 60_000) {
        r.uploads.delete(key)
        try {
          unlinkSync(up.tmp)
        } catch {
          /* ignore */
        }
      }
    }
    const id = randomBytes(8).toString('hex')
    const clean = safeName(body.name || 'file')
    const tmp = join(r.dir, 'files', `${id}-${clean}.part`)
    r.uploads.set(id, {
      id,
      name: clean,
      size,
      received: 0,
      chunks: 0,
      hash: createHash('sha256'),
      tmp,
      dir: 'to-host',
      from: g.name,
      at: now,
    })
    sendJson(res, 200, { ok: true, uploadId: id, chunkSize: CHUNK_BYTES })
    return
  }

  if (action === 'upload-chunk' && req.method === 'POST') {
    const up = r.uploads.get(u.searchParams.get('up') || '')
    if (!up) {
      sendJson(res, 404, { ok: false, error: '这个上传已经过期' })
      return
    }
    if (Number(u.searchParams.get('i')) !== up.chunks) {
      sendJson(res, 409, { ok: false, error: '分片顺序不对' })
      return
    }
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > CHUNK_BYTES) {
      sendJson(res, 413, { ok: false, error: '分片太大' })
      return
    }
    if (up.received + declared > up.size) {
      sendJson(res, 413, { ok: false, error: '文件比预期大' })
      return
    }
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        up.hash.update(chunk)
        cb(null, chunk)
      },
    })
    try {
      await pipeline(req, meter, createWriteStream(up.tmp, { flags: 'a' }))
    } catch {
      sendJson(res, 500, { ok: false, error: '这一片没传完' })
      return
    }
    up.received += declared
    up.chunks += 1
    up.at = Date.now()
    sendJson(res, 200, { ok: true, received: up.received, chunks: up.chunks })
    return
  }

  if (action === 'upload-finish' && req.method === 'POST') {
    const id = u.searchParams.get('up') || ''
    const up = r.uploads.get(id)
    if (!up) {
      sendJson(res, 404, { ok: false, error: '这个上传已经过期' })
      return
    }
    if (up.received !== up.size) {
      sendJson(res, 400, { ok: false, error: '还差 ' + (up.size - up.received) + ' 字节没传完' })
      return
    }
    const finalPath = join(r.dir, 'files', `${id}-${up.name}`)
    try {
      await fsp.rename(up.tmp, finalPath)
    } catch {
      sendJson(res, 500, { ok: false, error: '保存失败' })
      return
    }
    const item = {
      id,
      kind: 'file',
      dir: up.dir,
      name: up.name,
      size: up.size,
      sha256: up.hash.digest('hex'),
      at: Date.now(),
      path: finalPath,
      from: up.from,
    }
    r.items.push(item)
    r.uploads.delete(id)
    sendJson(res, 200, { ok: true, item: publicItem(item) })
    return
  }

  if (action === 'card' && req.method === 'POST') {
    const g = touchGuest(r, u.searchParams.get('g'), u.searchParams.get('n'))
    let body
    try {
      body = await readJsonBody(req, 64 * 1024)
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad-request' })
      return
    }
    try {
      const item = addCard(r, body, { dir: 'to-host', from: g.name })
      sendJson(res, 200, { ok: true, item: publicItem(item) })
    } catch (err) {
      if (err && err.code === 'EMPTY_CARD') sendJson(res, 400, { ok: false, error: '卡片内容是空的' })
      else sendJson(res, 507, { ok: false, error: '房间里的东西太多了' })
    }
    return
  }

  if (action === 'note' && req.method === 'POST') {
    const g = touchGuest(r, u.searchParams.get('g'), u.searchParams.get('n'))
    let body
    try {
      body = await readJsonBody(req, 16 * 1024)
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad-request' })
      return
    }
    try {
      const item = addNote(r, body.text, g.name)
      sendJson(res, 200, { ok: true, item: publicItem(item) })
    } catch (err) {
      if (err && err.code === 'EMPTY_NOTE') sendJson(res, 400, { ok: false, error: '说点什么吧' })
      else sendJson(res, 507, { ok: false, error: '房间里的东西太多了' })
    }
    return
  }

  if (action === 'item' && req.method === 'GET' && seg[4]) {
    const item = r.items.find((i) => i.id === seg[4])
    if (!item) {
      sendJson(res, 404, { ok: false, error: 'not-found' })
      return
    }
    sendJson(res, 200, {
      ok: true,
      item: publicItem(item),
      card: item.card || null,
      text: item.kind === 'note' ? item.text : null,
    })
    return
  }

  if (action === 'download' && req.method === 'GET' && seg[4]) {
    const item = r.items.find((i) => i.id === seg[4])
    if (!item || (item.kind !== 'file' && item.kind !== 'skill') || !item.path) {
      sendJson(res, 404, { ok: false, error: 'not-found' })
      return
    }
    streamFile(res, item.path, item.name)
    return
  }

  sendJson(res, 404, { ok: false, error: 'not-found' })
}

function streamFile(res, path, name) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    sendJson(res, 404, { ok: false, error: 'missing-file' })
    return
  }
  if (res.headersSent) return
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': stat.size,
    'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name || 'file')}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  readStream(res, path)
}

function readStream(res, path) {
  const stream = createReadStream(path)
  stream.on('error', () => {
    try {
      res.destroy()
    } catch {
      /* ignore */
    }
  })
  stream.pipe(res)
}

/* ------------------------------------------------------------------ */
/* host routes (harness web server, same origin as the panel)          */
/* ------------------------------------------------------------------ */

function hostHeaderOk(req) {
  return req.headers['x-dsh-nearby'] === '1'
}

/**
 * Ask the composition's own trust fence before touching anything.
 *
 * `webServer.register` hands out a route with no caller check, so any local
 * process — or a cross-site request from a page the user happens to have open —
 * could drive it. `connection.requestRejection` is the check DSH already runs
 * for its own API: its Host/Origin fence defeats DNS rebinding and cross-site
 * calls, and its browser authentication covers the login token. It answers
 * 401/403, or undefined for a request it would admit.
 *
 * Hosts older than that service simply do not publish it, and then every route
 * behaves exactly as before — the caller header below stays as a second,
 * cheap fence for the mutating endpoints.
 *
 * @returns true when the request was refused and the response is already owned.
 */
function hostRejection(ctx, req, res) {
  let connection
  try {
    connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  } catch {
    return false
  }
  const gate = connection && connection.requestRejection
  if (typeof gate !== 'function') return false
  let rejection
  try {
    rejection = gate.call(connection, req)
  } catch {
    return false
  }
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

async function hostState(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  sendJson(res, 200, {
    ok: true,
    room: roomSnapshot(),
    defaultHostName: defaultHostName(),
    root: ROOT,
    maxFileBytes: MAX_FILE_BYTES,
  })
}

async function hostQr(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!room) {
    sendJson(res, 404, { ok: false, error: 'no-room' })
    return
  }
  if (!room.qrCache) {
    try {
      room.qrCache = qrDataUrl(room.joinUrl)
    } catch {
      sendJson(res, 500, { ok: false, error: 'qr-failed' })
      return
    }
  }
  sendJson(res, 200, { ok: true, code: room.code, dataUrl: room.qrCache })
}

async function hostOpen(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!hostHeaderOk(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  let body = {}
  try {
    body = await readJsonBody(req, 8 * 1024)
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad-request' })
    return
  }
  try {
    await openRoom({ hostName: body.hostName, name: body.name, minutes: body.minutes, relay: body.relay === true })
    sendJson(res, 200, { ok: true, room: roomSnapshot() })
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: 'open-failed',
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}

async function hostRelay(req, res) {
  if (!hostHeaderOk(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  sendJson(res, 200, relaySnapshot())
}

async function hostClose(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!hostHeaderOk(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  await closeRoom('host')
  sendJson(res, 200, { ok: true })
}

async function hostShare(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!hostHeaderOk(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  if (!room) {
    sendJson(res, 409, { ok: false, error: 'no-room' })
    return
  }
  const u = new URL(req.url || '/', 'http://127.0.0.1')
  const name = u.searchParams.get('name') || 'file'
  try {
    const item = await receiveFile(room, req, { name, dir: 'to-guests', from: room.hostName })
    sendJson(res, 200, { ok: true, item: publicItem(item) })
  } catch (err) {
    const code = err && err.code
    if (code === 'TOO_LARGE') sendJson(res, 413, { ok: false, error: '文件超过 2 GB 上限' })
    else if (code === 'ROOM_FULL') sendJson(res, 507, { ok: false, error: '房间满了' })
    else sendJson(res, 500, { ok: false, error: 'share-failed' })
  }
}

async function hostShareCard(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!hostHeaderOk(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  if (!room) {
    sendJson(res, 409, { ok: false, error: 'no-room' })
    return
  }
  let body
  try {
    body = await readJsonBody(req, 64 * 1024)
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad-request' })
    return
  }
  try {
    const item = addCard(
      room,
      { ...body, author: room.hostName },
      { dir: 'to-guests', from: room.hostName },
    )
    sendJson(res, 200, { ok: true, item: publicItem(item) })
  } catch (err) {
    if (err && err.code === 'EMPTY_CARD') sendJson(res, 400, { ok: false, error: '卡片内容是空的' })
    else sendJson(res, 507, { ok: false, error: '房间满了' })
  }
}

async function hostNearby(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!hostHeaderOk(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  sendJson(res, 200, nearbySnapshot())
}

async function hostNote(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!hostHeaderOk(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  if (!room) {
    sendJson(res, 409, { ok: false, error: 'no-room' })
    return
  }
  let body = {}
  try {
    body = await readJsonBody(req, 16 * 1024)
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad-request' })
    return
  }
  try {
    const item = addNote(room, body.text, room.hostName)
    sendJson(res, 200, { ok: true, item: publicItem(item) })
  } catch (err) {
    if (err && err.code === 'EMPTY_NOTE') sendJson(res, 400, { ok: false, error: '说点什么吧' })
    else sendJson(res, 507, { ok: false, error: '房间满了' })
  }
}

async function hostSkills(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!hostHeaderOk(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  try {
    const skills = await listSkills()
    sendJson(res, 200, {
      ok: true,
      count: skills.length,
      skills: skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse,
        files: s.files,
        bytes: s.bytes,
      })),
    })
  } catch {
    sendJson(res, 500, { ok: false, error: 'skills-failed' })
  }
}

async function hostShareSkill(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!hostHeaderOk(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  if (!room) {
    sendJson(res, 409, { ok: false, error: 'no-room' })
    return
  }
  let body
  try {
    body = await readJsonBody(req, 16 * 1024)
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad-request' })
    return
  }
  try {
    const item = await shareSkill(room, body.name, room.hostName)
    sendJson(res, 200, { ok: true, item: publicItem(item) })
  } catch (err) {
    const code = err && err.code
    if (code === 'NO_SKILL') sendJson(res, 404, { ok: false, error: err.message })
    else if (code === 'ROOM_FULL') sendJson(res, 507, { ok: false, error: '房间里的东西太多了' })
    else if (code === 'TOO_LARGE') sendJson(res, 413, { ok: false, error: err.message })
    else sendJson(res, 500, { ok: false, error: '打包技能时出错了' })
  }
}

async function hostInstallSkill(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!hostHeaderOk(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  if (!room) {
    sendJson(res, 409, { ok: false, error: 'no-room' })
    return
  }
  let body
  try {
    body = await readJsonBody(req, 16 * 1024)
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad-request' })
    return
  }
  const item = room.items.find(
    (it) => it.id === body.id && (it.kind === 'skill' || /\.zip$/i.test(String(it.name || ''))),
  )
  if (!item) {
    sendJson(res, 404, { ok: false, error: '房间里没有这个技能包' })
    return
  }
  try {
    const out = await installSkill(item)
    sendJson(res, 200, { ok: true, ...out })
  } catch (err) {
    const code = err && err.code
    if (code === 'ALREADY_THERE') sendJson(res, 409, { ok: false, error: err.message })
    else if (code === 'BAD_ZIP' || code === 'BAD_SKILL' || code === 'NOT_SKILL')
      sendJson(res, 400, { ok: false, error: err.message })
    else sendJson(res, 500, { ok: false, error: '安装技能时出错了' })
  }
}

async function hostImport(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!hostHeaderOk(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  if (!room) {
    sendJson(res, 409, { ok: false, error: 'no-room' })
    return
  }
  let body = {}
  try {
    body = await readJsonBody(req, 8 * 1024)
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad-request' })
    return
  }
  const item = room.items.find((i) => i.id === body.id)
  if (!item || item.kind !== 'card') {
    sendJson(res, 404, { ok: false, error: 'not-found' })
    return
  }
  try {
    const result = await importCard(item, room.code)
    sendJson(res, 200, result)
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: 'import-failed',
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}

async function hostFile(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  const u = new URL(req.url || '/', 'http://127.0.0.1')
  const id = u.searchParams.get('id')
  if (!room || !id) {
    sendJson(res, 404, { ok: false, error: 'not-found' })
    return
  }
  const item = room.items.find((i) => i.id === id)
  if (!item || item.kind !== 'file' || !item.path) {
    sendJson(res, 404, { ok: false, error: 'not-found' })
    return
  }
  streamFile(res, item.path, item.name)
}

/* ------------------------------------------------------------------ */
/* agent tools                                                         */
/* ------------------------------------------------------------------ */

const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
}

function peersText() {
  const snap = nearbySnapshot()
  const list = snap.peers || []
  if (!list.length) return '附近还没有别的邻座。让对方也开着邻座面板，几秒后就会出现。'
  return (
    '附近 ' +
    list.length +
    ' 个邻座：\n' +
    list
      .map((p) => {
        const who = (p.name || p.host || '邻居') + (p.host && p.name !== p.host ? '（' + p.host + '）' : '')
        return p.room
          ? `· ${who} 开着房 ${p.room.code}${p.room.name ? '「' + p.room.name + '」' : ''} → ${p.room.joinUrl}`
          : `· ${who} 还没开房`
      })
      .join('\n')
  )
}

function roomSummaryText(s) {
  const left = Math.max(0, Math.round((s.expiresAt - Date.now()) / 60000))
  const lines = [
    `房间 ${s.code} 开着 · 主持人 ${s.hostName}${s.name ? ' · ' + s.name : ''}`,
    s.joinUrl,
    `${s.onlineCount} 人在线 · ${s.itemCount} 件东西 · 还剩 ${left} 分钟`,
  ]
  return lines.join('\n')
}

function describeItem(it) {
  const who = it.from || '访客'
  if (it.kind === 'note') {
    return `[留言 · ${who}] ${String(it.text || '')
      .replace(/\n/g, ' ')
      .slice(0, 240)}`
  }
  if (it.kind === 'card') {
    const card = it.card || {}
    return `[卡片 · ${who}] ${card.title || '未命名'}\n${String(card.body || '').slice(0, 400)}`
  }
  if (it.kind === 'skill') {
    const sk = it.skill || {}
    return `[技能 · ${who}] ${sk.name || it.name}（${sk.files || 0} 个文件）\n${String(sk.description || '').slice(0, 240)}\n技能包 ${it.path}`
  }
  return `[文件 · ${who}] ${it.name}（${fmtBytes(it.size)}）\n本地路径 ${it.path}\nsha256 ${String(it.sha256 || '').slice(0, 16)}`
}

function buildTools() {
  return [
    {
      name: 'nearby_room',
      description:
        '邻座（NextSeat）房间：同一 Wi-Fi 下的临时交换空间，别人用手机浏览器打开链接就能加入，不用装任何东西，数据不出局域网。action=status 看当前房间（码、链接、在线人数、收件数）和附近开着邻座的人；action=open 开一间（默认 120 分钟）；action=close 关房。同一时间只有一间房。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'open', 'close'],
            description: 'status 看状态；open 开房；close 关房',
          },
          name: { type: 'string', description: '房间名，比如「周三分享会」，可选' },
          minutes: { type: 'number', description: '房间存活分钟数，5-480，默认 120' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: TOOL_OUTPUT,
      async execute(args) {
        const action = String((args && args.action) || 'status')
        if (action === 'open') {
          try {
            await openRoom({ hostName: defaultHostName(), name: args.name, minutes: args.minutes })
          } catch (err) {
            return { text: '开房失败：' + (err instanceof Error ? err.message : String(err)) }
          }
          return {
            text: roomSummaryText(roomSnapshot()) + '\n把链接或二维码给对方，就能开始收了。',
          }
        }
        if (action === 'close') {
          if (!room) return { text: '现在没有开着的房间。' }
          await closeRoom('tool')
          return { text: '房间已关，链接在 60 秒内失效。' }
        }
        if (!room) {
          return { text: '现在没有开着的房间。要开一间用 nearby_room(action="open")。\n\n' + peersText() }
        }
        return { text: roomSummaryText(roomSnapshot()) + '\n\n' + peersText() }
      },
    },
    {
      name: 'nearby_share',
      description:
        '往当前邻座房间里放东西，房间里所有人（手机浏览器）立刻能看到：kind=note 发一句话（text）；kind=card 放一张提示词卡片（title/tags/body）；kind=file 把本机一个文件放进房间（path）；kind=skill 把本机技能库里的一个技能打包放进房间（skill 传技能目录名或 name）。没有开房时先用 nearby_room 开一间。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['note', 'card', 'file', 'skill'] },
          text: { type: 'string', description: 'note 的正文，最多 2000 字' },
          title: { type: 'string', description: 'card 的标题' },
          tags: { type: 'string', description: 'card 的标签，用空格或逗号分开' },
          body: { type: 'string', description: 'card 的正文（提示词原文）' },
          path: { type: 'string', description: 'file 的本地路径，支持 ~/... 或绝对路径' },
          skill: { type: 'string', description: 'skill 的技能目录名或 name，比如 wechat-windows-viewer' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      output: TOOL_OUTPUT,
      async execute(args) {
        if (!room) return { text: '现在没有开着的房间，先用 nearby_room(action="open") 开一间。' }
        const kind = String((args && args.kind) || '')
        try {
          if (kind === 'note') {
            const item = addNote(room, args.text, room.hostName)
            return { text: `已发到房间：${item.text.slice(0, 120)}` }
          }
          if (kind === 'card') {
            const item = addCard(
              room,
              { title: args.title, tags: args.tags, body: args.body, author: room.hostName },
              { dir: 'to-guests', from: room.hostName },
            )
            return { text: `卡片「${item.card.title}」已放进房间（${item.card.body.length} 字）。` }
          }
          if (kind === 'file') {
            const item = await shareLocalFile(room, args.path, room.hostName)
            return {
              text: `文件已放进房间：${item.name}（${fmtBytes(item.size)}），sha256 ${item.sha256.slice(0, 16)}。`,
            }
          }
          if (kind === 'skill') {
            const item = await shareSkill(room, args.skill || args.path || args.text, room.hostName)
            return {
              text: `技能包已放进房间：${item.skill.name}（${item.skill.files} 个文件，${fmtBytes(item.size)}）。别人下载后在 DSH 里解压到 ~/.dsh/skills/ 就能用。`,
            }
          }
          return { text: 'kind 只能是 note / card / file / skill。' }
        } catch (err) {
          return { text: '没放进去：' + (err instanceof Error ? err.message : String(err)) }
        }
      },
    },
    {
      name: 'nearby_inbox',
      description:
        '看当前邻座房间里最近的东西：访客递上来的文件（含本机落盘路径）、提示词卡片正文、留言。用来「看看刚刚谁发了什么」。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: '最多几条，默认 15，上限 40' } },
        required: [],
        additionalProperties: false,
      },
      output: TOOL_OUTPUT,
      async execute(args) {
        if (!room) return { text: '现在没有开着的房间。' }
        const n = Math.min(Math.max(Math.round(Number(args && args.limit) || 15), 1), 40)
        const items = room.items.slice(-n).reverse()
        if (!items.length) return { text: `房间 ${room.code} 里还没有东西。` }
        return {
          text: `房间 ${room.code} 最近 ${items.length} 件：\n\n` + items.map(describeItem).join('\n\n'),
        }
      },
    },
  ]
}

export const inject = ['webServer', 'tools']

export function apply(ctx) {
  const routes = [
    ['/dsh-nearby/api/state', hostState],
    ['/dsh-nearby/api/qr', hostQr],
    ['/dsh-nearby/api/open', hostOpen],
    ['/dsh-nearby/api/close', hostClose],
    ['/dsh-nearby/api/relay', hostRelay],
    ['/dsh-nearby/api/share', hostShare],
    ['/dsh-nearby/api/share-card', hostShareCard],
    ['/dsh-nearby/api/note', hostNote],
    ['/dsh-nearby/api/nearby', hostNearby],
    ['/dsh-nearby/api/skills', hostSkills],
    ['/dsh-nearby/api/share-skill', hostShareSkill],
    ['/dsh-nearby/api/install-skill', hostInstallSkill],
    ['/dsh-nearby/api/import', hostImport],
    ['/dsh-nearby/api/file', hostFile],
  ]

  for (const [path, handler] of routes) {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          if (hostRejection(ctx, req, res)) return
          Promise.resolve(handler(req, res)).catch(() => {
            try {
              sendJson(res, 500, { ok: false, error: 'handler-failed' })
            } catch {
              /* ignore */
            }
          })
        },
      }),
    )
  }

  try {
    ctx.inject(['skills'], (skillCtx) => {
      skillsService = skillCtx.skills
    })
  } catch (err) {
    console.warn('[dsh-nearby] skills 服务不可用，技能列表退回目录扫描', err)
  }

  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const def of buildTools()) {
      try {
        ctx.effect(() => ctx.tools.register(def), 'dsh-nearby-tool-' + def.name)
      } catch (err) {
        console.warn('[dsh-nearby] 工具注册失败：' + def.name, err)
      }
    }
  }

  ctx.effect(() => {
    startDiscovery()
    return () => {
      stopDiscovery()
      void closeRoom('dispose', { immediate: true })
      void shutdownAll()
    }
  })
}
