/**
 * Model-facing tools for ProviderTrial (Approach A).
 *
 * @module dsh-evolve-loop/trial-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { budgetReport } from './budget.js'
import { runPaths } from './candidates.js'
import { readPopulation } from './population.js'
import { changedSlots } from './runtime.js'
import {
  bestOf,
  closeTrial,
  finishContrast,
  loadTrial,
  openTrial,
  recordSearchArm,
  restoreSnapshotPopulation,
  saveTrial,
  STATES,
} from './trial.js'

const jsonOutput = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

function agentOf(exec) {
  if (exec.agent === undefined) throw new Error('provider trial tools need an Agent-backed session')
  return exec.agent
}

function runnerOf(ctx) {
  const runner = ctx.get('dynamicCordisRunner')
  if (runner === undefined) {
    throw new Error(
      'the dynamic plugin runner (dynamicCordisRunner) is not available in this DSH process; '
      + 'the host composition must mount @deepseek-ai/dsh-cordis-host-runner',
    )
  }
  return runner
}

/**
 * Fitnesses of candidates appended by one arm (last k if more were created).
 * @param {object[]} before
 * @param {object[]} after
 * @param {number} k
 */
function armScores(before, after, k) {
  const gained = after.slice(before.length)
    .map(row => row.fitness)
    .filter(x => typeof x === 'number')
  return gained.slice(-k)
}

/**
 * @param {object} ctx
 * @param {import('./evolve.js').Evolve} evolve
 */
export function registerTrialTools(ctx, evolve) {
  ctx.tools.register(defineTool({
    name: 'evolve_trial_open',
    description:
      'Open a single-slot provider trial window (Approach A). Freezes population snapshot S0, reserves K even '
      + 'official evaluations for Control vs Treatment contrast, and activates the treatment plugin. While the '
      + 'window is open, evolve_activate/deactivate are gated; evolve_run gains are Task-only and never admit the '
      + 'new provider; remaining budget keeps K evaluations for contrast. Next: evolve_trial_contrast, then '
      + 'evolve_trial_close. Slot evaluate cannot be trialled.',
    parameters: {
      slot: {
        type: 'string',
        required: true,
        description: 'Search slot to change: loop, select, mutate, or survive.',
      },
      plugin_id: { type: 'string', required: true, description: 'Dynamic plugin that registers the treatment provider.' },
      package_id: { type: 'string', description: 'Plugin version to activate. Default: newest.' },
      K: {
        type: 'integer',
        required: true,
        description: 'Even number of official candidate evaluations reserved for contrast (>=2).',
      },
      delta: {
        type: 'number',
        description: 'Treatment mean must exceed control mean by more than delta to pass. Default 0.',
      },
      max_budget: {
        type: 'integer',
        required: true,
        description: 'Same max_budget as evolve_run for this task (used to read remaining budget).',
      },
    },
    output: jsonOutput,
    presentCall: () => ({ card: 'generic', title: 'Open provider trial', kind: 'edit' }),
    async execute(args, exec) {
      const agent = agentOf(exec)
      const runner = runnerOf(ctx)
      if (evolve.running) throw new Error('an evolve run is in progress; open trials between evolve_run calls')

      const { root } = runPaths(agent)
      const budget = await budgetReport(root)
      if (budget === null) {
        throw new Error('no run budget yet; call evolve_run once to pin max_budget before opening a trial')
      }
      if (budget.max !== args.max_budget) {
        throw new Error(`max_budget must match the pinned run budget ${String(budget.max)}`)
      }

      const plugin = runner.inspectPlugin(agent, args.plugin_id)
      const packageId = typeof args.package_id === 'string' && args.package_id !== ''
        ? args.package_id
        : plugin.packages.at(-1)?.packageId
      if (packageId === undefined) throw new Error(`dynamic plugin "${args.plugin_id}" has no version to activate`)

      const providersBefore = evolve.providerStacks()
      const tip = bestOf(await readPopulation(root))
      const trial = await openTrial(root, {
        slot: args.slot,
        plugin_id: args.plugin_id,
        package_id: packageId,
        K: args.K,
        delta: args.delta ?? 0,
        providers_before: providersBefore,
        budget_remaining: budget.remaining,
        tip,
      })

      const mode = plugin.activeRun === undefined ? 'run' : 'update'
      const before = evolve.providerStacks()
      const response = await runner.run(agent, args.plugin_id, packageId, mode, exec.signal)
      const after = evolve.providerStacks()
      const changed = changedSlots(before, after)
      if (!response.ok) {
        await saveTrial(root, { schema_version: 1, state: STATES.idle, aborted: 'activation_failed' })
        return {
          ok: false,
          trial: await loadTrial(root),
          activation: {
            ok: false,
            plugin_id: args.plugin_id,
            package_id: packageId,
            mode,
            message: response.message,
            changed,
            providers: after,
          },
        }
      }
      return {
        ok: true,
        trial,
        activation: {
          ok: true,
          plugin_id: response.pluginId,
          package_id: response.packageId,
          mode,
          changed,
          providers: after,
          waitingFor: response.waitingFor,
        },
        policy: 'A',
        reminder:
          'evolve_run scores during this window are Task-only; search admission uses evolve_trial_contrast only. '
          + `${String(args.K)} evaluations are reserved for contrast.`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'evolve_trial_contrast',
    description:
      'Run Control vs Treatment contrast for the open provider trial (Approach A). Restores population snapshot S0, '
      + 'runs k=K/2 candidates under the treatment providers, deactivates the treatment plugin, restores S0 again, '
      + 'runs k candidates under control providers, then records Search-ledger means. Task-only evolve_run gains are '
      + 'ignored. Call evolve_trial_close next.',
    parameters: {
      max_budget: {
        type: 'integer',
        required: true,
        description: 'Pinned run max_budget (same as evolve_run).',
      },
      max_population: { type: 'integer', description: 'Optional; passed through to evolve_run arms.' },
      k_survive: { type: 'integer', description: 'Optional survive-k passed through to evolve_run arms.' },
    },
    output: jsonOutput,
    presentCall: () => ({ card: 'generic', title: 'Provider trial contrast', kind: 'edit' }),
    async execute(args, exec) {
      const agent = agentOf(exec)
      const runner = runnerOf(ctx)
      if (evolve.running) throw new Error('an evolve run is in progress; contrast between evolve_run calls')

      const { root } = runPaths(agent)
      const trial = await loadTrial(root)
      if (trial.state !== STATES.open) {
        throw new Error(`evolve_trial_contrast requires an open trial (have ${trial.state})`)
      }

      const budget = await budgetReport(root)
      if (budget === null) throw new Error('missing run budget')
      if (budget.max !== args.max_budget) {
        throw new Error(`max_budget must match the pinned run budget ${String(budget.max)}`)
      }
      const need = trial.K
      if (budget.remaining < need) {
        throw new Error(
          `contrast needs ${String(need)} remaining candidates; have ${String(budget.remaining)}`,
        )
      }

      const armArgs = {
        maxBudget: args.max_budget,
        ...(args.max_population === undefined ? {} : { maxPopulation: args.max_population }),
        ...(args.k_survive === undefined ? {} : { k: args.k_survive }),
        candidates: trial.k_per_arm,
      }

      // Treatment arm (plugin currently active from open).
      await restoreSnapshotPopulation(root)
      const beforeTreat = await readPopulation(root)
      await evolve.run(armArgs, exec)
      const afterTreat = await readPopulation(root)
      const treatmentScores = armScores(beforeTreat, afterTreat, trial.k_per_arm)
      await recordSearchArm(root, 'treatment', treatmentScores, { plugin_id: trial.plugin_id })

      // Switch to control: stop treatment plugin (bypasses public deactivate gate).
      const beforeStop = evolve.providerStacks()
      const stop = await runner.stop(agent, trial.plugin_id)
      const afterStop = evolve.providerStacks()
      if (stop.ok !== true) {
        throw new Error(`failed to deactivate treatment for control arm: ${stop.message ?? stop.reason ?? 'unknown'}`)
      }

      await restoreSnapshotPopulation(root)
      const beforeCtrl = await readPopulation(root)
      await evolve.run(armArgs, exec)
      const afterCtrl = await readPopulation(root)
      const controlScores = armScores(beforeCtrl, afterCtrl, trial.k_per_arm)
      await recordSearchArm(root, 'control', controlScores, {
        providers: afterStop,
        deactivated: changedSlots(beforeStop, afterStop),
      })

      const finished = await finishContrast(root, {
        control: controlScores,
        treatment: treatmentScores,
        trial_used: trial.k_per_arm * 2,
      })

      return {
        ok: true,
        trial: finished,
        contrast: finished.contrast,
        policy: 'A',
        note: 'Treatment plugin is deactivated pending evolve_trial_close. Task-only scores were not used.',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'evolve_trial_close',
    description:
      'Close the contrasted provider trial. If Treatment mean > Control mean + delta, re-activate the treatment '
      + 'plugin (search tip commit). Otherwise leave control providers in place (reject). Writes an immutable '
      + 'certificate. Approach A never consults Task-only evolve_run gains.',
    parameters: {},
    output: jsonOutput,
    presentCall: () => ({ card: 'generic', title: 'Close provider trial', kind: 'edit' }),
    async execute(_args, exec) {
      const agent = agentOf(exec)
      const runner = runnerOf(ctx)
      if (evolve.running) throw new Error('an evolve run is in progress; close trials between evolve_run calls')

      const { root } = runPaths(agent)
      const trial = await loadTrial(root)
      if (trial.state !== STATES.contrasted) {
        throw new Error(`evolve_trial_close requires contrasted state (have ${trial.state})`)
      }

      let commitProviders = evolve.providerStacks()
      if (trial.contrast.passed) {
        const plugin = runner.inspectPlugin(agent, trial.plugin_id)
        const mode = plugin.activeRun === undefined ? 'run' : 'update'
        const response = await runner.run(agent, trial.plugin_id, trial.package_id, mode, exec.signal)
        commitProviders = evolve.providerStacks()
        if (!response.ok) {
          throw new Error(
            `contrast passed but re-activating treatment failed: ${response.message ?? response.reason}`,
          )
        }
      }

      const stacksNow = evolve.providerStacks()
      const result = await closeTrial(root, {
        commit_providers: commitProviders,
        reject_providers: stacksNow,
      })
      return {
        ok: true,
        admitted: result.admitted,
        certificate: result.certificate,
        providers: stacksNow,
        policy: 'A',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'evolve_trial_status',
    description: 'Read-only: show the current provider trial window state and Approach A reminder.',
    parameters: {},
    output: jsonOutput,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Provider trial status', kind: 'read' }),
    async execute(_args, exec) {
      const { root } = runPaths(agentOf(exec))
      const trial = await loadTrial(root)
      return {
        trial,
        policy: 'A',
        reminder: trial.state === STATES.idle
          ? 'no open trial'
          : 'Task-only evolve_run gains do not admit providers; use contrast + close.',
      }
    },
  }))
}
