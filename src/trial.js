/**
 * ProviderTrial: single-slot search-method experiments with Approach A accounting.
 *
 * Search admission uses only Control vs Treatment contrast scores.
 * evolve_run fitness gains during an open window are Task-only and never decide
 * whether a new provider becomes the search tip.
 *
 * @module dsh-evolve-loop/trial
 */

import { appendFile, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PROVIDER_SLOTS } from './evolve.js'
import { alive, merit, POPULATION_FILE, readPopulation, writePopulation } from './population.js'

export const TRIAL_DIR = 'trial'
export const TRIAL_STATE_FILE = 'current.json'
export const TASK_LEDGER = 'ledger_task.jsonl'
export const SEARCH_LEDGER = 'ledger_search.jsonl'
export const CERTIFICATES = 'certificates.jsonl'

export const STATES = Object.freeze({
  idle: 'idle',
  open: 'open',
  contrasted: 'contrasted',
})

function trialRoot(runDir) {
  return join(runDir, TRIAL_DIR)
}

function statePath(runDir) {
  return join(trialRoot(runDir), TRIAL_STATE_FILE)
}

function snapshotPopPath(runDir) {
  return join(trialRoot(runDir), 'snapshot', POPULATION_FILE)
}

/**
 * @param {string} runDir
 * @returns {Promise<object>}
 */
export async function loadTrial(runDir) {
  try {
    return JSON.parse(await readFile(statePath(runDir), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { schema_version: 1, state: STATES.idle }
    }
    throw error
  }
}

/**
 * @param {string} runDir
 * @param {object} trial
 */
export async function saveTrial(runDir, trial) {
  const root = trialRoot(runDir)
  await mkdir(root, { recursive: true })
  await writeFile(statePath(runDir), `${JSON.stringify(trial, null, 2)}\n`, 'utf8')
}

async function appendLedger(runDir, filename, record) {
  const root = trialRoot(runDir)
  await mkdir(root, { recursive: true })
  await appendFile(join(root, filename), `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * Refuse provider activation that would break a single-slot trial window.
 * @param {object} trial
 * @param {{ plugin_id: string, package_id?: string }} intent
 */
export function assertActivationAllowed(trial, intent) {
  if (trial.state === STATES.idle) return
  if (trial.state === STATES.contrasted) {
    throw new Error(
      'a provider trial has finished contrast and is waiting for evolve_trial_close; '
      + 'activate/deactivate outside close is refused',
    )
  }
  // state === open
  if (intent.plugin_id !== trial.plugin_id) {
    throw new Error(
      `provider trial is open for plugin "${trial.plugin_id}" only; `
      + `refusing activate of "${intent.plugin_id}"`,
    )
  }
  if (trial.package_id && intent.package_id && intent.package_id !== trial.package_id) {
    throw new Error(
      `provider trial is open for package "${trial.package_id}" only; `
      + `refusing activate of "${intent.package_id}"`,
    )
  }
}

/**
 * Public evolve_deactivate is refused while a trial owns the provider stacks.
 * Contrast/close call the runner directly and are not subject to this gate.
 * @param {object} trial
 * @param {{ plugin_id: string }} [_intent]
 */
export function assertDeactivationAllowed(trial, _intent) {
  if (trial.state === STATES.idle) return
  if (trial.state === STATES.open) {
    throw new Error(
      'provider trial is open; stacks are frozen — deactivate only via evolve_trial_contrast / evolve_trial_close',
    )
  }
  if (trial.state === STATES.contrasted) {
    throw new Error(
      'a provider trial is waiting for evolve_trial_close; manual deactivate is refused',
    )
  }
}

/**
 * Open a single-slot trial window (Approach A).
 * Caller activates the treatment plugin after this returns successfully.
 *
 * @param {string} runDir
 * @param {object} args
 * @param {string} args.slot
 * @param {string} args.plugin_id
 * @param {string} args.package_id
 * @param {number} args.K - total official evals reserved for contrast (even, >=2)
 * @param {number} [args.delta=0]
 * @param {Record<string, string[]>} args.providers_before
 * @param {number} args.budget_remaining
 * @param {{ id: string, fitness: number } | null} args.tip
 */
export async function openTrial(runDir, args) {
  const existing = await loadTrial(runDir)
  if (existing.state !== STATES.idle) {
    throw new Error(`provider trial already ${existing.state}; close it before opening another`)
  }

  const slot = args.slot
  if (!PROVIDER_SLOTS.includes(slot) || slot === 'evaluate') {
    throw new Error(`trial slot must be one of loop|select|mutate|survive (got ${String(slot)})`)
  }
  const K = args.K
  if (!Number.isSafeInteger(K) || K < 2 || K % 2 !== 0) {
    throw new Error(`K must be an even integer >= 2 (got ${String(K)})`)
  }
  const delta = args.delta ?? 0
  if (typeof delta !== 'number' || Number.isNaN(delta)) {
    throw new Error('delta must be a number')
  }
  if (!Number.isSafeInteger(args.budget_remaining) || args.budget_remaining < K) {
    throw new Error(
      `need at least ${String(K)} remaining candidate budget to reserve a trial `
      + `(have ${String(args.budget_remaining)})`,
    )
  }

  const rows = await readPopulation(runDir)
  const tip = args.tip ?? bestOf(rows)
  await mkdir(join(trialRoot(runDir), 'snapshot'), { recursive: true })
  try {
    await copyFile(join(runDir, POPULATION_FILE), snapshotPopPath(runDir))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await writeFile(snapshotPopPath(runDir), '', 'utf8')
  }

  const trial = {
    schema_version: 1,
    state: STATES.open,
    policy: 'A',
    slot,
    plugin_id: args.plugin_id,
    package_id: args.package_id,
    K,
    k_per_arm: K / 2,
    delta,
    opened_at: new Date().toISOString(),
    providers_before: args.providers_before,
    tip_before: tip,
    budget_remaining_at_open: args.budget_remaining,
    trial_used: 0,
    contrast: null,
  }
  await saveTrial(runDir, trial)
  return trial
}

/**
 * Approach A: record an evolve_run outcome as Task-only (never used for search admission).
 * @param {string} runDir
 * @param {object} record
 */
export async function recordTaskRollout(runDir, record) {
  const trial = await loadTrial(runDir)
  if (trial.state !== STATES.open && trial.state !== STATES.contrasted) return null
  const row = {
    kind: 'task_only',
    at: new Date().toISOString(),
    ...record,
  }
  await appendLedger(runDir, TASK_LEDGER, row)
  return row
}

/**
 * Restore population snapshot taken at open.
 * @param {string} runDir
 */
export async function restoreSnapshotPopulation(runDir) {
  let raw = ''
  try {
    raw = await readFile(snapshotPopPath(runDir), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const records = raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
  await writePopulation(runDir, records)
  return records
}

/**
 * Mark contrast arm scores into the search ledger.
 * @param {string} runDir
 * @param {'control'|'treatment'} arm
 * @param {number[]} scores
 * @param {object} [extra]
 */
export async function recordSearchArm(runDir, arm, scores, extra = {}) {
  const row = {
    kind: 'search_contrast',
    arm,
    scores,
    mean: mean(scores),
    at: new Date().toISOString(),
    ...extra,
  }
  await appendLedger(runDir, SEARCH_LEDGER, row)
  return row
}

/**
 * Finish contrast bookkeeping after both arms ran.
 * Does not read Task ledger (Approach A).
 *
 * @param {string} runDir
 * @param {{ control: number[], treatment: number[], trial_used: number }} arms
 */
export async function finishContrast(runDir, arms) {
  const trial = await loadTrial(runDir)
  if (trial.state !== STATES.open) {
    throw new Error(`evolve_trial_contrast requires state open (have ${trial.state})`)
  }
  const control = arms.control
  const treatment = arms.treatment
  if (!Array.isArray(control) || !Array.isArray(treatment)) {
    throw new Error('contrast needs control and treatment score arrays')
  }
  if (control.length !== trial.k_per_arm || treatment.length !== trial.k_per_arm) {
    throw new Error(
      `expected ${String(trial.k_per_arm)} scores per arm; `
      + `got control=${String(control.length)} treatment=${String(treatment.length)}`,
    )
  }

  const controlMean = mean(control)
  const treatmentMean = mean(treatment)
  const passed = treatmentMean > controlMean + trial.delta
  const contrast = {
    control_scores: control,
    treatment_scores: treatment,
    control_mean: controlMean,
    treatment_mean: treatmentMean,
    delta: trial.delta,
    passed,
    compared_by: 'mean_fitness',
    at: new Date().toISOString(),
  }

  trial.state = STATES.contrasted
  trial.contrast = contrast
  trial.trial_used = arms.trial_used
  await saveTrial(runDir, trial)
  await appendLedger(runDir, SEARCH_LEDGER, { kind: 'contrast_summary', ...contrast })
  return trial
}

/**
 * Close the trial: commit or reject search tip. Approach A ignores Task ledger.
 * @param {string} runDir
 * @param {{ commit_providers: Record<string, string[]>, reject_providers: Record<string, string[]> }} stacks
 */
export async function closeTrial(runDir, stacks) {
  const trial = await loadTrial(runDir)
  if (trial.state !== STATES.contrasted) {
    throw new Error(`evolve_trial_close requires state contrasted (have ${trial.state})`)
  }
  if (!trial.contrast) throw new Error('missing contrast result')

  const admitted = trial.contrast.passed === true
  const certificate = {
    schema_version: 1,
    policy: 'A',
    admitted,
    slot: trial.slot,
    plugin_id: trial.plugin_id,
    package_id: trial.package_id,
    K: trial.K,
    delta: trial.delta,
    control_mean: trial.contrast.control_mean,
    treatment_mean: trial.contrast.treatment_mean,
    tip_before: trial.tip_before,
    providers_before: trial.providers_before,
    providers_after: admitted ? stacks.commit_providers : stacks.reject_providers,
    trial_used: trial.trial_used,
    at: new Date().toISOString(),
    note: 'Approach A: Task-only evolve_run gains during the window were not used for admission',
  }
  await appendLedger(runDir, CERTIFICATES, certificate)

  const closed = {
    schema_version: 1,
    state: STATES.idle,
    last_certificate: certificate,
  }
  await saveTrial(runDir, closed)
  return { admitted, certificate, trial: closed }
}

/**
 * @param {object[]} rows
 * @returns {{ id: string, fitness: number } | null}
 */
export function bestOf(rows) {
  const live = alive(rows)
  if (live.length === 0) return null
  let best = live[0]
  for (const row of live) {
    if (merit(row.fitness) > merit(best.fitness)) best = row
  }
  return { id: best.id, fitness: best.fitness }
}

function mean(scores) {
  if (scores.length === 0) return 0
  return scores.reduce((a, b) => a + b, 0) / scores.length
}

/**
 * Collect the last `n` recorded fitnesses from population (chronological).
 * @param {object[]} rows
 * @param {number} n
 */
export function lastFitnesses(rows, n) {
  const scored = rows.filter(row => typeof row.fitness === 'number')
  return scored.slice(-n).map(row => row.fitness)
}
