/**
 * Issue #201 second half: the CN catalog is the union of two documents.
 *
 * On 2026-10-21 the picker lost 15 of 20 CN ids. The chat endpoint kept
 * serving every one of them (each answered 200 with a normal SSE stream), so
 * this was a catalog-source defect: `/v3/config` stopped serving a `cli` agent
 * to App-shaped clients, and its flat `models` list carries mostly
 * completion-specialised rows (`hunyuan-3b`, `codewise-*`) rather than chat
 * models, leaving `parseModelCatalog` no roster to intersect.
 *
 * The desktop App's own selector reads `/v2/enterprises/personal/models`, which
 * still carries that agent. The two rosters are not subsets of one another —
 * measured 2026-10-22, the console document lists `auto` and the product one
 * lists `hy3-x` and `minimax-m2.7` — so both are read and unioned.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

const CREDENTIAL = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: 0,
  domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'desktop',
} as const

/** A document shaped like the console one, carrying `ids` on its `cli` agent. */
const docWith = (ids: readonly string[]): string => JSON.stringify({
  code: 0,
  msg: 'ok',
  data: {
    models: ids.map(id => ({
      id, name: id, maxInputTokens: 100_000, maxOutputTokens: 32_000,
      supportsReasoning: true, onlyReasoning: true, credits: 'x0.11 credits',
    })),
    agents: [{ name: 'cli', models: [...ids] }],
  },
})

const response = (body: string, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  }) as unknown as Response

const isConsole = (url: string): boolean => url.includes('/personal/models') && !url.includes('/console/')
const isConfig = (url: string): boolean => url.includes('/v3/config')

/**
 * Stub fetch, answering each catalog route through `handlers` and counting the
 * calls that reached each one.
 */
function stubRoutes(handlers: {
  console?: () => Response | Promise<Response>
  config?: () => Response | Promise<Response>
}) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const target = String(url)
    // The badge read hits the console *path* but is not the roster read; it
    // must never decide the outcome, so it always answers empty here.
    if (target.includes('/console/enterprises/personal/models')) return response(docWith([]))
    if (isConsole(target)) {
      calls.push('console')
      return handlers.console ? await handlers.console() : response(docWith([]))
    }
    if (isConfig(target)) {
      calls.push('config')
      return handlers.config ? await handlers.config() : response(docWith([]))
    }
    calls.push('other')
    return response('{}')
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CN catalog: two sources, unioned', () => {
  it('unions the console and product rosters into one catalog', async () => {
    stubRoutes({
      // The measured split: `auto` only in console, `hy3-x` only in /v3/config.
      console: () => response(docWith(['auto', 'hy3', 'deepseek-v4.1-flash'])),
      config: () => response(docWith(['hy3', 'hy3-x', 'minimax-m2.7'])),
    })
    const client = new WorkBuddyUpstreamClient()
    const models = await client.fetchModels(CREDENTIAL)
    expect(models.map(model => model.id)).toEqual([
      'auto', 'hy3', 'deepseek-v4.1-flash', 'hy3-x', 'minimax-m2.7',
    ])
    expect(client.lastCatalog?.source).toBe('workbuddy:cli+console')
  })

  it('reads the console document first, so its order and metadata win', async () => {
    stubRoutes({
      console: () => response(docWith(['b', 'a'])),
      config: () => response(docWith(['a', 'c'])),
    })
    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    expect(models.map(model => model.id)).toEqual(['b', 'a', 'c'])
  })

  it('degrades to the product document when the console route fails', async () => {
    stubRoutes({
      console: () => response('upstream down', false, 503),
      config: () => response(docWith(['hy3', 'hy3-x'])),
    })
    const client = new WorkBuddyUpstreamClient()
    const models = await client.fetchModels(CREDENTIAL)
    // The regression that started this: a model only the product document
    // lists must still survive a console outage.
    expect(models.map(model => model.id)).toEqual(['hy3', 'hy3-x'])
    expect(client.lastCatalog?.source).toBe('workbuddy:cli')
  })

  it('degrades to the console document when the product route fails', async () => {
    stubRoutes({
      console: () => response(docWith(['auto', 'deepseek-v4.1-flash'])),
      config: () => response('upstream down', false, 503),
    })
    const client = new WorkBuddyUpstreamClient()
    const models = await client.fetchModels(CREDENTIAL)
    expect(models.map(model => model.id)).toEqual(['auto', 'deepseek-v4.1-flash'])
    expect(client.lastCatalog?.source).toBe('workbuddy:console')
  })

  it('survives a transport error on either route', async () => {
    stubRoutes({
      console: () => { throw new TypeError('fetch failed') },
      config: () => response(docWith(['hy3'])),
    })
    expect((await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)).map(model => model.id))
      .toEqual(['hy3'])
  })

  it('reports the product document\'s HTTP status when both routes fail', async () => {
    stubRoutes({
      console: () => response('console down', false, 503),
      config: () => response('config down', false, 503),
    })
    // A generic message would collapse "upstream down", "signed out" and "bad
    // catalog" into one; the status keeps classifyUpstreamError able to split
    // them, which is what the status card renders.
    await expect(new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)).rejects.toThrow(/503|upstream/i)
  })

  it('still fails when both documents carry no cli agent', async () => {
    const noAgent = JSON.stringify({ code: 0, msg: 'ok', data: { models: [{ id: 'x', maxInputTokens: 1, maxOutputTokens: 1 }] } })
    stubRoutes({ console: () => response(noAgent), config: () => response(noAgent) })
    await expect(new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)).rejects.toThrow(/cli agent|roster/i)
  })
})

describe('CN catalog: the international route keeps its single source', () => {
  it('never reads the console roster document', async () => {
    const calls = stubRoutes({
      console: () => response(docWith(['should-not-be-read'])),
      config: () => response(docWith(['gpt-6-astra'])),
    })
    const client = new WorkBuddyUpstreamClient({
      resolveAppVersion: async () => ({ version: '5.7.7', source: 'installed', bundle: '/x' }),
    })
    const models = await client.fetchModels({ ...CREDENTIAL, domain: 'www.workbuddy.ai' })
    // The console route is CN-only; asking it for the global variant would be
    // an unmeasured request against a gateway nobody measured it on.
    expect(calls).not.toContain('console')
    expect(models.map(model => model.id)).toEqual(['gpt-6-astra'])
    expect(client.lastCatalog?.source).toBe('workbuddy-ai:app')
  })

  it('keeps the App-shaped UA and X-Product on the international config read', async () => {
    const headers: Record<string, string>[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/v3/config')) headers.push((init?.headers ?? {}) as Record<string, string>)
      return response(docWith(['gpt-6-astra']))
    }))
    const client = new WorkBuddyUpstreamClient({
      resolveAppVersion: async () => ({ version: '5.7.7', source: 'installed', bundle: '/x' }),
    })
    await client.fetchModels({ ...CREDENTIAL, domain: 'www.workbuddy.ai' })
    // The gateway splits /v3/config by client identity; handing it the CN shape
    // would return the wrong roster.
    expect(headers).toHaveLength(1)
    expect(headers[0]!['X-Requested-With']).toBe('XMLHttpRequest')
    expect(headers[0]!['X-Product']).toBe('SaaS')
    expect(headers[0]!['User-Agent']).toContain('5.7.7')
  })
})
