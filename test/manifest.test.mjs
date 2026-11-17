import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The manifest is a submission surface, not just metadata.
 *
 * The plugin catalog fetches `package.json` from the repository and turns away
 * entries that cannot be installed, and DSH itself reads the `@deepseek-ai/dsh-*`
 * peers to decide whether the harness may load this plugin at all. Both rules
 * are easy to break while editing an unrelated field, so they are pinned here.
 */
const root = new URL('../', import.meta.url)
const read = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'))

test('declares the bundle manifest that makes it installable', () => {
  const manifest = read('package.json')
  const patch = manifest.dsh?.bundle?.patch
  // `dsh.client` alone is not installable — it is the most common reason a
  // catalog submission is sent back.
  assert.equal(typeof patch, 'string', 'dsh.bundle.patch is required')
  assert.ok(existsSync(new URL(patch.replace(/^\.\//u, ''), root)), `${patch} must exist`)
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch must ship in the package')
  assert.equal(manifest.dsh.client?.platform, 'web')
})

test('claims exactly the harness line it was verified on', () => {
  const manifest = read('package.json')
  const peers = Object.entries(manifest.peerDependencies ?? {}).filter(
    ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
  )
  assert.ok(peers.length > 0, 'a @deepseek-ai/dsh-* peer is what lets dsh refuse an incompatible host')
  for (const [name, range] of peers) {
    assert.equal(typeof range, 'string')
    assert.notEqual(range.trim(), '')
    // node-semver only admits a prerelease when some comparator shares its
    // exact major.minor.patch tuple and carries a prerelease tag itself, so a
    // range claiming the 0.2 line has to spell that branch out.
    assert.match(range, /-rc\.|-0\b/u, `${name} must name its prerelease branch explicitly`)
  }
})

test('lists curated screenshots that exist inside the repository', () => {
  const screenshots = read('screenshots.json')
  assert.ok(Array.isArray(screenshots), 'screenshots.json is a plain array of paths')
  assert.ok(screenshots.length >= 1 && screenshots.length <= 8, 'the catalog accepts 1-8 images')
  for (const shot of screenshots) {
    assert.ok(!shot.startsWith('/') && !shot.includes('..'), `${shot} must stay inside the repository`)
    assert.ok(existsSync(new URL(shot, root)), `${shot} is missing`)
    assert.ok(/\.(png|jpe?g|webp)$/iu.test(shot), `${shot} must be a png/jpeg/webp image`)
  }
})

test('keeps every host route behind the connection trust fence', () => {
  // `webServer.register` alone hands out a route with no caller check: any
  // local process, or a cross-site request from a page the user has open, could
  // drive it. Dropping the fence during a refactor would not fail any other
  // test, so the wiring is pinned as a contract.
  const source = readFileSync(new URL('index.js', root), 'utf8')
  assert.match(source, /connection\b/u, 'the host half must consult the connection service')
  assert.match(source, /requestRejection/u, 'the host half must ask requestRejection')
  const registered = source.match(/ctx\.webServer\.register\(/gu) ?? []
  assert.ok(registered.length > 0, 'the plugin registers host routes')
  assert.match(
    source,
    /if \(hostRejection\(ctx, req, res\)\) return/u,
    'every registered route must return early when the fence refuses the call',
  )
})

test('keeps the guest page and the locale metadata in the package', () => {
  const manifest = read('package.json')
  for (const required of ['guest.html', 'client.js', 'index.js', 'icon.svg']) {
    assert.ok(manifest.files.includes(required), `${required} must ship in the package`)
  }
  for (const file of ['locale/zh.json', 'locale/en.json']) {
    const locale = read(file)
    assert.equal(typeof locale.meta?.title, 'string', `${file} needs meta.title`)
    assert.equal(typeof locale.meta?.description, 'string', `${file} needs meta.description`)
  }
})
