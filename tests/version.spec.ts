import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { satisfies } from 'semver'
import { describe, expect, it } from 'vitest'
import { WORKBUDDY_CONNECT_VERSION } from '../src/version.ts'

/**
 * Guard the single-source-of-truth version contract:
 * - the build-time define injects package.json's version into src/version.ts;
 * - if that define is ever dropped, version.ts falls back to '0.0.0-dev' and
 *   this test goes red, flagging the regression (and the drift it would cause
 *   in heartbeat / CLI output).
 */
describe('package version sync', () => {
  it('WORKBUDDY_CONNECT_VERSION matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(WORKBUDDY_CONNECT_VERSION).toBe(pkg.version)
  })

  it('never leaks a build-define fallback marker', () => {
    expect(WORKBUDDY_CONNECT_VERSION).not.toBe('0.0.0-dev')
  })

  /**
   * The define reads package.json at BUILD time, so a release that bumps the
   * version after building ships artifacts reporting the old one (issue #1:
   * v0.2.2 bundles said 0.2.1). Skipped on a fresh clone before the first build.
   *
   * The version literal may land in `index.js` or in a shared chunk beside it
   * (rollup decides which, and the chunk's hashed filename changes with the
   * module graph), so every emitted `.js` is scanned rather than one guessed
   * filename. Searching all of them is what keeps this guard meaningful: the
   * assertion is "the shipped artifacts carry this version", not "the bundle
   * was laid out this way".
   */
  it('built lib/ artifacts carry the current version when present', () => {
    const libDir = new URL('../lib/', import.meta.url)
    if (!existsSync(libDir)) return
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const bundles = readdirSync(libDir).filter(name => name.endsWith('.js'))
    expect(bundles.length, 'no built bundles in lib/ — run the build before this test').toBeGreaterThan(0)
    const declaring = bundles.filter(bundle =>
      readFileSync(new URL(`../lib/${bundle}`, import.meta.url), 'utf8')
        .includes(`WORKBUDDY_CONNECT_VERSION = "${pkg.version}"`),
    )
    expect(
      declaring,
      `no built bundle declares WORKBUDDY_CONNECT_VERSION as "${pkg.version}" — rebuild before committing or publishing`,
    ).not.toHaveLength(0)
  })

  it('built bundles need no runtime import of the atomic-write helper', () => {
    const libDir = new URL('../lib/', import.meta.url)
    if (!existsSync(libDir)) return
    for (const name of readdirSync(libDir).filter(name => name.endsWith('.js'))) {
      const source = readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8')
      expect(source, `${name} still requires the host atomic-write package`)
        .not.toMatch(/(?:from\s*|import\s*\(|require\s*\()\s*['"]@deepseek-ai\/dsh-atomic-write['"]/)
    }
  })
})

describe('peer manifest pins the verified DSH cores', () => {
  /**
   * #69's lesson: a caret on a prerelease arm (`^0.2.0-rc.1`) silently
   * admits every later rc of the same tuple — semver auto-extends support
   * nobody verified. Since 0.7.0 the seven DSH service peers are pinned to
   * exactly the cores this release was smoke-tested on; extending support
   * means editing this list after a real run, not letting a caret do it.
   * Since 0.7.7 the list was 0.2.1-rc.1 alone: 0.2.0-rc.2 cannot be
   * smoke-tested anymore alongside it, and an untested arm is support
   * nobody verified. This candidate targets 0.2.1-rc.3 and bundles the
   * official atomic-write helper. Local checks do not replace Desktop
   * acceptance testing.
   *
   * These peers are now the *build* pin, not the install gate: `engines.dsh`
   * is present, and `evaluatePluginCompatibility` in `@deepseek-ai/dsh-app-boot`
   * lets it decide alone — every `@deepseek-ai/dsh-*` peer is then skipped.
   * The exact pins stay because they are what this tree compiles and tests
   * against; widening them would compile against an API nobody has run.
   *
   * #74's lesson on top of it: pi-ai must NOT be a dual-arm range. An
   * in-place upgrade from a 0.6.x-era pnpm profile keeps satisfying
   * `^0.85.1 || ^0.87.1` with the old 0.85.1 install, reproducing #69's
   * two-generation mixing against an rc.2 host that ships 0.87.1.
   *
   * #92 extended that lesson one step further: even the caret-free `^0.87.1`
   * peer range was not enough, because a peer is only a claim about what the
   * *installer* should provide. pi-ai is therefore a pinned regular
   * dependency now; the assertion below pins that shape.
   */
  const DSH_SERVICE_PEERS = [
    '@deepseek-ai/dsh-attachment',
    '@deepseek-ai/dsh-home-paths',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-llm-pi-ai',
    '@deepseek-ai/dsh-settings',
  ] as const

  it('each DSH service peer is an exact, caret-free list of verified cores', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { peerDependencies: Record<string, string> }
    for (const name of DSH_SERVICE_PEERS) {
      expect(pkg.peerDependencies[name], `${name} missing from peerDependencies`).toBe('0.2.1-rc.3')
    }
  })

  /**
   * `engines.dsh` is the install gate; the peers above are the build pin.
   *
   * Pinning six peers to one exact rc is what made 0.8.1 refuse to install the
   * moment Desktop shipped the next core: `evaluatePluginCompatibility` in
   * `@deepseek-ai/dsh-app-boot` checks every `@deepseek-ai/dsh-*` peer against
   * the running version when no `engines.dsh` is declared, so `"0.2.1-rc.3"`
   * fails against `0.2.1-rc.4` and `dsh plugin add` aborts with
   * `installation rejected`. That turns every core bump into a hard outage for
   * users whose only mistake was upgrading the app.
   *
   * Declaring `engines.dsh` fixes that structurally: app-boot lets it decide
   * *alone* and skips the peers entirely, so the range below is the only thing
   * a future host has to satisfy. The floor is the core this release was
   * actually smoke-tested on; the ceiling is the next minor, because a minor
   * bump is where DSH has historically changed the service APIs this plugin
   * calls — claiming support there would be support nobody verified.
   *
   * The `<0.3.0-0` upper bound is not decoration. app-boot matches with
   * `{ includePrerelease: true }`, under which a plain `<0.3.0` also admits
   * `0.3.0-rc.1` — a prerelease of the very line this range means to exclude.
   * The `-0` sentinel is the lowest possible `0.3.0` prerelease, so it closes
   * that hole exactly and keeps `0.2.1-rc.2` out at the bottom too.
   */
  it('declares a forward-compatible engines.dsh instead of gating on exact peers', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { engines?: Record<string, string> }
    expect(
      pkg.engines?.dsh,
      'engines.dsh must be present: without it every DSH peer becomes an exact install gate again',
    ).toBe('>=0.2.1-rc.3 <0.3.0-0')
  })

  it('engines.dsh admits the verified core and every later 0.2.x, and nothing else', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { engines: Record<string, string> }
    // `noUncheckedIndexedAccess` types this as `string | undefined`; the guard
    // narrows it and fails with a readable message instead of a TypeError.
    const range = pkg.engines.dsh
    expect(range, 'engines.dsh must be a string').toBeTypeOf('string')
    if (range === undefined) return

    // The option app-boot passes. Dropping it here would let this test pass
    // with a range that behaves differently inside the host.
    const admits = (version: string): boolean => satisfies(version, range, { includePrerelease: true })

    // The core this release ships against, plus the rest of its line: a
    // patch-level rc bump must never require a plugin release.
    expect(admits('0.2.1-rc.3'), 'the verified core must be admitted').toBe(true)
    expect(admits('0.2.1-rc.4'), 'a later rc of the same core must be admitted').toBe(true)
    expect(admits('0.2.1'), 'the stable release of the verified core must be admitted').toBe(true)
    expect(admits('0.2.2-rc.1'), 'a later patch line must be admitted').toBe(true)
    expect(admits('0.2.9'), 'the end of the 0.2 line must be admitted').toBe(true)

    // Older cores are a different story: this tree does not compile against
    // them, so the gate must keep saying no rather than silently loading.
    expect(admits('0.2.1-rc.2'), '0.2.1-rc.2 was not verified for this build').toBe(false)
    expect(admits('0.2.0-rc.2'), '0.2.0-rc.2 was not verified for this build').toBe(false)

    // The ceiling, including the prerelease trap the `-0` sentinel closes.
    expect(admits('0.3.0-rc.1'), 'the next minor line must not be admitted by its prereleases').toBe(false)
    expect(admits('0.3.0'), 'the next minor line must not be admitted').toBe(false)
    expect(admits('1.0.0'), 'a future major must not be admitted').toBe(false)
  })

  it('a declared engines.dsh makes the exact peers stop gating the install', () => {
    // Reproduce app-boot's own precedence rule rather than trusting the docs:
    // with `engines.dsh` present, `unmetRequirements` returns early and never
    // reads `peerDependencies`. If this ever changes upstream, the forward
    // compatibility this release claims would silently evaporate, so pin it.
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { engines: Record<string, string>, peerDependencies: Record<string, string> }

    const peerGate = Object.entries(pkg.peerDependencies)
      .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
      .filter(([, peerRange]) => !satisfies('0.2.1-rc.4', peerRange, { includePrerelease: true }))

    // The exact pins genuinely would reject a newer rc — that is the whole
    // point of the assertion below: engines.dsh is what rescues the install.
    expect(peerGate.length, 'the exact peers are expected to reject a newer core').toBeGreaterThan(0)
    const range = pkg.engines.dsh
    expect(range, 'engines.dsh must be a string').toBeTypeOf('string')
    if (range === undefined) return
    expect(
      satisfies('0.2.1-rc.4', range, { includePrerelease: true }),
      'engines.dsh must admit the newer core the peers reject, or the install still fails',
    ).toBe(true)
  })

  it('bundles the official atomic-write helper instead of requiring a host peer', () => {
    // The Desktop report could not resolve this peer. Keep the official
    // implementation and include it in lib so runtime resolution is unnecessary.
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { peerDependencies: Record<string, string>, devDependencies: Record<string, string> }
    expect(pkg.devDependencies['@deepseek-ai/dsh-atomic-write']).toBe('0.2.1-rc.3')
    expect(pkg.peerDependencies['@deepseek-ai/dsh-atomic-write']).toBeUndefined()
  })

  it('pi-ai is a pinned runtime dependency, not a peer', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    // #92's lesson, on top of #74's: a peer declaration cannot survive a
    // hoisted profile. With `nodeLinker: hoisted` and `autoInstallPeers:
    // false`, no install claims our peer, so a co-installed plugin's older
    // pi-ai at the profile root wins bare-specifier resolution and the plugin
    // loads the wrong generation. A regular dependency installs beside the
    // plugin and resolves first, whatever the profile root holds.
    expect(pkg.dependencies?.['@earendil-works/pi-ai']).toBe('1.3.0')
    expect(
      pkg.peerDependencies['@earendil-works/pi-ai'],
      'pi-ai must not also be a peer: a peer declaration is what allowed the hoisted copy to win',
    ).toBeUndefined()
    // The dev entry keeps local builds and tests on the same generation, and
    // stays exact so no caret can widen the supported set by itself.
    expect(pkg.devDependencies['@earendil-works/pi-ai']).toBe('1.3.0')
  })
})
