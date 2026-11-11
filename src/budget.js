/**
 * Budget domain: manages the candidate attempt budget in budget.json and tracks
 * consumption against physical candidate directories.
 *
 * @module dsh-evolve-loop/budget
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { candidateOrdinals } from './candidates.js'

export const BUDGET_FILE = 'budget.json'

/**
 * Record the run's maximum budget, or verify that a subsequent call matches it.
 * @param {string} runDir - the run root directory.
 * @param {number} max - the budget cap.
 * @returns {Promise<number>} the pinned budget.
 */
export async function pinBudget(runDir, max) {
  let pinned
  try {
    pinned = JSON.parse(await readFile(join(runDir, BUDGET_FILE), 'utf8')).max
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, BUDGET_FILE), `${JSON.stringify({ max }, null, 2)}\n`, 'utf8')
    return max
  }
  if (pinned !== max) {
    throw new Error(`the budget for this run is already ${String(pinned)}; it cannot be changed to ${String(max)}`)
  }
  return pinned
}

/**
 * Read the pinned budget cap from budget.json.
 * @param {string} runDir - the run root directory.
 * @returns {Promise<number>}
 */
export async function readBudget(runDir) {
  let raw
  try {
    raw = await readFile(join(runDir, BUDGET_FILE), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('this run has no budget yet; it is set by the first run call')
    throw error
  }
  const { max } = JSON.parse(raw)
  if (!Number.isSafeInteger(max) || max < 0) {
    throw new Error(`${BUDGET_FILE} has no valid "max"`)
  }
  return max
}

/**
 * Calculate budget status from physical candidate directories.
 * Baseline (c000000) does not consume budget, so only ordinals >= 1 count as used.
 * @param {string} runDir - the run root directory.
 * @param {number} max - total budget cap.
 * @returns {Promise<{ max: number, used: number, remaining: number }>}
 */
export async function budgetStatus(runDir, max) {
  const ordinals = await candidateOrdinals(runDir)
  const used = ordinals.filter(ordinal => ordinal >= 1).length
  return { max, used, remaining: Math.max(0, max - used) }
}

/**
 * Report the budget without requiring a run to exist. Unlike readBudget, a
 * missing budget.json is a normal state here: it means no run call has been
 * made on this task yet.
 * @param {string} runDir - the run root directory.
 * @returns {Promise<{ max: number, used: number, remaining: number } | null>} null before the first run call.
 */
export async function budgetReport(runDir) {
  let raw
  try {
    raw = await readFile(join(runDir, BUDGET_FILE), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const { max } = JSON.parse(raw)
  if (!Number.isSafeInteger(max) || max < 0) {
    throw new Error(`${BUDGET_FILE} has no valid "max"`)
  }
  return budgetStatus(runDir, max)
}
