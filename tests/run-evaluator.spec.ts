import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const RUNNER = fileURLToPath(new URL('../src/providers/run_evaluator.py', import.meta.url))
const FIXTURE_ROOT = fileURLToPath(new URL('../.test-runs/', import.meta.url))

let task: string

beforeEach(async () => {
  await mkdir(FIXTURE_ROOT, { recursive: true })
  task = await realpath(await mkdtemp(join(FIXTURE_ROOT, 'runner-')))
  await mkdir(join(task, 'evaluator'))
})

afterEach(async () => {
  await rm(task, { recursive: true, force: true })
})

/** Run the runner on a C++ program, with `body` as the task's evaluator.py. */
async function run(body: string, settings: Record<string, number> = {}) {
  await writeFile(join(task, 'task.json'), JSON.stringify({ timeout: 30, max_retries: 3, ...settings }), 'utf8')
  await writeFile(join(task, 'evaluator', 'evaluator.py'), body, 'utf8')
  await writeFile(join(task, 'solution.cpp'), '#EVOLVE_START\nint main() {}\n#EVOLVE_END\n', 'utf8')
  const started = Date.now()
  const child = spawnSync('python', ['-B', RUNNER, task, join(task, 'solution.cpp')], { encoding: 'utf8' })
  return { ...child, seconds: (Date.now() - started) / 1000 }
}

describe('run_evaluator.py', () => {
  it('passes the program without our markers, with its suffix, and prints only the result line', async () => {
    const { status, stdout, stderr } = await run([
      'from pathlib import Path',
      'def evaluate(program_path):',
      '    print("evaluator noise")',
      '    path = Path(program_path)',
      '    return {"combined_score": 7, "suffix": path.suffix, "code": path.read_text()}',
    ].join('\n'))

    expect(status).toBe(0)
    expect(stdout.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(stdout)).toEqual({
      fitness: 7,
      metrics: { combined_score: 7, suffix: '.cpp', code: 'int main() {}\n' },
    })
    expect(stderr).toContain('evaluator noise')
  })

  it('retries an evaluator that raises, then scores 0', async () => {
    const { status, stdout, stderr } = await run([
      'calls = []',
      'def evaluate(program_path):',
      '    calls.append(1)',
      '    raise RuntimeError(f"boom {len(calls)}")',
    ].join('\n'), { max_retries: 1 })

    expect(status).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ fitness: 0, metrics: { error: 0 } })
    expect(stderr).toContain('attempt 1 of 2')
    expect(stderr).toContain("attempt 2 of 2: RuntimeError('boom 2')")
  })

  it('ends a late evaluation as a timeout, without retrying', async () => {
    const { status, stdout, stderr, seconds } = await run([
      'import time',
      'def evaluate(program_path):',
      '    time.sleep(20)',
      '    return {"combined_score": 1}',
    ].join('\n'), { timeout: 1 })

    expect(status).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ fitness: 0, metrics: { error: 0, timeout: true } })
    expect(stderr).not.toContain('attempt')
    expect(seconds).toBeLessThan(10)
  })

  it('scores a result without combined_score by the mean of its numeric metrics', async () => {
    const { stdout } = await run([
      'def evaluate(program_path):',
      '    return {"a": 2, "b": 4.0, "flag": True, "note": "text"}',
    ].join('\n'))

    expect(JSON.parse(stdout).fitness).toBe(3)
  })

  it('fails when the evaluator cannot be loaded', async () => {
    const { status, stdout, stderr } = await run('raise ImportError("missing package")\n')

    expect(status).not.toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('missing package')
  })
})
