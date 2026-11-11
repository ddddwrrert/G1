/**
 * Population domain: manages candidate records, parent lineage, and survival state
 * in population.jsonl using crash-safe atomic writes.
 *
 * @module dsh-evolve-loop/population
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const POPULATION_FILE = 'population.jsonl'

/**
 * Read all candidate records from population.jsonl.
 * @param {string} runDir - directory where population.jsonl is stored.
 * @returns {Promise<object[]>} parsed candidate records in chronological order.
 */
export async function readPopulation(runDir) {
  let raw
  try {
    raw = await readFile(join(runDir, POPULATION_FILE), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return raw.split('\n').filter(line => line.trim() !== '').map((line, index) => {
    try {
      return JSON.parse(line)
    } catch {
      throw new Error(`dsh-evolve-loop: ${POPULATION_FILE} line ${String(index + 1)} is not valid JSON`)
    }
  })
}

/**
 * Append one candidate record to population.jsonl.
 * @param {string} runDir - directory where population.jsonl is stored.
 * @param {object} record - candidate record { id, parent, fitness, survival, ... }.
 */
export async function appendPopulation(runDir, record) {
  await mkdir(runDir, { recursive: true })
  await appendFile(join(runDir, POPULATION_FILE), `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * Atomically rewrite population.jsonl (used when culling updates survival flags).
 * Uses a unique temporary file and rename to prevent corruption on crash.
 * @param {string} runDir - directory where population.jsonl is stored.
 * @param {object[]} records - complete updated list of candidate records.
 */
export async function writePopulation(runDir, records) {
  await mkdir(runDir, { recursive: true })
  const content = records.map(record => `${JSON.stringify(record)}\n`).join('')
  const tmpPath = join(runDir, `${POPULATION_FILE}.${String(Date.now())}.${String(Math.random().toString(36).slice(2))}.tmp`)
  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, join(runDir, POPULATION_FILE))
}

/**
 * Filter the records down to those currently alive (survival === 'yes').
 * @param {object[]} records
 * @returns {object[]}
 */
export function alive(records) {
  return records.filter(record => record.survival === 'yes')
}

/**
 * How good a fitness is, as a weight where bigger is better: the default select, survive and
 * best all rank candidates by it. A fitness of 0 is a failed evaluation and counts as 0, below
 * every real score. A minimize task's evaluator makes its scores negative (-5 beats -20), so
 * those count as 1/|fitness|.
 * @param {number} fitness
 * @returns {number}
 */
export function merit(fitness) {
  return fitness > 0 ? fitness : fitness < 0 ? -1 / fitness : 0
}

/**
 * Return a population handle exposing rows(), append(row), and write(rows).
 * @param {string} runDir
 * @returns {{ runDir: string, rows(): Promise<object[]>, append(row: object): Promise<void>, write(rows: object[]): Promise<void> }}
 */
export function populationOf(runDir) {
  return Object.freeze({
    runDir,
    rows: () => readPopulation(runDir),
    append: row => appendPopulation(runDir, row),
    write: rows => writePopulation(runDir, rows),
  })
}
