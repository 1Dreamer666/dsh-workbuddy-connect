import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { workBuddyWindowsDiscoveryTools } from '../src/desktop-credential-protection.ts'

type RegistryFailure = Error & { code: number, killed?: boolean }

function registryFailure(stderr: string, killed = false): void {
  execFileMock.mockImplementation((
    _binary: string,
    _args: string[],
    _options: object,
    callback: (error: RegistryFailure, stdout: Buffer, stderr: Buffer) => void,
  ) => {
    const child = new EventEmitter()
    const error = Object.assign(new Error('reg query failed'), { code: 1, killed })
    queueMicrotask(() => {
      callback(error, Buffer.alloc(0), Buffer.from(stderr, 'utf8'))
      child.emit('close')
    })
    return child
  })
}

/**
 * Answer each invocation by binary path: `reg.exe` gets `regBytes`, the
 * fallback interpreter gets `fallback`, so the two paths can be scripted
 * independently. Both receive Buffers, as `encoding: 'buffer'` delivers.
 */
function registryStdout(
  regBytes: Buffer,
  options: {
    fallback?: { stdout?: string, code?: number, fail?: boolean, killed?: boolean }
    onSpawn?: (binary: string, args: string[], execOptions: object) => void
  } = {},
): void {
  execFileMock.mockImplementation((
    binary: string,
    args: string[],
    execOptions: object,
    callback: (error: RegistryFailure | null, stdout: Buffer, stderr: Buffer) => void,
  ) => {
    const child = new EventEmitter()
    options.onSpawn?.(binary, args, execOptions)
    const isFallback = /powershell/iu.test(binary)
    queueMicrotask(() => {
      if (!isFallback) {
        callback(null, regBytes, Buffer.alloc(0))
      } else if (options.fallback?.fail === true) {
        const error = Object.assign(new Error('powershell failed'), {
          code: options.fallback.code ?? 1,
          killed: options.fallback.killed ?? false,
        })
        callback(error, Buffer.alloc(0), Buffer.from('error', 'utf8'))
      } else {
        callback(null, Buffer.from(options.fallback?.stdout ?? '[]', 'utf8'), Buffer.alloc(0))
      }
      child.emit('close')
    })
    return child
  })
}

/** GBK bytes for 人工智能, which is what a zh-CN console emits for that path. */
const GBK_CJK = Buffer.from([0xc8, 0xcb, 0xb9, 0xa4, 0xd6, 0xc7, 0xc4, 0xdc])

afterEach(() => {
  vi.unstubAllEnvs()
  execFileMock.mockReset()
})

describe('Windows registry query failure classification', () => {
  it.each([
    'ERROR: The system was unable to find the specified registry key or value.',
    '错误: 系统找不到指定的注册表项或值。',
  ])('treats a confirmed missing key as an empty result: %s', async stderr => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryFailure(stderr)
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Missing', new AbortController().signal))
      .resolves.toBe('')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['access denied', 'ERROR: Access is denied.', false],
    ['unknown diagnostic', 'ERROR: registry query failed.', false],
    ['killed query', 'ERROR: The system was unable to find the specified registry key or value.', true],
  ])('keeps %s incomplete even when reg.exe returns code 1', async (_label, stderr, killed) => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryFailure(stderr, killed)
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKLM\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/could not complete/)
  })
})

describe('issue #88: fallback triggers on ambiguous bytes only', () => {
  const ASCII_DOCUMENT = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{TEST-0}',
    '    DisplayName    REG_SZ    WorkBuddy',
    '    DisplayIcon    REG_SZ    "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe",0',
  ].join('\r\n')

  it('does not consult the fallback for ASCII-only output', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const spawned: string[] = []
    registryStdout(Buffer.from(ASCII_DOCUMENT, 'ascii'), { onSpawn: binary => { spawned.push(binary) } })
    const output = await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    expect(output).toContain('C:\\Program Files\\WorkBuddy\\WorkBuddy.exe')
    // Exactly one process: no fallback on the overwhelmingly common path.
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatch(/reg\.exe$/u)
  })

  it('consults the fallback when a byte outside ASCII appears', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const spawned: string[] = []
    // GBK bytes: the code page is unknowable from the bytes, so the primary
    // reading is not trusted and the root is re-read through Unicode.
    const ambiguous = Buffer.concat([
      Buffer.from(ASCII_DOCUMENT.replace('C:\\Program Files', 'F:\\').split('F:\\')[0]!, 'ascii'),
      GBK_CJK,
      Buffer.from('\\WorkBuddy\\WorkBuddy.exe",0', 'ascii'),
    ])
    registryStdout(ambiguous, {
      fallback: {
        stdout: JSON.stringify([
          { displayName: 'WorkBuddy', displayIcon: 'F:\\人工智能\\WorkBuddy\\WorkBuddy.exe' },
        ]),
      },
      onSpawn: binary => { spawned.push(binary) },
    })
    const output = await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    expect(output).toContain('F:\\人工智能\\WorkBuddy\\WorkBuddy.exe')
    expect(output).not.toContain('\uFFFD')
    expect(spawned.some(binary => /powershell/iu.test(binary))).toBe(true)
  })

  it('triggers on any non-ASCII byte, including pairs that decode cleanly', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    // 0xC3 0xA9 is the reviewer's counterexample: valid UTF-8 ("é") AND valid
    // GBK ("茅"). A U+FFFD-based trigger would miss it entirely; the byte-range
    // trigger cannot.
    const bytes = Buffer.from([0xc3, 0xa9])
    expect(bytes.toString('utf8')).not.toContain('\uFFFD')
    const spawned: string[] = []
    registryStdout(Buffer.concat([Buffer.from('x', 'ascii'), bytes]), {
      fallback: { stdout: '[]' },
      onSpawn: binary => { spawned.push(binary) },
    })
    const output = await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    expect(output).toBe('')
    expect(spawned.some(binary => /powershell/iu.test(binary))).toBe(true)
  })

  it('does not call the fallback when reg.exe already failed', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryFailure('ERROR: Access is denied.')
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKLM\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/could not complete/)
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('routes the root as an argument, never into the command text', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const calls: { binary: string, args: string[] }[] = []
    registryStdout(Buffer.concat([GBK_CJK]), {
      fallback: { stdout: '[]' },
      onSpawn: (binary, args) => { calls.push({ binary, args }) },
    })
    await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Software\\Uninstall', new AbortController().signal)
    const fallbackCall = calls.find(call => /powershell/iu.test(call.binary))!
    const commandIndex = fallbackCall.args.indexOf('-Command')
    expect(fallbackCall.args[commandIndex + 1]).not.toContain('HKCU')
    expect(fallbackCall.args[fallbackCall.args.indexOf('-Root') + 1]).toBe('HKCU\\Software\\Uninstall')
  })

  it('declares param first and sets the output encoding after it', async () => {
    // Review flagged the ordering: a `param` block must lead the script block,
    // so the encoding assignment cannot precede it. Asserted on the command
    // actually handed to the child, which is the real artifact.
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const calls: { binary: string, args: string[] }[] = []
    registryStdout(Buffer.concat([GBK_CJK]), { fallback: { stdout: '[]' }, onSpawn: (binary, args) => { calls.push({ binary, args }) } })
    await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    const call = calls.find(c => /powershell/iu.test(c.binary))!
    const script = call.args[call.args.indexOf('-Command') + 1]!
    expect(script).toContain('param([string]$Root)')
    expect(script.indexOf('param([string]$Root)')).toBeLessThan(script.indexOf('[Console]::OutputEncoding'))
  })
})

describe('issue #88: fallback failure classification', () => {
  const AMBIGUOUS = Buffer.concat([GBK_CJK])

  it('treats an absent root as an empty result, not a failure', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryStdout(AMBIGUOUS, { fallback: { fail: true, code: 2 } })
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Missing', new AbortController().signal))
      .resolves.toBe('')
  })

  it('keeps an unreadable root incomplete rather than empty', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    // An unopenable subkey could have been a real candidate, so this must not
    // become "no app installed".
    registryStdout(AMBIGUOUS, { fallback: { fail: true, code: 3 } })
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/could not read the registry root/)
  })

  it('keeps other failures incomplete', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryStdout(AMBIGUOUS, { fallback: { fail: true, code: 1 } })
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/could not complete/)
  })

  it('reports a timeout as incomplete', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryStdout(AMBIGUOUS, { fallback: { fail: true, killed: true } })
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/timed out/)
  })

  it('rejects an unrecognised document rather than guessing at it', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryStdout(AMBIGUOUS, { fallback: { stdout: 'not json' } })
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/not the expected registry document/)
  })

  it('accepts a single record, since ConvertTo-Json drops the array wrapper', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryStdout(AMBIGUOUS, {
      fallback: { stdout: JSON.stringify({ displayName: 'WorkBuddy', displayIcon: 'F:\\人工智能\\WorkBuddy\\WorkBuddy.exe' }) },
    })
    const output = await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    expect(output).toContain('DisplayIcon')
    expect(output).toContain('F:\\人工智能\\WorkBuddy\\WorkBuddy.exe')
  })

  it('skips records carrying neither value', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryStdout(AMBIGUOUS, {
      fallback: { stdout: JSON.stringify([{ other: 1 }, { displayName: 'WorkBuddy' }]) },
    })
    const output = await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    expect(output).toContain('DisplayName')
    expect(output).not.toContain('other')
  })

  it('uses PowerShell 5.1-compatible invocation flags', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const calls: { binary: string, args: string[] }[] = []
    registryStdout(AMBIGUOUS, { fallback: { stdout: '[]' }, onSpawn: (binary, args) => { calls.push({ binary, args }) } })
    await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    const call = calls.find(c => /powershell/iu.test(c.binary))!
    expect(call.args).toContain('-NoProfile')
    expect(call.args).toContain('-NonInteractive')
    expect(call.binary).toContain('WindowsPowerShell')
  })
})

describe('issues #105/#106/#107: -Command argument binding on Windows PowerShell 5.1', () => {
  it('hands -Command a call-operator script block so the trailing -Root binds', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const calls: { binary: string, args: string[] }[] = []
    registryStdout(Buffer.concat([GBK_CJK]), { fallback: { stdout: '[]' }, onSpawn: (binary, args) => { calls.push({ binary, args }) } })
    const root = 'HKCU\\Uninstall'
    await workBuddyWindowsDiscoveryTools().queryUninstallRoot(root, new AbortController().signal)
    const call = calls.find(c => /powershell/iu.test(c.binary))!
    const commandIndex = call.args.indexOf('-Command')
    // Windows PowerShell 5.1 joins every argument after -Command into ONE
    // command string and parses that string as code; it does not bind
    // trailing `-Root <path>` tokens to a script whose text merely starts
    // with `param`. The pre-fix argv (a bare `param(...)` script with
    // `-Root <path>` after it) therefore left $Root empty — the trailing
    // tokens landed inside the script text — and every fallback query ended
    // as exit 2/3 (#105/#106/#107). These assertions are made against the
    // joined command the child actually re-parses, so the bare-`param` shape
    // fails them while the call-operator wrapper passes: `& { … }` makes the
    // operator apply `-Root <path>` to the script block's param block, the
    // form #106 verified on a real 5.1 machine.
    const commandText = call.args.slice(commandIndex + 1).join(' ')
    const suffix = ` } -Root ${root}`
    expect(commandText.startsWith('& { ')).toBe(true)
    expect(commandText.endsWith(suffix)).toBe(true)
    expect(commandText).toContain('param([string]$Root)')
    // The root rides only as the -Root value, never inside the script block
    // the call operator executes.
    expect(commandText.slice(0, commandText.length - suffix.length)).not.toContain(root)
  })

  it('keeps exactly one fallback process per root, with no shell in between', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const calls: { binary: string, args: string[] }[] = []
    registryStdout(Buffer.concat([GBK_CJK]), { fallback: { stdout: '[]' }, onSpawn: (binary, args) => { calls.push({ binary, args }) } })
    await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    // The wrapper lives inside the -Command text powershell.exe itself
    // parses: no cmd.exe, no second interpreter, no extra process.
    const fallbackCalls = calls.filter(c => /powershell/iu.test(c.binary))
    expect(fallbackCalls).toHaveLength(1)
    expect(calls.filter(c => /cmd|pwsh/iu.test(c.binary))).toHaveLength(0)
  })

  it('passes the three production roots through to the fallback', async () => {
    // Positive control for the root shape guard: the fixed roots production
    // queries must all reach the fallback, so the guard can never silently
    // disable discovery.
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    for (const root of [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ]) {
      execFileMock.mockReset()
      const calls: { binary: string, args: string[] }[] = []
      registryStdout(Buffer.concat([GBK_CJK]), { fallback: { stdout: '[]' }, onSpawn: (binary, args) => { calls.push({ binary, args }) } })
      await workBuddyWindowsDiscoveryTools().queryUninstallRoot(root, new AbortController().signal)
      const fallbackCalls = calls.filter(c => /powershell/iu.test(c.binary))
      expect(fallbackCalls).toHaveLength(1)
      expect(fallbackCalls[0]!.args[fallbackCalls[0]!.args.indexOf('-Root') + 1]).toBe(root)
    }
  })
})

describe('issues #105/#106/#107: roots are guarded before they reach a command line', () => {
  // `powershell.exe` re-parses everything after -Command as code, so a root
  // is only allowed onto that command line when it is provably inert in that
  // position. Each case below is executable text, a token splitter, or not a
  // registry path at all; all must be refused before any process starts.
  it.each([
    ['statement separator', 'HKCU\\Software; Remove-Item -Recurse C:\\'],
    ['subexpression', 'HKCU\\Software$(Remove-Item -Recurse C:\\)'],
    ['backtick escape', 'HKCU\\Software`Remove-Item'],
    ['double quote', 'HKCU\\Software"'],
    ['single quote', "HKCU\\Software'"],
    ['space splitting a component', 'HKCU\\Software\\Program Files\\Uninstall'],
    ['brace block', 'HKCU\\Software\\{GUID}'],
    ['ampersand chaining', 'HKLM\\Software & whoami'],
    ['not a hive', 'HKXX\\Software'],
    ['hive without a subkey', 'HKLM'],
  ])('refuses %s without starting the fallback', async (_label, root) => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const spawned: string[] = []
    registryStdout(Buffer.concat([GBK_CJK]), { fallback: { stdout: '[]' }, onSpawn: binary => { spawned.push(binary) } })
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot(root, new AbortController().signal))
      .rejects.toThrow(/plain HKLM\/HKCU path this tool may query/)
    // reg.exe already ran (its output was ambiguous); the fallback must not.
    expect(spawned.filter(binary => /powershell/iu.test(binary))).toHaveLength(0)
  })
})
