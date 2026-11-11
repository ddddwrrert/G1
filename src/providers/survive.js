/**
 * Default population survival provider: keeps the top k alive candidates.
 *
 * @module dsh-evolve-loop/providers/survive
 */

import { alive, merit } from '../population.js'

export const name = 'top-k'
export const DEFAULT_K = 5

/**
 * Cull the population down to the top k alive candidates, ranked by merit().
 * @param {object} population - the population handle.
 * @param {object} evolve - the evolve service.
 */
export async function survive(population, evolve) {
  const { k } = await evolve.context()
  const rows = await population.rows()
  const pool = alive(rows)
  const ranked = pool.sort((a, b) => merit(b.fitness) - merit(a.fitness))
  const survivors = new Set(ranked.slice(0, k ?? DEFAULT_K).map(r => r.id))

  await population.write(rows.map(row => (
    row.survival === 'yes' && !survivors.has(row.id) ? { ...row, survival: 'no' } : row
  )))
}

export default { name, survive }
