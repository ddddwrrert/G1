import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import DynamicCordisRunner from '@deepseek-ai/dsh-cordis-host-runner'
import * as plugin from '../src/index.js'
import { changedSlots, hostCodeWarnings } from '../src/runtime.js'
import { openTrial, saveTrial, STATES } from '../src/trial.js'

const FIXTURE_ROOT = fileURLToPath(new URL('../.test-runs/', import.meta.url))

/**
 * The runtime tools on a real tree with DSH 0.1.7's dynamic plugin runner: the
 * host code strings stand in for what the model writes, and every define,
 * activation and deactivation goes through the real runner and sandbox.
 */

const DEFAULT_STACKS = {
  loop: ['evolve-loop'],
  select: ['fitness-proportional'],
  mutate: ['candidate-builder'],
  evaluate: ['python-subprocess'],
  survive: ['top-k'],
}

/** A dynamic plugin that registers one select provider, inside ctx.effect. */
const TOURNAMENT = `
  return {
    name: 'tournament-select',
    inject: ['evolve'],
    apply(ctx) {
      ctx.effect(() => ctx.evolve.register('select', {
        name: 'tournament',
        async select(population) { return population[0].id },
      }))
    },
  }
`

let ctx: Context
let evolve: any
let taskDir: string
let agent: { id: string, steer: () => void, inject: () => void, session: { id: string, header: { cwd: string } } }
let other: typeof agent

function call(name: string, args: object, caller: object = agent): Promise<any> {
  return ctx.tools.get(name)!.execute(args as never, {
    agent: caller,
    callId: `call-${name}`,
    name,
    signal: new AbortController().signal,
  } as never) as Promise<any>
}

beforeEach(async () => {
  await mkdir(FIXTURE_ROOT, { recursive: true })
  taskDir = await realpath(await mkdtemp(join(FIXTURE_ROOT, 'runtime-')))
  agent = { id: 'S-evolve', steer() {}, inject() {}, session: { id: 'S-evolve', header: { cwd: taskDir } } }
  other = { id: 'S-other', steer() {}, inject() {}, session: { id: 'S-other', header: { cwd: taskDir } } }

  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Subprocess)
  await ctx.plugin({
    name: 'test-subagents',
    apply: (scope: Context) => {
      scope.provide('subagents', { getProvider: (name: string) => (name === 'candidate-builder' ? { name } : undefined) })
    },
  })
  await ctx.plugin(DynamicCordisRunner)
  await ctx.plugin(plugin)
  evolve = ctx.get('evolve')
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(taskDir, { recursive: true, force: true })
})

describe('runtime tools on the 0.1.7 runner', () => {
  it('define records without running; activate registers the provider; deactivate removes it', async () => {
    const defined = await call('evolve_define', { name: 'tournament', purpose: 'test', host_code: TOURNAMENT })
    expect(defined.plugin_id).toMatch(/^evo/)
    expect(defined.warnings).toEqual([])
    expect(evolve.providerStacks()).toEqual(DEFAULT_STACKS)

    const activated = await call('evolve_activate', { plugin_id: defined.plugin_id })
    expect(activated).toMatchObject({ ok: true, mode: 'run', warnings: [] })
    expect(activated.changed).toEqual({ select: { before: ['fitness-proportional'], after: ['fitness-proportional', 'tournament'] } })
    expect(evolve.getProvider('select').name).toBe('tournament')

    const listed = await call('evolve_plugins', {})
    expect(listed.plugins).toEqual([expect.objectContaining({ plugin_id: defined.plugin_id, running: defined.package_id })])

    const stopped = await call('evolve_deactivate', { plugin_id: defined.plugin_id })
    expect(stopped).toMatchObject({ ok: true, warnings: [] })
    expect(stopped.changed).toEqual({ select: { before: ['fitness-proportional', 'tournament'], after: ['fitness-proportional'] } })
    expect(evolve.providerStacks()).toEqual(DEFAULT_STACKS)

    const removed = await call('evolve_deactivate', { plugin_id: defined.plugin_id, remove: true })
    expect(removed.ok).toBe(true)
    expect((await call('evolve_plugins', {})).plugins).toEqual([])
  })

  it('switches a running plugin to a newer version with update', async () => {
    const first = await call('evolve_define', { name: 'v1', purpose: 'test', host_code: TOURNAMENT })
    await call('evolve_activate', { plugin_id: first.plugin_id })
    const second = await call('evolve_define', {
      name: 'v2', purpose: 'test', plugin_id: first.plugin_id, host_code: TOURNAMENT.replace("'tournament'", "'tournament-v2'"),
    })
    expect(second.plugin_id).toBe(first.plugin_id)

    const updated = await call('evolve_activate', { plugin_id: first.plugin_id })
    expect(updated).toMatchObject({ ok: true, mode: 'update', package_id: second.package_id })
    expect(evolve.providerStacks().select).toEqual(['fitness-proportional', 'tournament-v2'])
  })

  it('warns when a running plugin changed no slot', async () => {
    const defined = await call('evolve_define', {
      name: 'nothing', purpose: 'test', host_code: "return { name: 'noop', apply() {} }",
    })
    expect(defined.warnings[0]).toMatch(/never mentions `evolve`/)
    const activated = await call('evolve_activate', { plugin_id: defined.plugin_id })
    expect(activated.ok).toBe(true)
    expect(activated.changed).toEqual({})
    expect(activated.warnings).toEqual(['the plugin is running but no search slot changed; it did not call evolve.register(...)'])
  })

  it('reports a host code failure with its message, and leaves the providers unchanged', async () => {
    const defined = await call('evolve_define', {
      name: 'broken', purpose: 'test', host_code: "return { name: 'broken', inject: ['evolve'], apply() { throw new Error('boom') } }",
    })
    const activated = await call('evolve_activate', { plugin_id: defined.plugin_id })
    expect(activated).toMatchObject({ ok: false, reason: 'host-half-failed' })
    expect(activated.message).toMatch(/boom/)
    expect(activated.providers).toEqual(DEFAULT_STACKS)
  })

  it('refuses to change the search while an evolve run is executing', async () => {
    const defined = await call('evolve_define', { name: 'tournament', purpose: 'test', host_code: TOURNAMENT })
    Object.defineProperty(evolve, 'running', { value: true, configurable: true })
    await expect(call('evolve_activate', { plugin_id: defined.plugin_id })).rejects.toThrow(/evolve run is in progress/)
    await expect(call('evolve_deactivate', { plugin_id: defined.plugin_id })).rejects.toThrow(/evolve run is in progress/)
    expect(evolve.providerStacks()).toEqual(DEFAULT_STACKS)
  })

  it('keeps plugins to the session that defined them', async () => {
    const defined = await call('evolve_define', { name: 'tournament', purpose: 'test', host_code: TOURNAMENT })
    await expect(call('evolve_activate', { plugin_id: defined.plugin_id }, other)).rejects.toThrow()
    expect((await call('evolve_plugins', {}, other)).plugins).toEqual([])
    expect(evolve.providerStacks()).toEqual(DEFAULT_STACKS)
  })

  it('refuses activate/deactivate while a provider trial window is open', async () => {
    const defined = await call('evolve_define', { name: 'tournament', purpose: 'test', host_code: TOURNAMENT })
    const otherPlugin = await call('evolve_define', { name: 'other', purpose: 'test', host_code: TOURNAMENT })
    const runDir = join(taskDir, 'run')
    await mkdir(runDir, { recursive: true })
    await openTrial(runDir, {
      slot: 'select',
      plugin_id: defined.plugin_id,
      package_id: defined.package_id,
      K: 2,
      providers_before: evolve.providerStacks(),
      budget_remaining: 10,
      tip: null,
    })
    await expect(call('evolve_activate', { plugin_id: otherPlugin.plugin_id })).rejects.toThrow(/provider trial is open/)
    await expect(call('evolve_deactivate', { plugin_id: defined.plugin_id })).rejects.toThrow(/frozen/)
    await saveTrial(runDir, { schema_version: 1, state: STATES.idle })
  })
})

describe('runtime tools without the runner', () => {
  it('explain that the host runner is missing', async () => {
    const bare = new Context()
    await bare.plugin(SystemPrompt)
    await bare.plugin(Tools)
    await bare.plugin(Subprocess)
    await bare.plugin({ name: 'test-subagents', apply: (scope: Context) => { scope.provide('subagents', {}) } })
    await bare.plugin(plugin)
    await expect(bare.tools.get('evolve_plugins')!.execute({} as never, { agent } as never)).rejects.toThrow(/dsh-cordis-host-runner/)
    await bare.fiber.dispose()
  })
})

describe('checks', () => {
  it('changedSlots names only the slots whose stack differs', () => {
    expect(changedSlots(DEFAULT_STACKS, { ...DEFAULT_STACKS, survive: ['top-k', 'islands'] }))
      .toEqual({ survive: { before: ['top-k'], after: ['top-k', 'islands'] } })
    expect(changedSlots(DEFAULT_STACKS, DEFAULT_STACKS)).toEqual({})
  })

  it('hostCodeWarnings flags registration outside ctx.effect and node:fs', () => {
    expect(hostCodeWarnings("apply(ctx) { ctx.evolve.register('select', p) }"))
      .toEqual(['`evolve.register(...)` is not inside `ctx.effect(...)`; deactivating the plugin will then not remove the provider'])
    expect(hostCodeWarnings("import('node:fs'); ctx.effect(() => ctx.evolve.register('select', p))"))
      .toEqual(['`node:fs` does not exist in the dynamic sandbox; persist search state with `evolve.files`'])
  })
})
