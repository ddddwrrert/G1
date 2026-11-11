import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as plugin from '../src/index.js'
import { defaultInstruction, defaultPersona } from '../src/providers/mutate.js'

const FIXTURE_TASK = fileURLToPath(new URL('./fixtures/task/', import.meta.url))
const FIXTURE_ROOT = fileURLToPath(new URL('../.test-runs/', import.meta.url))

let task: string
let ctx: Context
let evolve: any
let agent: any
let hasProvider: boolean
let worker: (request: any) => Promise<void>
let capturedStartRequests: any[] = []

async function bump(dir: string, by: number): Promise<void> {
  const source = await readFile(join(dir, 'solution.py'), 'utf8')
  const val = Number(/^VALUE = (-?\d+)$/m.exec(source)![1])
  await writeFile(join(dir, 'solution.py'), source.replace(/^VALUE = -?\d+$/m, `VALUE = ${String(val + by)}`), 'utf8')
}

function subagentsService() {
  return {
    getProvider: (name: string) => (hasProvider && name === 'candidate-builder' ? { name } : undefined),
    async start(_name: string, request: any) {
      capturedStartRequests.push(request)
      await worker(request)
      return {
        id: 'child-1',
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'report' }], stopReason: 'completed' }),
        async dispose() {},
      }
    },
  }
}

function runTool(args: Record<string, unknown>, signal = new AbortController().signal) {
  return ctx.tools.get('evolve_run')!.execute(args, {
    agent,
    callId: 'call-evolve_run',
    name: 'evolve_run',
    signal,
  } as never) as Promise<any>
}

beforeEach(async () => {
  await mkdir(FIXTURE_ROOT, { recursive: true })
  task = await realpath(await mkdtemp(join(FIXTURE_ROOT, 'task-')))
  await cp(FIXTURE_TASK, task, { recursive: true })
  agent = { id: 'orchestrator', session: { id: 'orchestrator', header: { cwd: task } } }
  hasProvider = true
  capturedStartRequests = []
  worker = async req => bump(req.confine.root, 10)

  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Subprocess)
  await ctx.plugin({ name: 'test-subagents', apply: (scope: Context) => { scope.provide('subagents', subagentsService()) } })
  await ctx.plugin(plugin)
  evolve = ctx.get('evolve')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await ctx.fiber.dispose()
})

describe('provider swapping', () => {
  it('lists default providers', () => {
    const list = evolve.listProviders()
    expect(list).toEqual({
      loop: 'evolve-loop',
      select: 'fitness-proportional',
      mutate: 'candidate-builder',
      evaluate: 'python-subprocess',
      survive: 'top-k',
    })
  })

  it('uses defaultInstruction and defaultPersona with parent fitness feedback', async () => {
    const inst = defaultInstruction(42)
    const pers = defaultPersona()

    expect(inst).not.toMatch(/test your change/i)
    expect(pers).not.toMatch(/test your change/i)
    expect(inst).toContain('#EVOLVE_START')
    expect(inst).toContain('#EVOLVE_END')
    expect(inst).toContain("The parent candidate's official fitness was 42.")

    await runTool({ max_budget: 1 })
    expect(capturedStartRequests).toHaveLength(1)
    const req = capturedStartRequests[0]
    // Baseline c000000 scored 10 in fixture, so candidate c000001 gets score 10 feedback
    expect(req.prompt[0].text).toContain("The parent candidate's official fitness was 10.")
    expect(req.persona).toBe(pers)
    expect(req.label).toBe('mutator')
  })

  it('asks for a single solution attempt', async () => {
    const inst = defaultInstruction()
    const pers = defaultPersona()

    expect(inst).toContain('one complete solution attempt')
    expect(inst).not.toContain('validity checks')
    expect(inst).toContain('Understand how the current solution works')
    expect(pers).toContain('IMPLEMENT A SINGLE SOLUTION. DO NOT ATTEMPT MULTIPLE SOLUTIONS.')

    await runTool({ max_budget: 1 })
    // The shell stays available to the default worker.
    expect(capturedStartRequests[0].confine.allowShell).toBe(true)
  })

  it('uses name as the worker label when supplied', async () => {
    const mutateProvider = evolve.getProvider('mutate')
    evolve.register('loop', {
      name: 'named-worker-test-loop',
      async run() {
        const base = await evolve.copyTask()
        return await mutateProvider.mutate({
          parent: base.id,
          name: 'explorer',
          description: 'Legacy worker label',
        }, evolve)
      },
    })

    await runTool({ max_budget: 1 })
    expect(capturedStartRequests[0].label).toBe('explorer')
  })

  it('forwards all candidate-builder parameters from mutate', async () => {
    const mutateProvider = evolve.getProvider('mutate')
    evolve.register('loop', {
      name: 'mutate-test-loop',
      async run() {
        const base = await evolve.copyTask()
        return await mutateProvider.mutate({
          parent: base.id,
          instruction: 'Custom task instruction',
          description: 'Special worker task',
          persona: 'Optimization specialist',
          model: 'deepseek-coder-v2',
          allowShell: false,
          allowedTools: ['read', 'write'],
          maxDepth: 2,
        }, evolve)
      },
    })

    await runTool({ max_budget: 1 })

    expect(capturedStartRequests).toHaveLength(1)
    const req = capturedStartRequests[0]
    expect(req.prompt).toEqual([{ type: 'text', text: 'Custom task instruction' }])
    expect(req.label).toBe('Special worker task')
    expect(req.persona).toBe('Optimization specialist')
    expect(req.agentOptions).toEqual({ model: 'deepseek-coder-v2' })
    expect(req.maxDepth).toBe(2)
    expect(req.confine.allowShell).toBe(false)
    expect(req.confine.allowedTools).toEqual(['read', 'write'])
  })

  it('swaps select provider and restores upon dispose', async () => {
    let customSelected = false
    const dispose = evolve.register('select', {
      name: 'always-baseline-selection',
      async select() {
        customSelected = true
        return 'c000000'
      },
    })

    expect(evolve.listProviders().select).toBe('always-baseline-selection')

    await runTool({ max_budget: 1, max_population: 10 })
    expect(customSelected).toBe(true)

    // Dispose restores previous provider
    dispose()
    expect(evolve.listProviders().select).toBe('fitness-proportional')
  })

  it('swaps evaluate provider', async () => {
    evolve.register('evaluate', {
      name: 'constant-score-evaluator',
      async evaluate() {
        return 999.5
      },
    })

    expect(evolve.listProviders().evaluate).toBe('constant-score-evaluator')

    const result = await runTool({ max_budget: 1, max_population: 10 })
    expect(result.best_fitness).toBe(999.5)
  })

  it('swaps mutate provider', async () => {
    let customMutated = false
    evolve.register('mutate', {
      name: 'custom-mutator',
      async mutate({ parent }, evolveService: any) {
        customMutated = true
        const cand = await evolveService.allocate(parent)
        // Custom mutation: bump by 100 directly
        await bump(cand.dir, 100)
        return cand
      },
    })

    const result = await runTool({ max_budget: 1, max_population: 10 })
    expect(customMutated).toBe(true)
    expect(result.best_fitness).toBe(110) // baseline 10 + 100
  })

  it('swaps survive provider', async () => {
    let customSurviveCalled = false
    evolve.register('survive', {
      name: 'custom-survive',
      async survive(pop: any) {
        customSurviveCalled = true
        const r = await pop.rows()
        // cull everything except baseline
        await pop.write(r.map((x: any) => x.id === 'c000000' ? x : { ...x, survival: 'no' }))
      },
    })

    await runTool({ max_budget: 2, max_population: 2 })
    expect(customSurviveCalled).toBe(true)
  })

  it('swaps loop provider (evolve-loop)', async () => {
    evolve.register('evolve-loop', {
      name: 'mock-instant-loop',
      async run() {
        return {
          best_id: 'c_custom',
          best_fitness: 1337,
          remaining: 42,
        }
      },
    })

    expect(evolve.listProviders().loop).toBe('mock-instant-loop')

    const result = await runTool({ max_budget: 50, max_population: 10 })
    expect(result).toEqual({
      best_id: 'c_custom',
      best_fitness: 1337,
      remaining: 42,
    })
  })
})
