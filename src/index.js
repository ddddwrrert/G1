/**
 * The EVOLVE search plugin: provides the `evolve` service, the model-facing `evolve_run` and `evolve_status`
 * tools, the runtime tools that change the search with dynamic plugins (see ./runtime.js), and ProviderTrial
 * tools for Approach A search-method admission (see ./trial-tools.js).
 *
 * Exposes swappable service providers on ctx.evolve ('loop' / 'evolve-loop', 'select', 'mutate', 'evaluate', 'survive').
 *
 * @module dsh-evolve-loop
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { budgetReport } from './budget.js'
import { runPaths } from './candidates.js'
import { Evolve, DEFAULT_MAX_POPULATION, DEFAULT_K } from './evolve.js'
import { registerRuntimeTools } from './runtime.js'
import { loadTrial, recordTaskRollout, STATES } from './trial.js'
import { registerTrialTools } from './trial-tools.js'

export const name = 'dsh-evolve-loop'
export const inject = ['tools', 'subagents']

// Appended to every evolve_run result, whichever loop provider produced it.
const RUN_REMINDER = 'Reminder: before changing the search, load the improving-the-search-strategy skill again; '
  + 'its content may no longer be in your context.'

const TRIAL_TASK_ONLY_NOTE = 'Provider trial window open (Approach A): this evolve_run was Task-only; '
  + 'it does not admit the treatment provider. Use evolve_trial_contrast + evolve_trial_close for search admission.'

/**
 * Provide the `evolve` service and register `evolve_run`, `evolve_status` and the runtime tools.
 * @param {object} ctx - the plugin context.
 */
export function apply(ctx) {
  const evolve = new Evolve(ctx)
  ctx.provide('evolve', evolve)

  ctx.tools.register(defineTool({
    name: 'evolve_run',
    description:
      'Run the evolutionary search on the task in your working directory, and wait until it stops. '
      + 'Its state lives in run/ inside the task. When the population is empty, the baseline c000000 is created, '
      + 'evaluated and recorded without spending budget. Each search iteration selects a parent, generates a new '
      + 'candidate, scores it with the task\'s evaluator (evaluator/evaluator.py, settings in task.json), records it '
      + 'in population.jsonl, and culls excess candidates. '
      + 'Returns the best candidate ID, its fitness, and remaining budget: { best_id, best_fitness, remaining }. '
      + 'All search components (evolve-loop, select, mutate, evaluate, survive) are swappable via ctx.evolve.register(). '
      + 'While a provider trial is open, scores are Task-only (Approach A) and K evaluations stay reserved for contrast.',
    parameters: {
      max_budget: {
        type: 'integer',
        required: true,
        description: 'Total number of new candidates for the whole run, from the user\'s instruction.',
      },
      max_population: {
        type: 'integer',
        description: `How many alive candidates the population may hold before it is culled. Default ${DEFAULT_MAX_POPULATION}.`,
      },
      k: {
        type: 'integer',
        description: `How many candidates a cull keeps. Default ${DEFAULT_K}.`,
      },
      candidates: {
        type: 'integer',
        description: 'The most new candidates this call may create. Default: until the budget is used.',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        const summary = value && typeof value.best_id === 'string' && typeof value.best_fitness === 'number'
          ? `Best candidate ${value.best_id} (fitness ${value.best_fitness}); ${value.remaining} of budget remaining.`
          : JSON.stringify(value)
        const trialNote = value?.trial_task_only === true ? `\n\n${TRIAL_TASK_ONLY_NOTE}` : ''
        return [{ type: 'text', text: `${summary}${trialNote}\n\n${RUN_REMINDER}` }]
      },
    },
    async execute(args, exec) {
      const { root } = runPaths(exec.agent)
      const trial = await loadTrial(root)
      if (trial.state === STATES.contrasted) {
        throw new Error(
          'a provider trial has finished contrast; call evolve_trial_close before evolve_run',
        )
      }

      let candidates = args.candidates
      let trialTaskOnly = false
      if (trial.state === STATES.open) {
        trialTaskOnly = true
        const budget = await budgetReport(root)
        if (budget === null) throw new Error('missing run budget')
        const reserved = trial.K
        const free = budget.remaining - reserved
        if (free <= 0) {
          throw new Error(
            `provider trial has reserved ${String(reserved)} evaluations for evolve_trial_contrast; `
            + `no free budget for Task-only evolve_run (remaining ${String(budget.remaining)})`,
          )
        }
        candidates = candidates === undefined ? free : Math.min(candidates, free)
        if (candidates < 1) {
          throw new Error(
            `provider trial reserved ${String(reserved)} for contrast; cannot run Task-only evolve_run`,
          )
        }
      }

      const result = await evolve.run({
        maxBudget: args.max_budget,
        ...(args.max_population === undefined ? {} : { maxPopulation: args.max_population }),
        ...(args.k === undefined ? {} : { k: args.k }),
        ...(candidates === undefined ? {} : { candidates }),
      }, exec)

      if (trialTaskOnly && result !== null && result !== undefined) {
        await recordTaskRollout(root, {
          best_id: result.best_id,
          best_fitness: result.best_fitness,
          remaining: result.remaining,
          providers: evolve.providerStacks(),
          plugin_id: trial.plugin_id,
          slot: trial.slot,
        })
        return { ...result, trial_task_only: true, policy: 'A' }
      }
      return result ?? null
    },
  }))

  ctx.tools.register(defineTool({
    name: 'evolve_status',
    description:
      'Read-only: show the providers and the budget of the evolve search, without running anything. '
      + '`providers` lists, for each step (loop, select, mutate, evaluate, survive), the provider names stacked in that '
      + 'slot from bottom to top; the last name is the active one. Providers belong to this DSH process. '
      + '`budget` is the candidate budget of the task in your working directory: { max, used, remaining }; null before '
      + 'the first evolve_run on this task; { error } if it cannot be read. For the population, read run/population.jsonl. '
      + '`trial` is the current provider trial window (Approach A), if any.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Read evolve status', kind: 'read' }),
    async execute(_args, exec) {
      const { task, root } = runPaths(exec.agent)
      let budget
      try {
        budget = await budgetReport(root)
      } catch (error) {
        budget = { error: error instanceof Error ? error.message : String(error) }
      }
      const trial = await loadTrial(root)
      return { task, providers: evolve.providerStacks(), budget, trial }
    },
  }))

  registerRuntimeTools(ctx, evolve)
  registerTrialTools(ctx, evolve)
}
