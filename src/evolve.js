/**
 * The `evolve` service: Service Definition for the evolutionary search capability seam.
 *
 * Exposes swappable service provider slots ('loop' | 'select' | 'mutate' | 'evaluate' | 'survive')
 * that agents and plugins can inspect and modify at runtime.
 *
 * @module dsh-evolve-loop/evolve
 */

import { isAbsolute } from 'node:path'
import loopProvider from './providers/loop.js'
import selectProvider from './providers/select.js'
import mutateProvider from './providers/mutate.js'
import evaluateProvider from './providers/evaluate.js'
import surviveProvider, { DEFAULT_K } from './providers/survive.js'
import { budgetStatus, pinBudget, readBudget } from './budget.js'
import { allocateCandidate, candidatePath, copyTask, isCandidate, runPaths } from './candidates.js'
import { populationOf } from './population.js'
import { filesOf } from './files.js'

export const PROVIDER_SLOTS = Object.freeze(['loop', 'select', 'mutate', 'evaluate', 'survive'])
export const WORKER_PROVIDER = 'candidate-builder'
export const DEFAULT_MAX_POPULATION = 10
export { DEFAULT_K }

function normalizeSlot(slot) {
  if (slot === 'evolve-loop') return 'loop'
  if (slot === 'improve') return 'mutate'
  return slot
}

function requirePositiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (got ${String(value)})`)
  }
}

function optionalPositiveInteger(name, value) {
  if (value !== undefined) requirePositiveInteger(name, value)
}

function textOf(blocks) {
  return (blocks ?? [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

export class Evolve {
  /** The plugin context: subagents, subprocess, sandbox. */
  ctx
  /** slot -> provider stack */
  #providers = new Map()
  /** Active run metadata */
  #current = undefined

  constructor(ctx) {
    this.ctx = ctx
    this.#providers.set('loop', [loopProvider])
    this.#providers.set('select', [selectProvider])
    this.#providers.set('mutate', [mutateProvider])
    this.#providers.set('evaluate', [evaluateProvider])
    this.#providers.set('survive', [surviveProvider])
  }

  /** Whether an evolve run is executing right now. */
  get running() {
    return this.#current !== undefined
  }

  currentRun() {
    if (this.#current === undefined) {
      throw new Error('no evolve run is in progress; this is only available while evolve.run is executing')
    }
    return this.#current
  }

  /**
   * Register a provider for a slot ('loop', 'select', 'mutate', 'evaluate', 'survive').
   * Pushes onto the active provider stack and returns a cleanup disposer.
   * @param {string} slot - the provider slot.
   * @param {object|Function} provider - provider object or implementation function.
   * @returns {() => void} cleanup disposer that unregisters this provider.
   */
  register(slot, provider) {
    const key = normalizeSlot(slot)
    if (!PROVIDER_SLOTS.includes(key)) {
      throw new Error(`cannot register provider for "${String(slot)}"; valid slots are: ${PROVIDER_SLOTS.join(', ')}`)
    }

    let entry = provider
    if (typeof provider === 'function') {
      // `||`, not `??`: an inline arrow function has an empty name.
      entry = { name: provider.name || 'custom', [key === 'loop' ? 'run' : key]: provider }
    } else if (!provider || typeof provider !== 'object') {
      throw new Error(`register("${slot}", provider) needs a provider object or function`)
    }

    const stack = this.#providers.get(key)
    stack.push(entry)

    const disposer = () => {
      const index = stack.indexOf(entry)
      if (index > 0) stack.splice(index, 1)
    }

    return disposer
  }

  /**
   * Alias for register: replaces a step's implementation.
   * @param {string} slot
   * @param {Function|object} fn
   * @returns {() => void}
   */
  replace(slot, fn) {
    return this.register(slot, fn)
  }

  /**
   * Get the active provider for a slot.
   * @param {string} slot
   * @returns {object}
   */
  getProvider(slot) {
    const key = normalizeSlot(slot)
    const stack = this.#providers.get(key)
    if (!stack || stack.length === 0) {
      throw new Error(`no provider found for slot "${slot}"`)
    }
    return stack[stack.length - 1]
  }

  /**
   * List all current active providers.
   * @returns {Record<string, string>}
   */
  listProviders() {
    const result = {}
    for (const slot of PROVIDER_SLOTS) {
      const provider = this.getProvider(slot)
      result[slot] = provider.name ?? 'custom'
    }
    return result
  }

  /**
   * List the provider names stacked in every slot, bottom to top. The last name
   * in each list is the active provider; the first is the default.
   * @returns {Record<string, string[]>}
   */
  providerStacks() {
    const result = {}
    for (const slot of PROVIDER_SLOTS) {
      result[slot] = this.#providers.get(slot).map(provider => (
        typeof provider.name === 'string' && provider.name !== '' ? provider.name : 'custom'
      ))
    }
    return result
  }

  /**
   * Run the search for the calling agent until budget or limit is exhausted.
   * @param {object} args
   * @param {object} exec
   * @returns {Promise<{ best_id: string, best_fitness: number, remaining: number }>}
   */
  async run(args, exec) {
    if (this.#current !== undefined) throw new Error('an evolve run is already in progress')
    const {
      maxBudget,
      maxPopulation = DEFAULT_MAX_POPULATION,
      k = DEFAULT_K,
      candidates,
    } = args ?? {}

    requirePositiveInteger('maxBudget', maxBudget)
    requirePositiveInteger('maxPopulation', maxPopulation)
    optionalPositiveInteger('k', k)
    optionalPositiveInteger('candidates', candidates)
    if (exec?.agent === undefined) throw new Error('evolve.run needs the calling agent (exec.agent)')
    if (this.ctx.subagents?.getProvider?.(WORKER_PROVIDER) === undefined) {
      throw new Error(`evolve needs the "${WORKER_PROVIDER}" subagent provider, and none is registered`)
    }

    const { task, root } = runPaths(exec.agent)
    this.#current = Object.freeze({
      task,
      root,
      agent: exec.agent,
      signal: exec.signal ?? new AbortController().signal,
      k,
      maxPopulation,
      candidates,
    })

    try {
      await pinBudget(root, maxBudget)
      const loop = this.getProvider('loop')
      const runFn = loop.run ?? loop['evolve-loop'] ?? loop
      if (typeof runFn !== 'function') throw new Error('active loop provider has no run method')
      return await runFn(args, this)
    } finally {
      this.#current = undefined
    }
  }

  /** Selection delegate */
  async select(population) {
    const provider = this.getProvider('select')
    const fn = provider.select ?? provider
    if (typeof fn !== 'function') throw new Error('active select provider has no select method')
    return await fn(population, this)
  }

  /** Mutation delegate */
  async mutate(options) {
    const provider = this.getProvider('mutate')
    const fn = provider.mutate ?? provider.improve ?? provider
    if (typeof fn !== 'function') throw new Error('active mutate provider has no mutate method')
    return await fn(options, this)
  }

  /** Evaluation delegate */
  async evaluate(candidate) {
    const provider = this.getProvider('evaluate')
    const fn = provider.evaluate ?? provider
    if (typeof fn !== 'function') throw new Error('active evaluate provider has no evaluate method')
    return await fn(candidate, this)
  }

  /** Survival delegate */
  async survive(population) {
    const provider = this.getProvider('survive')
    const fn = provider.survive ?? provider
    if (typeof fn !== 'function') throw new Error('active survive provider has no survive method')
    return await fn(population, this)
  }

  /**
   * Allocate a new candidate directory from parent, spending 1 budget unit.
   * @param {string} parentId
   * @returns {Promise<{ id: string, dir: string }>}
   */
  async allocate(parentId) {
    const run = this.currentRun()
    run.signal.throwIfAborted()
    if (!(await isCandidate(run.root, parentId))) {
      throw new Error(`cannot allocate from ${String(parentId)}: it is not a candidate of this run`)
    }
    const created = await allocateCandidate(run.root, await readBudget(run.root), parentId)
    return { id: created.id, dir: created.path }
  }

  /**
   * Create the baseline c000000 from task. Spends 0 budget.
   * @returns {Promise<{ id: string, dir: string }>}
   */
  async copyTask() {
    const run = this.currentRun()
    run.signal.throwIfAborted()
    const created = await copyTask(run.root, run.task)
    return { id: created.id, dir: created.path }
  }

  /** Population handle for current run */
  population() {
    return populationOf(this.currentRun().root)
  }

  /**
   * Run-scoped file store for search state.
   *
   * A neutral storage primitive: it reads and writes bytes under the run
   * directory (`run/`) and carries no memory or search strategy. Dynamic
   * (sandboxed) provider code must use this instead of `node:fs` or `ctx.fs`:
   * the dynamic sandbox has no `node:fs`, and the harness's `ctx.fs` resolves
   * the deployment default sandbox policy without a caller session, so a write
   * under `run/` is denied with `FS_SANDBOX_DENIED`. The host half has no such
   * fence.
   * @returns {Readonly<object>} handle with resolve/write/append/read/list/exists/remove.
   */
  get files() {
    return filesOf(this.currentRun().root)
  }

  /** Context of the current run */
  async context() {
    const run = this.currentRun()
    return {
      task: run.task,
      root: run.root,
      k: run.k,
      maxPopulation: run.maxPopulation,
      candidates: run.candidates,
      budget: await budgetStatus(run.root, await readBudget(run.root)),
    }
  }

  /**
   * Spawn a worker subagent confined to dir, supporting all candidate-builder parameters.
   * @param {string} dir - directory the worker is confined to.
   * @param {string} prompt - task prompt for the worker.
   * @param {object} [options] - candidate-builder parameters (description, persona, model, allowShell, allowedTools, maxDepth).
   */
  async spawnWorker(dir, prompt, options = {}) {
    const run = this.currentRun()
    run.signal.throwIfAborted()
    if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error('spawnWorker needs an absolute directory')
    if (typeof prompt !== 'string' || prompt === '') throw new Error('spawnWorker needs a prompt')

    const {
      description,
      label = description,
      persona,
      model,
      agentOptions = model ? { model } : undefined,
      maxDepth,
      allowShell = true,
      allowedTools,
      confine = {},
      ...rest
    } = options ?? {}

    const started = await this.ctx.subagents.start(WORKER_PROVIDER, {
      ...rest,
      prompt: [{ type: 'text', text: prompt }],
      parent: run.agent,
      signal: run.signal,
      ...(label !== undefined ? { label } : {}),
      ...(persona !== undefined ? { persona } : {}),
      ...(agentOptions !== undefined ? { agentOptions } : {}),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      confine: {
        root: dir,
        allowShell,
        ...(allowedTools ? { allowedTools } : {}),
        ...confine,
      },
    })

    const [execution] = await Promise.allSettled([started.result])
    const [disposal] = await Promise.allSettled([Promise.resolve().then(() => started.dispose())])

    if (execution.status === 'rejected') {
      if (disposal.status === 'rejected') {
        throw new AggregateError([execution.reason, disposal.reason], 'the worker and its disposal both failed')
      }
      throw execution.reason
    }
    if (disposal.status === 'rejected') throw disposal.reason

    run.signal.throwIfAborted()
    return { text: textOf(execution.value?.output), stopReason: execution.value?.stopReason }
  }
}
