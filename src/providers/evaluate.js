/**
 * Default evaluate provider: scores a candidate with its task's evaluator
 * (<task>/evaluator/evaluator.py) through run_evaluator.py, which follows
 * SkyDiscover's Evaluator. The task's settings are in <task>/task.json:
 * `program` (the file that evolves), `timeout` and `max_retries` (as in
 * SkyDiscover's evaluator config), `sandbox` (whether the evaluator runs in
 * DSH's sandbox) and `env` (environment for the evaluator).
 *
 * @module dsh-evolve-loop/providers/evaluate
 */

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'python-subprocess'

const RUNNER = fileURLToPath(new URL('./run_evaluator.py', import.meta.url))
const STDOUT_MAX_BYTES = 1024 * 1024
const STDERR_MAX_BYTES = 64 * 1024
const GRACE_MS = 2000
// run_evaluator.py enforces the task's timeout; this only ends a runner that outlives all its attempts.
const RUNNER_MARGIN_MS = 60_000

/**
 * Score a candidate: the evaluator's result is saved to run/evals/<id>.json and its fitness returned.
 * @param {{ id: string, dir: string }} candidate
 * @param {object} evolve - the evolve service.
 * @returns {Promise<number>}
 */
export async function evaluate(candidate, evolve) {
  const { task, agent, signal } = evolve.currentRun()
  const ctx = evolve.ctx
  const settings = JSON.parse(await readFile(join(task, 'task.json'), 'utf8'))

  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('the default evaluate needs the subprocess service')
  const python = await subprocess.resolveExecutable('python', undefined, signal)

  // The evaluator's temporary files, and the only place it may write when sandboxed.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'evolve-eval-')))
  try {
    let argv = [python, '-B', RUNNER, task, join(candidate.dir, settings.program)]
    if (settings.sandbox) {
      const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      if (policy !== undefined && policy.mode !== 'danger-full-access') {
        const sandbox = ctx.get('sandbox')
        if (sandbox === undefined) throw new Error(`sandbox mode "${policy.mode}" needs the sandbox service`)
        argv = (await sandbox.confine(argv, { ...policy, workspaceRoot: scratch }, signal)).argv
      }
    }

    const limitMs = settings.timeout * (settings.max_retries + 1) * 1000 + RUNNER_MARGIN_MS
    const handle = subprocess.spawn({
      argv,
      cwd: join(task, 'evaluator'),
      env: { ...settings.env, TMPDIR: scratch },
      stdio: { stdin: 'ignore', stdout: { maxBytes: STDOUT_MAX_BYTES }, stderr: { maxBytes: STDERR_MAX_BYTES } },
      graceMs: GRACE_MS,
      signal: AbortSignal.any([signal, AbortSignal.timeout(limitMs)]),
    })
    const outcome = await handle.done
    signal.throwIfAborted()

    const stdout = handle.collected.stdout.readFrom(0).text.trim()
    if (outcome.exitCode !== 0 || stdout === '') {
      const stderr = handle.collected.stderr.readFrom(0).text.trim()
      throw new Error(`the evaluator of ${task} did not run on ${candidate.id} `
        + `(exit ${String(outcome.exitCode ?? outcome.signal)})${stderr === '' ? '' : `:\n${stderr.slice(-2000)}`}`)
    }
    const result = JSON.parse(stdout.split(/\r?\n/).pop())
    await evolve.files.write(`evals/${candidate.id}.json`, `${JSON.stringify(result, null, 2)}\n`)
    return result.fitness
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export default { name, evaluate }
