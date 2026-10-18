/**
 * A test double carrying the DSH 0.2.x settings-forms API (`SettingsForms`).
 *
 * The real service derives its sections from the running composition's own
 * Loader entries, which a unit spec cannot assemble. This double keeps the
 * parts the plugin actually depends on, in the shapes the real service
 * produces (`@deepseek-ai/dsh-settings`, `SettingsForms`):
 *
 *   - `describe()` returns one descriptor per entry, each carrying the entry's
 *     `ns` (the profile **entry id**, not the settings namespace the 0.1.x
 *     sections were installed under), the live schema object, the projected
 *     `value`, and a `revision` the writer may hand back to `update()`.
 *   - `update(ns, patch, expectedRevision?)` merges `patch` into the entry's
 *     user section, bumps the revision, and — exactly like the real service —
 *     emits `settings/document-updated` and rejects an id it does not serve
 *     (with the real error text, so the plugin's failure reporting is what is
 *     under test).
 *
 * Two knobs exist because the reviewer's cases are about *not* trusting a
 * write: `failNextWrite` makes the next `update()` reject, and `silent` makes
 * it resolve without recording anything (a host adapter that reports success
 * while the document never moved).
 *
 * @module dsh-workbuddy-connect/tests/helpers/modern-settings
 */

import type { Context } from '@deepseek-ai/cordis'

/** One served entry, in the shape `describe()` reports. */
export interface ModernEntry {
  ns: string
  schema: unknown
  value: Record<string, unknown>
  revision: number
}

/** Builder options for {@link ModernSettingsForms}. */
export interface ModernSettingsFormsOptions {
  /** Entries to serve; the caller builds them so a spec controls identity. */
  entries: { ns: string; schema: unknown; value?: Record<string, unknown> }[]
  /** Reject the next write with this message (persistence failure). */
  failNextWrite?: string
  /** Resolve the next write without recording it (a silent no-op adapter). */
  silent?: boolean
  /** Context to emit `settings/document-updated` on; optional in pure unit tests. */
  emitter?: Context
}

/**
 * The 0.2.x forms service, reduced to what this plugin drives.
 *
 * `describe()` and `update()` are deliberately *own* methods (not accessors):
 * `modernSettingsOf` detects the generation structurally and would reject an
 * accessor-backed double that the real class also rejects detection on.
 */
export class ModernSettingsForms {
  private readonly entries: ModernEntry[]
  /** Every accepted write, so a spec can assert the target entry and value. */
  readonly writes: { ns: string; patch: Record<string, unknown>; expectedRevision: number | undefined }[] = []
  private failNextWrite: string | undefined
  private silent: boolean
  private readonly emitter: Context | undefined

  constructor(options: ModernSettingsFormsOptions) {
    this.entries = options.entries.map(entry => ({
      ns: entry.ns,
      schema: entry.schema,
      value: { ...(entry.value ?? {}) },
      revision: 0,
    }))
    this.failNextWrite = options.failNextWrite
    this.silent = options.silent === true
    this.emitter = options.emitter
  }

  /** Arm a persistence failure for the next write. */
  failNext(message = 'disk is read-only'): void {
    this.failNextWrite = message
  }

  /** Arm a silent no-op write for the next call. */
  goSilent(silent = true): void {
    this.silent = silent
  }

  /** Current stored value of one entry, or `undefined` when unserved. */
  stored(ns: string): Record<string, unknown> | undefined {
    return this.entries.find(entry => entry.ns === ns)?.value
  }

  describe(_options?: unknown): ModernEntry[] {
    return this.entries.map(entry => ({ ...entry, value: { ...entry.value } }))
  }

  async update(ns: string, patch: object, expectedRevision?: number): Promise<void> {
    const entry = this.entries.find(candidate => candidate.ns === ns)
    if (entry === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
    if (this.failNextWrite !== undefined) {
      const message = this.failNextWrite
      this.failNextWrite = undefined
      throw new Error(message)
    }
    this.writes.push({ ns, patch: { ...(patch as Record<string, unknown>) }, expectedRevision })
    if (this.silent) {
      this.silent = false
      return
    }
    entry.value = { ...entry.value, ...(patch as Record<string, unknown>) }
    entry.revision += 1
    ;(this.emitter as unknown as { emit?: (event: string, ...args: unknown[]) => void })
      ?.emit?.('settings/document-updated', ns, entry.revision)
  }
}
