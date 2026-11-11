import { cp, mkdir, mkdtemp, readFile, realpath, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as plugin from '../src/index.js'

const FIXTURE_TASK = fileURLToPath(new URL('./fixtures/task/', import.meta.url))
const FIXTURE_ROOT = fileURLToPath(new URL('../.test-runs/', import.meta.url))

let task: string
let ctx: Context
let evolve: any
let agent: any
let hasProvider: boolean
let starts: { request: any, order: string[] }[]
let worker: (request: any) => Promise<void>

async function setCandidateValue(dir: string, value: number): Promise<void> {
  const source = await readFile(join(dir, 'solution.py'), 'utf8')
  await writeFile(join(dir, 'solution.py'), source.replace(/^VALUE = -?\d+$/m, `VALUE = ${String(value)}`), 'utf8')
}

async function rows(): Promise<any[]> {
  const raw = await readFile(join(task, 'run', 'population.jsonl'), 'utf8')
  return raw.trim().split('\n').map(line => JSON.parse(line))
}

function subagentsService() {
  return {
    getProvider: (name: string) => (hasProvider && name === 'candidate-builder' ? { name } : undefined),
    async start(_name: string, request: any) {
      const order: string[] = []
      starts.push({ request, order })
      const result = (async () => {
        await worker(request)
        order.push('result')
        return { output: [{ type: 'text', text: 'report' }], stopReason: 'completed' }
      })()
      return {
        id: `child-${String(starts.length)}`,
        localAgent: undefined,
        result,
        async dispose() { order.push('dispose') },
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
  starts = []
  worker = async (req) => {
    const id = req.confine.root.split(/[/\\]/).pop()
    const n = Number(id.replace('c', ''))
    await setCandidateValue(req.confine.root, 10 + n * 5)
  }

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

describe('dsh-evolve-loop', () => {
  it('creates baseline and runs search candidates returning best_id, best_fitness, remaining', async () => {
    const result = await runTool({
      max_budget: 3,
      max_population: 10,
      candidates: 2,
    })

    // Returned object matches user contract
    expect(result).toEqual({
      best_id: 'c000002',
      best_fitness: 20,
      remaining: 1,
    })

    // Check population records on disk
    const records = await rows()
    expect(records).toHaveLength(3) // c000000, c000001, c000002
    expect(records[0]).toEqual({ id: 'c000000', parent: null, fitness: 10, survival: 'yes' })
    expect(records[1]).toEqual({ id: 'c000001', parent: 'c000000', fitness: 15, survival: 'yes' })
    expect(records[2]).toMatchObject({ id: 'c000002', fitness: 20, survival: 'yes' })

    // The evaluator's full result is kept for each candidate
    const evaluation = JSON.parse(await readFile(join(task, 'run', 'evals', 'c000001.json'), 'utf8'))
    expect(evaluation).toEqual({ fitness: 15, metrics: { combined_score: 15 } })
  })

  it('confines a sandboxed task\'s evaluator through the asynchronous sandbox service', async () => {
    const confined: { policy: any, signal?: AbortSignal }[] = []
    await ctx.plugin({
      name: 'test-sandbox',
      apply: (scope: Context) => {
        scope.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })
        // As DSH 0.1.7's SandboxProvider: confine resolves to the confined argv.
        scope.provide('sandbox', {
          async confine(argv: readonly string[], policy: any, signal?: AbortSignal) {
            confined.push({ policy, signal })
            return { argv: [...argv] }
          },
        })
      },
    })

    // The fixture task has "sandbox": true, so the baseline and c000001 both run confined
    const result = await runTool({ max_budget: 1 })

    expect(result).toEqual({ best_id: 'c000001', best_fitness: 15, remaining: 0 })
    expect(confined).toHaveLength(2)
    expect(confined[0].policy).toMatchObject({ mode: 'workspace-write' })
    expect(confined[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('ranks a failed evaluation (0) last on a minimize task, whose scores are negative', async () => {
    const scores: Record<string, number> = { c000000: -10, c000001: 0, c000002: -5, c000003: -20 }
    evolve.register('evaluate', { name: 'minimize-scores', async evaluate({ id }: any) { return scores[id] } })

    const result = await runTool({ max_budget: 3, max_population: 3, k: 2 })

    // The failed c000001 is neither reported as best nor kept by a cull
    expect(result).toEqual({ best_id: 'c000002', best_fitness: -5, remaining: 0 })
    expect((await rows()).filter(r => r.survival === 'yes').map(r => r.id)).toEqual(['c000000', 'c000002'])
  })

  it('stops the run when the task evaluator cannot be loaded', async () => {
    await writeFile(join(task, 'evaluator', 'evaluator.py'), 'import no_such_module\n', 'utf8')
    await expect(runTool({ max_budget: 1 }))
      .rejects.toThrow(/did not run on c000000[\s\S]*no_such_module/)
  })

  it('exhausts budget and enforces max_budget consistency', async () => {
    const first = await runTool({
      max_budget: 2,
      candidates: 1,
    })
    expect(first.remaining).toBe(1)

    const second = await runTool({
      max_budget: 2,
    })
    expect(second.remaining).toBe(0)
    expect(second.best_fitness).toBe(20)

    // Cannot change max_budget
    await expect(runTool({
      max_budget: 5,
    })).rejects.toThrow(/the budget for this run is already 2/)
  })

  it('applies default max_population = 10 and k = 5 when omitted', async () => {
    const result = await runTool({
      max_budget: 11, // baseline (0) + 11 candidates = 12 total entries
    })

    expect(result.best_id).toBe('c000011')
    expect(result.best_fitness).toBe(65)

    const records = await rows()
    expect(records).toHaveLength(12) // baseline + 11 candidates
    const aliveRecords = records.filter(r => r.survival === 'yes')
    expect(aliveRecords.length).toBeLessThanOrEqual(10)
    // 5 survivors from cull at 10 candidates + candidate 10 + candidate 11 = 7 alive
    expect(aliveRecords.length).toBe(7)
  })

  it('validates tool arguments', async () => {
    await expect(runTool({ max_budget: 0 }))
      .rejects.toThrow('maxBudget must be a positive integer')
    await expect(runTool({ max_budget: 10, max_population: 0 }))
      .rejects.toThrow('maxPopulation must be a positive integer')
  })

  it('renders clean high-signal text for the model', async () => {
    const tool = ctx.tools.get('evolve_run')!
    const rendered = tool.output.render({}, {
      best_id: 'c000003',
      best_fitness: 45.5,
      remaining: 8,
    })
    expect(rendered).toEqual([{
      type: 'text',
      text: 'Best candidate c000003 (fitness 45.5); 8 of budget remaining.\n\n'
        + 'Reminder: before changing the search, load the improving-the-search-strategy skill again; '
        + 'its content may no longer be in your context.',
    }])
  })

  it('tolerates worker crash and evaluates candidate as-is', async () => {
    worker = async () => {
      throw new Error('worker python process failed')
    }
    const result = await runTool({
      max_budget: 1,
    })
    expect(result.best_id).toBe('c000000')
    expect(result.remaining).toBe(0)

    const records = await rows()
    expect(records).toHaveLength(2)
    expect(records[1].id).toBe('c000001')
    expect(records[1].fitness).toBe(10)
  })

  it('stops when the call is aborted, and releases the run', async () => {
    const controller = new AbortController()
    evolve.register('mutate', async () => {
      controller.abort()
    })
    await expect(runTool({ max_budget: 3 }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })

    expect(() => evolve.currentRun()).toThrow('no evolve run is in progress')
  })

  it('fails loud when missing candidate-builder subagent provider', async () => {
    hasProvider = false
    await expect(runTool({ max_budget: 2 }))
      .rejects.toThrow('evolve needs the "candidate-builder" subagent provider')
  })

  it('refuses concurrent runs', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const inside = new Promise<void>(resolve => { entered = resolve })

    evolve.register('mutate', async ({ parent }: any, evolveSvc: any) => {
      entered()
      await gate
      const cand = await evolveSvc.allocate(parent)
      return cand
    })

    const first = runTool({ max_budget: 1 })
    await inside
    await expect(runTool({ max_budget: 1 })).rejects.toThrow('already in progress')
    release()
    await expect(first).resolves.toBeDefined()
  })
})
