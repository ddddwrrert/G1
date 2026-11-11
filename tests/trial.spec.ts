import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writePopulation } from '../src/population.js'
import {
  assertActivationAllowed,
  assertDeactivationAllowed,
  closeTrial,
  finishContrast,
  lastFitnesses,
  loadTrial,
  openTrial,
  recordTaskRollout,
  restoreSnapshotPopulation,
  STATES,
} from '../src/trial.js'

const FIXTURE_ROOT = fileURLToPath(new URL('../.test-runs/', import.meta.url))

let tmpDir: string
let runDir: string

const stacks = {
  loop: ['evolve-loop'],
  select: ['fitness-proportional'],
  mutate: ['candidate-builder'],
  evaluate: ['python-subprocess'],
  survive: ['top-k'],
}

beforeEach(async () => {
  await mkdir(FIXTURE_ROOT, { recursive: true })
  tmpDir = await realpath(await mkdtemp(join(FIXTURE_ROOT, 'trial-')))
  runDir = join(tmpDir, 'run')
  await mkdir(runDir, { recursive: true })
  await writePopulation(runDir, [
    { id: 'c000000', parent: null, fitness: 10, survival: 'yes' },
    { id: 'c000001', parent: 'c000000', fitness: 20, survival: 'yes' },
  ])
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('ProviderTrial core (Approach A)', () => {
  it('opens a window, snapshots population, and refuses a second open', async () => {
    const trial = await openTrial(runDir, {
      slot: 'select',
      plugin_id: 'evoabcd',
      package_id: 'pkg1',
      K: 4,
      delta: 0,
      providers_before: stacks,
      budget_remaining: 10,
      tip: { id: 'c000001', fitness: 20 },
    })
    expect(trial.state).toBe(STATES.open)
    expect(trial.k_per_arm).toBe(2)
    expect(trial.policy).toBe('A')

    const snap = await readFile(join(runDir, 'trial', 'snapshot', 'population.jsonl'), 'utf8')
    expect(snap).toContain('c000001')

    await expect(openTrial(runDir, {
      slot: 'mutate',
      plugin_id: 'evoother',
      package_id: 'pkg2',
      K: 2,
      providers_before: stacks,
      budget_remaining: 10,
      tip: null,
    })).rejects.toThrow(/already open/)
  })

  it('rejects evaluate slot and odd K', async () => {
    await expect(openTrial(runDir, {
      slot: 'evaluate',
      plugin_id: 'evoabcd',
      package_id: 'pkg1',
      K: 4,
      providers_before: stacks,
      budget_remaining: 10,
      tip: null,
    })).rejects.toThrow(/loop\|select\|mutate\|survive/)

    await expect(openTrial(runDir, {
      slot: 'select',
      plugin_id: 'evoabcd',
      package_id: 'pkg1',
      K: 3,
      providers_before: stacks,
      budget_remaining: 10,
      tip: null,
    })).rejects.toThrow(/even integer/)
  })

  it('records Task-only rollouts without affecting contrast admission', async () => {
    await openTrial(runDir, {
      slot: 'select',
      plugin_id: 'evoabcd',
      package_id: 'pkg1',
      K: 2,
      providers_before: stacks,
      budget_remaining: 10,
      tip: { id: 'c000001', fitness: 20 },
    })
    const row = await recordTaskRollout(runDir, { best_id: 'c000099', best_fitness: 999 })
    expect(row?.kind).toBe('task_only')

    const finished = await finishContrast(runDir, {
      control: [10],
      treatment: [12],
      trial_used: 2,
    })
    expect(finished.contrast.passed).toBe(true)
    expect(finished.contrast.treatment_mean).toBe(12)
    expect(finished.contrast.control_mean).toBe(10)

    const { admitted, certificate } = await closeTrial(runDir, {
      commit_providers: { ...stacks, select: ['fitness-proportional', 'tournament'] },
      reject_providers: stacks,
    })
    expect(admitted).toBe(true)
    expect(certificate.note).toMatch(/Task-only/)
    expect(certificate.providers_after.select).toContain('tournament')
    expect((await loadTrial(runDir)).state).toBe(STATES.idle)

    const certs = await readFile(join(runDir, 'trial', 'certificates.jsonl'), 'utf8')
    expect(certs).toContain('"admitted":true')
  })

  it('rejects when treatment mean does not beat control + delta', async () => {
    await openTrial(runDir, {
      slot: 'mutate',
      plugin_id: 'evoabcd',
      package_id: 'pkg1',
      K: 4,
      delta: 1,
      providers_before: stacks,
      budget_remaining: 10,
      tip: null,
    })
    await finishContrast(runDir, {
      control: [10, 10],
      treatment: [10.5, 10.5],
      trial_used: 4,
    })
    const { admitted, certificate } = await closeTrial(runDir, {
      commit_providers: stacks,
      reject_providers: stacks,
    })
    expect(admitted).toBe(false)
    expect(certificate.admitted).toBe(false)
  })

  it('restores the population snapshot', async () => {
    await openTrial(runDir, {
      slot: 'select',
      plugin_id: 'evoabcd',
      package_id: 'pkg1',
      K: 2,
      providers_before: stacks,
      budget_remaining: 10,
      tip: null,
    })
    await writePopulation(runDir, [
      { id: 'c000000', parent: null, fitness: 10, survival: 'yes' },
      { id: 'c000099', parent: 'c000000', fitness: 99, survival: 'yes' },
    ])
    const restored = await restoreSnapshotPopulation(runDir)
    expect(restored.map(r => r.id)).toEqual(['c000000', 'c000001'])
  })

  it('gates activate/deactivate while a trial owns the stacks', async () => {
    assertActivationAllowed({ state: STATES.idle }, { plugin_id: 'x' })

    const open = {
      state: STATES.open,
      plugin_id: 'evoabcd',
      package_id: 'pkg1',
    }
    expect(() => assertActivationAllowed(open, { plugin_id: 'other' })).toThrow(/evoabcd/)
    assertActivationAllowed(open, { plugin_id: 'evoabcd', package_id: 'pkg1' })
    expect(() => assertDeactivationAllowed(open, { plugin_id: 'evoabcd' })).toThrow(/frozen/)

    const contrasted = { state: STATES.contrasted }
    expect(() => assertActivationAllowed(contrasted, { plugin_id: 'evoabcd' })).toThrow(/evolve_trial_close/)
    expect(() => assertDeactivationAllowed(contrasted, { plugin_id: 'evoabcd' })).toThrow(/evolve_trial_close/)
  })

  it('lastFitnesses returns the trailing scored rows', () => {
    expect(lastFitnesses([
      { fitness: 1 },
      { fitness: null },
      { fitness: 3 },
      { fitness: 5 },
    ], 2)).toEqual([3, 5])
  })
})
