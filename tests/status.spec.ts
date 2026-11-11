import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as plugin from '../src/index.js'

const FIXTURE_TASK = fileURLToPath(new URL('./fixtures/task/', import.meta.url))
const FIXTURE_ROOT = fileURLToPath(new URL('../.test-runs/', import.meta.url))

const DEFAULT_STACKS = {
  loop: ['evolve-loop'],
  select: ['fitness-proportional'],
  mutate: ['candidate-builder'],
  evaluate: ['python-subprocess'],
  survive: ['top-k'],
}

let task: string
let ctx: Context
let evolve: any

function status() {
  return ctx.tools.get('evolve_status')!.execute({}, {
    agent: { id: 'orchestrator', session: { id: 'orchestrator', header: { cwd: task } } },
    callId: 'call-evolve_status',
    name: 'evolve_status',
    signal: new AbortController().signal,
  } as never) as Promise<any>
}

beforeEach(async () => {
  await mkdir(FIXTURE_ROOT, { recursive: true })
  task = await realpath(await mkdtemp(join(FIXTURE_ROOT, 'status-')))
  await cp(FIXTURE_TASK, task, { recursive: true })

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
  await ctx.plugin(plugin)
  evolve = ctx.get('evolve')
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(task, { recursive: true, force: true })
})

describe('evolve_status', () => {
  it('reports the caller task, the default providers, and no budget before the first run', async () => {
    const value = await status()
    expect(value).toEqual({
      task,
      providers: DEFAULT_STACKS,
      budget: null,
      trial: { schema_version: 1, state: 'idle' },
    })

    const rendered = ctx.tools.get('evolve_status')!.output.render({}, value)
    expect(rendered).toEqual([{ type: 'text', text: JSON.stringify(value) }])
  })

  it('shows every stacked provider bottom to top, and the defaults again after disposal', async () => {
    const disposeObject = evolve.register('select', { name: 'tournament', async select() { return 'c000000' } })
    const disposeFunction = evolve.register('select', async function greedyBest() { return 'c000000' })
    const disposeArrow = evolve.register('survive', async () => {})

    expect((await status()).providers).toEqual({
      ...DEFAULT_STACKS,
      select: ['fitness-proportional', 'tournament', 'greedyBest'],
      survive: ['top-k', 'custom'],
    })

    disposeFunction()
    disposeObject()
    disposeArrow()
    expect((await status()).providers).toEqual(DEFAULT_STACKS)
  })

  it('counts the budget from the run folder, and reports a budget file it cannot read', async () => {
    const root = join(task, 'run')
    for (const id of ['c000000', 'c000001', 'c000002']) {
      await mkdir(join(root, 'candidates', id), { recursive: true })
    }
    await writeFile(join(root, 'budget.json'), '{ "max": 5 }\n', 'utf8')
    expect((await status()).budget).toEqual({ max: 5, used: 2, remaining: 3 })

    await writeFile(join(root, 'budget.json'), 'not json', 'utf8')
    const { budget, providers } = await status()
    expect(budget).toEqual({ error: expect.any(String) })
    expect(providers).toEqual(DEFAULT_STACKS)
  })
})
