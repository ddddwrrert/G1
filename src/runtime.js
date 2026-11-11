/**
 * Runtime changes to the search: the model-facing tools that define, activate
 * and deactivate dynamic plugins which register `evolve` providers.
 *
 * DSH 0.1.7 ships the dynamic plugin runner (`dynamicCordisRunner`, from
 * `@deepseek-ai/dsh-cordis-host-runner`, mounted by the web profile) for
 * programmatic callers, and gives the model no tool for it: `dsh-tool-cordis`
 * only inspects. These tools call the runner's `define`, `run`, `stop` and
 * `undefine` for the calling agent's own session, host code only, and check
 * that each change actually reached the `evolve` provider stacks.
 *
 * @module dsh-evolve-loop/runtime
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { runPaths } from './candidates.js'
import { assertActivationAllowed, assertDeactivationAllowed, loadTrial } from './trial.js'

/** The runner's id prefix for plugins these tools create (3–6 lowercase letters). */
export const PLUGIN_ID_PREFIX = 'evo'

const RUNNER_MISSING = 'the dynamic plugin runner (dynamicCordisRunner) is not available in this DSH process; '
  + 'the host composition must mount @deepseek-ai/dsh-cordis-host-runner, which the DSH web profile does by default'

/**
 * The runner service, or a clear error when the host composition lacks it.
 * @param {object} ctx - the plugin context.
 * @returns {object} the `dynamicCordisRunner` service.
 */
function runnerOf(ctx) {
  const runner = ctx.get('dynamicCordisRunner')
  if (runner === undefined) throw new Error(RUNNER_MISSING)
  return runner
}

/**
 * The calling agent: dynamic plugins belong to the session that defines them.
 * @param {object} exec - the tool execution context.
 * @returns {object} the agent.
 */
function agentOf(exec) {
  if (exec.agent === undefined) throw new Error('evolve runtime tools need an Agent-backed session')
  return exec.agent
}

/**
 * The slots whose provider stacks differ between two `providerStacks()` snapshots.
 * @param {Record<string, string[]>} before
 * @param {Record<string, string[]>} after
 * @returns {Record<string, { before: string[], after: string[] }>}
 */
export function changedSlots(before, after) {
  const changed = {}
  for (const slot of Object.keys(after)) {
    const a = before[slot] ?? []
    const b = after[slot]
    if (a.length !== b.length || a.some((name, i) => name !== b[i])) changed[slot] = { before: a, after: b }
  }
  return changed
}

/**
 * Warnings about host code that cannot register a provider the way the search expects.
 * They are advice, not refusals: the runner still accepts the package.
 * @param {string} code - the package's host code.
 * @returns {string[]}
 */
export function hostCodeWarnings(code) {
  const warnings = []
  if (!/\bevolve\b/.test(code)) {
    warnings.push('the code never mentions `evolve`; a search provider is registered with `evolve.register(slot, provider)` on the `evolve` service')
  } else if (!/\.register\s*\(|\.replace\s*\(/.test(code)) {
    warnings.push('the code does not call `evolve.register(...)`; activating it will not change any search step')
  }
  if (/\.register\s*\(/.test(code) && !/ctx\.effect\s*\(/.test(code)) {
    warnings.push('`evolve.register(...)` is not inside `ctx.effect(...)`; deactivating the plugin will then not remove the provider')
  }
  if (/\bnode:fs\b|require\s*\(\s*['"]fs['"]\s*\)/.test(code)) {
    warnings.push('`node:fs` does not exist in the dynamic sandbox; persist search state with `evolve.files`')
  }
  return warnings
}

/**
 * A compact, source-free view of one plugin for the model.
 * @param {object} plugin - the runner's plugin inspection.
 * @returns {object}
 */
function pluginView(plugin) {
  const failure = plugin.latestRun?.error
  return {
    plugin_id: plugin.pluginId,
    running: plugin.activeRun === undefined ? null : plugin.activeRun.packageId,
    current_package_id: plugin.currentPackageId ?? null,
    packages: (plugin.packages ?? []).map(pkg => ({ package_id: pkg.packageId, name: pkg.name, purpose: pkg.purpose })),
    ...failure === undefined ? {} : { last_failure: { phase: failure.phase, message: failure.message } },
  }
}

const jsonOutput = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * Register the runtime tools.
 * @param {object} ctx - the plugin context.
 * @param {import('./evolve.js').Evolve} evolve - the evolve service.
 */
export function registerRuntimeTools(ctx, evolve) {
  ctx.tools.register(defineTool({
    name: 'evolve_define',
    description:
      'Record a dynamic plugin that changes the search at runtime, without running it. The code is host JavaScript '
      + 'for the dynamic plugin sandbox; it reaches the search through the `evolve` service, typically '
      + '`ctx.effect(() => evolve.register(slot, provider))` for slot loop, select, mutate, evaluate or survive. '
      + 'Omit plugin_id to create a new plugin; pass an existing plugin_id to add a new version of it (versions are '
      + 'immutable). Returns { plugin_id, package_id, warnings }; warnings flag code that cannot register a provider as '
      + 'expected. Activate it with evolve_activate. Plugins belong to this session and disappear when DSH restarts.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short label for this version, e.g. "tournament select".' },
      purpose: { type: 'string', required: true, description: 'What this change should do to the search, and why.' },
      host_code: { type: 'string', required: true, description: 'Host JavaScript of the dynamic plugin.' },
      plugin_id: { type: 'string', description: 'An existing plugin to add this version to. Omit to create a new plugin.' },
    },
    output: jsonOutput,
    presentCall: args => ({ card: 'generic', title: `Define search change${typeof args?.name === 'string' ? `: ${args.name}` : ''}`, kind: 'edit' }),
    async execute(args, exec) {
      const agent = agentOf(exec)
      const runner = runnerOf(ctx)
      const code = typeof args.host_code === 'string' ? args.host_code : ''
      if (code.trim() === '') throw new Error('evolve_define needs non-empty `host_code`')
      const receipt = runner.define({
        sessionId: agent.id,
        plugin: typeof args.plugin_id === 'string' && args.plugin_id !== ''
          ? { kind: 'existing', pluginId: args.plugin_id }
          : { kind: 'new', idPrefix: PLUGIN_ID_PREFIX },
        name: args.name,
        purpose: args.purpose,
        code: { host: code },
      })
      return { plugin_id: receipt.pluginId, package_id: receipt.packageId, warnings: hostCodeWarnings(code) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'evolve_activate',
    description:
      'Activate a dynamic plugin recorded with evolve_define: start it, or switch a running plugin to another version. '
      + 'package_id defaults to the plugin\'s newest version. Refused while evolve_run is executing, so a step never '
      + 'changes in the middle of an iteration. Also refused while a provider trial window blocks other activations '
      + '(use evolve_trial_open / evolve_trial_close). Returns { ok, plugin_id, package_id, mode, changed, providers, '
      + 'warnings }: `changed` lists every search slot whose provider stack changed, `providers` is the stack of every '
      + 'slot after activation (last name active). ok=false carries the failure message and stack. The next evolve_run '
      + 'uses the active providers.',
    parameters: {
      plugin_id: { type: 'string', required: true, description: 'The plugin to activate.' },
      package_id: { type: 'string', description: 'The version to activate. Default: the newest version.' },
    },
    output: jsonOutput,
    presentCall: () => ({ card: 'generic', title: 'Activate search change', kind: 'edit' }),
    async execute(args, exec) {
      const agent = agentOf(exec)
      const runner = runnerOf(ctx)
      if (evolve.running) throw new Error('an evolve run is in progress; activate search changes between evolve_run calls')
      const { root } = runPaths(agent)
      assertActivationAllowed(await loadTrial(root), {
        plugin_id: args.plugin_id,
        package_id: typeof args.package_id === 'string' ? args.package_id : undefined,
      })
      const plugin = runner.inspectPlugin(agent, args.plugin_id)
      const packageId = typeof args.package_id === 'string' && args.package_id !== ''
        ? args.package_id
        : plugin.packages.at(-1)?.packageId
      if (packageId === undefined) throw new Error(`dynamic plugin "${args.plugin_id}" has no version to activate`)
      // A running plugin switches versions with `update`; a stopped one starts with `run`.
      const mode = plugin.activeRun === undefined ? 'run' : 'update'
      const before = evolve.providerStacks()
      const response = await runner.run(agent, args.plugin_id, packageId, mode, exec.signal)
      const after = evolve.providerStacks()
      const changed = changedSlots(before, after)
      if (!response.ok) {
        return {
          ok: false,
          plugin_id: args.plugin_id,
          package_id: packageId,
          mode,
          reason: response.reason,
          message: response.message,
          ...response.stack === undefined ? {} : { stack: response.stack },
          changed,
          providers: after,
        }
      }
      const warnings = []
      if (response.waitingFor.length > 0) {
        warnings.push(`the plugin is waiting for services that do not exist: ${response.waitingFor.join(', ')}; it has not run yet`)
      }
      if (response.status !== 'running') {
        warnings.push(`activation is ${response.status}, not running; a host-only plugin should run at once`)
      }
      if (mode === 'run' && Object.keys(changed).length === 0 && response.waitingFor.length === 0) {
        warnings.push('the plugin is running but no search slot changed; it did not call evolve.register(...)')
      }
      return {
        ok: true,
        plugin_id: response.pluginId,
        package_id: response.packageId,
        mode,
        changed,
        providers: after,
        warnings,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'evolve_deactivate',
    description:
      'Stop a running dynamic plugin; the providers it registered inside ctx.effect are removed and the slot falls back '
      + 'to the provider below it. The plugin and its versions are kept, so evolve_activate can start it again. With '
      + 'remove=true the plugin and every version are deleted. Refused while evolve_run is executing, and while a '
      + 'provider trial window owns the stacks (use evolve_trial_contrast / evolve_trial_close). Returns '
      + '{ ok, changed, providers, warnings }.',
    parameters: {
      plugin_id: { type: 'string', required: true, description: 'The plugin to stop.' },
      remove: { type: 'boolean', description: 'Also delete the plugin and all its versions. Default false.' },
    },
    output: jsonOutput,
    presentCall: () => ({ card: 'generic', title: 'Deactivate search change', kind: 'edit' }),
    async execute(args, exec) {
      const agent = agentOf(exec)
      const runner = runnerOf(ctx)
      if (evolve.running) throw new Error('an evolve run is in progress; deactivate search changes between evolve_run calls')
      const { root } = runPaths(agent)
      assertDeactivationAllowed(await loadTrial(root), { plugin_id: args.plugin_id })
      const before = evolve.providerStacks()
      const response = args.remove === true
        ? await runner.undefine(agent, args.plugin_id)
        : await runner.stop(agent, args.plugin_id)
      const after = evolve.providerStacks()
      const changed = changedSlots(before, after)
      const warnings = []
      if (response.ok === true && Object.keys(changed).length === 0) {
        warnings.push('no search slot changed; the plugin registered no provider, or registered it outside ctx.effect and it is still active')
      }
      return { ...response, changed, providers: after, warnings }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'evolve_plugins',
    description:
      'Read-only: list the dynamic plugins this session defined for the search, with their versions, which version is '
      + 'running, and the last activation failure; plus the provider stack of every search slot. Source code is not '
      + 'returned.',
    parameters: {},
    output: jsonOutput,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'List search changes', kind: 'read' }),
    async execute(_args, exec) {
      const agent = agentOf(exec)
      const runner = runnerOf(ctx)
      return { plugins: runner.listPlugins(agent).map(pluginView), providers: evolve.providerStacks() }
    },
  }))
}
