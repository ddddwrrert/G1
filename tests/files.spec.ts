import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filesOf } from '../src/files.js'

const FIXTURE_ROOT = fileURLToPath(new URL('../.test-runs/', import.meta.url))

let tmpDir: string
let runDir: string
let files: any

beforeEach(async () => {
  await mkdir(FIXTURE_ROOT, { recursive: true })
  tmpDir = await realpath(await mkdtemp(join(FIXTURE_ROOT, 'files-')))
  runDir = join(tmpDir, 'run')
  files = filesOf(runDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('run-scoped file store', () => {
  it('writes and reads text, creating parent directories', async () => {
    const written = await files.write('reports/gen-1.json', '{"best":42}')

    expect(written).toBe(join(runDir, 'reports', 'gen-1.json'))
    expect(await readFile(written, 'utf8')).toBe('{"best":42}')
    expect(await files.read('reports/gen-1.json')).toBe('{"best":42}')
  })

  it('replaces an existing file on write', async () => {
    await files.write('notes.txt', 'first')
    await files.write('notes.txt', 'second')

    expect(await files.read('notes.txt')).toBe('second')
  })

  it('leaves no temporary files behind', async () => {
    await files.write('notes.txt', 'first')

    expect(await files.list()).toEqual(['notes.txt'])
  })

  it('reads undefined for a missing file', async () => {
    expect(await files.read('missing.json')).toBeUndefined()
  })

  it('appends, creating the file when absent', async () => {
    await files.append('logs/run.log', 'one\n')
    await files.append('logs/run.log', 'two\n')

    expect(await files.read('logs/run.log')).toBe('one\ntwo\n')
  })

  it('lists entries sorted, with a trailing slash for directories', async () => {
    await files.write('b.txt', 'b')
    await files.write('a.txt', 'a')
    await files.write('sub/c.txt', 'c')

    expect(await files.list()).toEqual(['a.txt', 'b.txt', 'sub/'])
    expect(await files.list('sub')).toEqual(['c.txt'])
  })

  it('lists [] for a missing directory', async () => {
    expect(await files.list('nowhere')).toEqual([])
  })

  it('reports existence and removes files and trees', async () => {
    await files.write('sub/c.txt', 'c')

    expect(await files.exists('sub/c.txt')).toBe(true)
    expect(await files.exists('sub/missing.txt')).toBe(false)

    await files.remove('sub')
    expect(await files.exists('sub')).toBe(false)
    // Removing something absent is not an error.
    await files.remove('sub')
  })

  it('resolves a relative path against the run root', () => {
    expect(files.resolve('reports/gen-1.json')).toBe(join(runDir, 'reports', 'gen-1.json'))
    expect(files.root).toBe(runDir)
  })

  it('rejects paths that are empty, absolute, or escape the run directory', async () => {
    await expect(files.write('', 'x')).rejects.toThrow(/non-empty relative path/)
    await expect(files.write(join(tmpDir, 'outside.txt'), 'x')).rejects.toThrow(/must be relative/)
    await expect(files.write('../outside.txt', 'x')).rejects.toThrow(/must stay inside/)
    await expect(files.read('sub/../../outside.txt')).rejects.toThrow(/must stay inside/)
    await expect(files.write('bad\0name.txt', 'x')).rejects.toThrow(/must not contain NUL/)
  })

  it('does not write outside the run directory', async () => {
    await writeFile(join(tmpDir, 'outside.txt'), 'original', 'utf8')

    await expect(files.write('../outside.txt', 'overwritten')).rejects.toThrow(/must stay inside/)
    expect(await readFile(join(tmpDir, 'outside.txt'), 'utf8')).toBe('original')
  })

  it('is a frozen handle', () => {
    expect(Object.isFrozen(files)).toBe(true)
  })
})
