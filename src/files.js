/**
 * Run-scoped file store: a neutral, raw file I/O primitive for search state.
 *
 * A dynamic (sandboxed) Cordis host plugin cannot use `node:fs`, and the harness's
 * `ctx.fs` is a policy-fenced provider: a dynamic plugin calls `writeText` without a
 * per-call sandbox policy, so the fence resolves the deployment default
 * (`workspace-write`, workspace root = `process.cwd()`) and denies writes under the
 * task's `run/` directory with `FS_SANDBOX_DENIED`. This module runs in the plugin's
 * HOST half, where real `node:fs` is available and no policy fences it, so the
 * `evolve.files` handle can persist search state (scores, reports, logs) under
 * `run/` without a subprocess and without escaping the run directory.
 *
 * It is a storage primitive, not a memory or notes abstraction: it moves bytes and
 * paths and carries no search strategy.
 *
 * @module dsh-evolve-loop/files
 */

import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

/**
 * Resolve one relative path against the run root, rejecting anything that escapes it.
 * @param {string} root - absolute run root.
 * @param {string} relPath - relative path inside the run root.
 * @returns {string} the absolute, confined path.
 */
function within(root, relPath) {
  if (typeof relPath !== 'string' || relPath === '') {
    throw new Error('evolve.files: a non-empty relative path is required')
  }
  if (relPath.includes('\0')) throw new Error('evolve.files: a path must not contain NUL')
  if (isAbsolute(relPath)) {
    throw new Error(`evolve.files: a path must be relative to the run directory, got absolute "${relPath}"`)
  }
  const absolute = resolve(root, relPath)
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error(`evolve.files: a path must stay inside the run directory, got "${relPath}"`)
  }
  return absolute
}

/**
 * Create a file store confined to one run directory.
 *
 * Paths are relative to `run/`; absolute paths and `..` escapes are rejected.
 * Writes are atomic (temporary file plus rename), and parent directories are
 * created as needed. `read` returns `undefined` for a missing file, and `list`
 * returns `[]` for a missing directory, so callers can treat absence as a state
 * rather than an error.
 *
 * @param {string} runDir - absolute path of the run directory.
 * @returns {Readonly<object>} a frozen handle: `root`, `resolve`, `write`, `append`, `read`, `list`, `exists`, `remove`.
 */
export function filesOf(runDir) {
  const root = resolve(runDir)
  return Object.freeze({
    root,
    /** Absolute path for one confined relative path. @param {string} relPath @returns {string} */
    resolve: relPath => within(root, relPath),
    /**
     * Atomically write text, replacing any existing file.
     * @param {string} relPath - relative path inside the run directory.
     * @param {string} text - full file contents.
     * @returns {Promise<string>} the absolute path written.
     */
    async write(relPath, text) {
      const absolute = within(root, relPath)
      await mkdir(dirname(absolute), { recursive: true })
      const tmp = `${absolute}.${String(Date.now())}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(tmp, String(text), 'utf8')
      await rename(tmp, absolute)
      return absolute
    },
    /**
     * Append text, creating the file and its parents when absent.
     * @param {string} relPath - relative path inside the run directory.
     * @param {string} text - text to append.
     * @returns {Promise<string>} the absolute path written.
     */
    async append(relPath, text) {
      const absolute = within(root, relPath)
      await mkdir(dirname(absolute), { recursive: true })
      await appendFile(absolute, String(text), 'utf8')
      return absolute
    },
    /**
     * Read text.
     * @param {string} relPath - relative path inside the run directory.
     * @returns {Promise<string | undefined>} the contents, or undefined when the file does not exist.
     */
    async read(relPath) {
      const absolute = within(root, relPath)
      try {
        return await readFile(absolute, 'utf8')
      } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
    },
    /**
     * List one directory, sorted by name; directories carry a trailing slash.
     * @param {string} [relDir] - relative directory inside the run directory; defaults to its root.
     * @returns {Promise<string[]>} entry names, or [] when the directory does not exist.
     */
    async list(relDir = '') {
      const absolute = within(root, relDir === '' ? '.' : relDir)
      let entries
      try {
        entries = await readdir(absolute, { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
      }
      return entries
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        .map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    },
    /**
     * Test whether one path exists.
     * @param {string} relPath - relative path inside the run directory.
     * @returns {Promise<boolean>}
     */
    async exists(relPath) {
      try {
        await stat(within(root, relPath))
        return true
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
    },
    /**
     * Remove one file or directory tree.
     * @param {string} relPath - relative path inside the run directory.
     * @returns {Promise<string>} the absolute path removed.
     */
    async remove(relPath) {
      const absolute = within(root, relPath)
      await rm(absolute, { recursive: true, force: true })
      return absolute
    },
  })
}
