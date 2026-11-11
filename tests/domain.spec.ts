import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { alive, appendPopulation, populationOf, readPopulation, writePopulation } from '../src/population.js'
import { budgetStatus, pinBudget, readBudget } from '../src/budget.js'
import { allocateCandidate, candidateId, candidatePath, copyTask, isCandidate } from '../src/candidates.js'

const FIXTURE_ROOT = fileURLToPath(new URL('../.test-runs/', import.meta.url))

let tmpDir: string
let taskDir: string
let runDir: string

beforeEach(async () => {
  await mkdir(FIXTURE_ROOT, { recursive: true })
  tmpDir = await realpath(await mkdtemp(join(FIXTURE_ROOT, 'domain-')))
  taskDir = join(tmpDir, 'task')
  runDir = join(taskDir, 'run')
  await mkdir(taskDir, { recursive: true })
  await writeFile(join(taskDir, 'solution.py'), 'VALUE = 10\n', 'utf8')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('population domain', () => {
  it('reads empty population when file does not exist', async () => {
    expect(await readPopulation(runDir)).toEqual([])
  })

  it('appends and reads candidate records', async () => {
    await appendPopulation(runDir, { id: 'c000000', parent: null, fitness: 10, survival: 'yes' })
    await appendPopulation(runDir, { id: 'c000001', parent: 'c000000', fitness: 20, survival: 'yes' })

    const rows = await readPopulation(runDir)
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe('c000000')
    expect(rows[1].id).toBe('c000001')
  })

  it('filters alive records and performs atomic rewrites', async () => {
    const pop = populationOf(runDir)
    await pop.append({ id: 'c000000', parent: null, fitness: 10, survival: 'yes' })
    await pop.append({ id: 'c000001', parent: 'c000000', fitness: 5, survival: 'no' })

    const rows = await pop.rows()
    expect(alive(rows)).toHaveLength(1)
    expect(alive(rows)[0].id).toBe('c000000')

    await pop.write(rows.map(r => ({ ...r, survival: 'no' })))
    expect(alive(await pop.rows())).toHaveLength(0)
  })
})

describe('budget domain', () => {
  it('pins budget and rejects modification', async () => {
    expect(await pinBudget(runDir, 50)).toBe(50)
    expect(await readBudget(runDir)).toBe(50)
    expect(await pinBudget(runDir, 50)).toBe(50)

    await expect(pinBudget(runDir, 100)).rejects.toThrow(/the budget for this run is already 50/)
  })

  it('computes budget status from candidate directories', async () => {
    await pinBudget(runDir, 10)
    // No candidates yet
    expect(await budgetStatus(runDir, 10)).toEqual({ max: 10, used: 0, remaining: 10 })

    // Baseline c000000 does not consume budget
    await copyTask(runDir, taskDir)
    expect(await budgetStatus(runDir, 10)).toEqual({ max: 10, used: 0, remaining: 10 })

    // Allocate c000001 consumes 1 attempt
    await allocateCandidate(runDir, 10, 'c000000')
    expect(await budgetStatus(runDir, 10)).toEqual({ max: 10, used: 1, remaining: 9 })
  })
})

describe('candidates domain', () => {
  it('formats candidate ids consistently', () => {
    expect(candidateId(0)).toBe('c000000')
    expect(candidateId(1)).toBe('c000001')
    expect(candidateId(999)).toBe('c000999')
  })

  it('copies task into baseline c000000, leaving the evaluator and task.json out', async () => {
    await mkdir(join(taskDir, 'evaluator'))
    await writeFile(join(taskDir, 'evaluator', 'evaluator.py'), 'def evaluate(path): return {}\n', 'utf8')
    await writeFile(join(taskDir, 'task.json'), '{}\n', 'utf8')
    await writeFile(join(taskDir, 'statement.md'), 'Make VALUE large.\n', 'utf8')

    const base = await copyTask(runDir, taskDir)
    expect(base.id).toBe('c000000')
    expect(await isCandidate(runDir, 'c000000')).toBe(true)

    const copiedContent = await readFile(join(base.path, 'solution.py'), 'utf8')
    expect(copiedContent).toBe('VALUE = 10\n')
    expect((await readdir(base.path)).sort()).toEqual(['solution.py', 'statement.md'])
  })

  it('allocates sequential candidates from parent', async () => {
    await copyTask(runDir, taskDir)
    const c1 = await allocateCandidate(runDir, 2, 'c000000')
    expect(c1.id).toBe('c000001')
    expect(c1.used).toBe(1)
    expect(c1.remaining).toBe(1)

    const c2 = await allocateCandidate(runDir, 2, 'c000001')
    expect(c2.id).toBe('c000002')
    expect(c2.used).toBe(2)
    expect(c2.remaining).toBe(0)

    // Exceeding budget throws
    await expect(allocateCandidate(runDir, 2, 'c000002')).rejects.toThrow(/candidate budget exhausted/)
  })
})
