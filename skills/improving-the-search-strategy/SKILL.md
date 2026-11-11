---
name: improving-the-search-strategy
description: Use to design and improve EVOLVE's search strategy during a run. Shape how the search produces, selects, manages, and learns from candidates.
---

# Improving the search strategy

This skill helps you design and improve the search strategy during a run. Use evidence from recent candidates to decide how the search should produce, select, manage, and learn from future attempts. You may revise an existing mechanism or create a new one, then examine the next chunk to see whether it helped. Workers design and edit individual candidates. Keep the task, official evaluator, and candidate budget fixed.

## Diagnose what to improve

Read the recent candidate scores, evaluation findings, lineage, and accounts of how attempts were produced. Look for patterns in what succeeds, what fails, and what the search has yet to try. One weak candidate is little evidence of a search problem. A promising change may still be worth testing while the best score is improving.

Ask what in the search process could explain the pattern. Are promising parents being overlooked? Do workers keep making similar changes or lack useful context? Has the population lost diversity? Are findings from earlier attempts reaching later ones? Are time, tools, and candidate budget being spent where they help? These are examples, not a checklist. The cause or opportunity may be elsewhere.

Choose a change you can connect to the evidence, and consider its cost against the remaining budget. Say what you expect the change to affect, then examine the next chunk for that effect. If the evidence is too thin to choose well, gather more observations before changing the strategy.

## Choose how the search should proceed

The default select → mutate → evaluate → record → survive → repeat loop is a starting strategy. Use your diagnosis to decide what the remaining attempts need to accomplish and which parts of the search are worth revising.

For example, you may change:

* **How the search loop runs:** React to each result when the next choice depends on it, or compare batches before narrowing directions. Maintain separate lineages, expand a search tree , restart from an earlier candidate with lessons retained, shift between exploration and refinement or others, or use another search process.
* **How candidates are produced:** Refinement, repair, redesign, fresh starts, or crossover between candidates, guided by worker directions, prompts, and evaluation findings.
* **How candidates are chosen:** Which parents or search lines receive another attempt, using scores, novelty, complementary strengths, or past productivity. Parents are always chosen by a selection mechanism, never picked by hand. Possible mechanisms include tournament selection, weighted sampling, rank-based selection, novelty- or diversity-aware selection, and bandit policies.
* **How candidates are managed:** Survival, diversity, archives, niches, islands, migration, restarts, and whether weaker candidates remain available as stepping stones.
* **Who does the work:** Worker roles, models, tools, permissions, context, and how workers collaborate. You may create tools or skills when they help workers or the orchestrator.
* **How the search learns:** Which measurements and worker reports it keeps, what lessons it extracts, and how they reach later attempts. Memory may be specific to a candidate or lineage, or shared across the run, through prompts, Markdown notes, reports, or structured records.
* **How work is coordinated:** Which steps run sequentially or in parallel, how workers hand off context, and when planning, review, or verification occurs.
* **How resources are used:** Time, compute, models, and the remaining candidate budget, including when to explore and when to refine promising results.

These are examples, not an exhaustive list. Let the run's evidence guide what you change, including parts of the search not named here. Keep the fixed boundaries below.

## Preserve the fixed boundaries

Improving the search does not permit changing what defines a valid solution or a valid result.

You must not change:

* the task's evaluator (`evaluator/`) or its settings (`task.json`);
* the instances and test data the evaluator scores with;
* the definition of official fitness;
* the candidate budget, or the operations that create candidates — `allocate` and `copyTask`;
* the allowed editable regions of candidate solutions;
* an already recorded candidate, whose recorded score must continue to correspond to exactly the code that was evaluated.

Never create a candidate directory yourself. A directory that `allocate` or `copyTask` did not create is not a candidate, and may not be scored as one, recorded in the population, or returned as the final solution.

Worker reports, diagnostic checks, and other search signals may guide future attempts. Record a candidate's fitness only from the unchanged official evaluator, and choose the final best from those recorded official scores.

A change that bypasses these boundaries has not improved the search; it has invalidated the run.

## Put the strategy into practice

Implement the change your diagnosis calls for. You may revise a provider, create a tool or skill, change how workers are used, or coordinate these parts in a different workflow. Inspect the behavior and interfaces of any runtime component before changing it.

Change the search at runtime with the evolve runtime tools: `evolve_define` records a dynamic plugin, `evolve_activate` starts it or switches it to a newer version, `evolve_deactivate` stops or removes it, and `evolve_plugins` lists what this session has defined. Read the exact runtime APIs with `cordis_inspect_list` and `cordis_inspect_query` before writing code.

Load the `cordis-plugin-development` skill when you need to know how Cordis plugins are written. Its bundle and Plugin Manager workflow is for persistent changes to the whole profile; a search change for this run goes through the evolve runtime tools instead.

Load the `editing-cordis-compositions` skill when the strategy requires changing an agent preset or a composition.

### The current `evolve` runtime interface

`evolve_run` runs the search through the `evolve` service. The service comes from the `dsh-evolve-loop` plugin, installed in the DSH profile — not in the harness checkout — at `${DSH_HOME:-$HOME/.dsh}/profiles/<profile>/node_modules/dsh-evolve-loop/`, with the service in `src/evolve.js` and the default providers in `src/providers/`.

The current service exposes five provider slots, each filled by one active provider:

| slot | default provider | method | returns |
| --- | --- | --- | --- |
| `loop` | `evolve-loop` | `run(args, evolve)` | anything; the default returns `{ best_id, best_fitness, remaining }` |
| `select` | `fitness-proportional` | `select(population, evolve)` | the parent's candidate id |
| `mutate` | `candidate-builder` | `mutate({ parent }, evolve)` | the new candidate `{ id, dir }`, after a worker has worked on it |
| `evaluate` | `python-subprocess` | `evaluate(candidate, evolve)` | the candidate's fitness, a number |
| `survive` | `top-k` | `survive(population, evolve)` | nothing; it rewrites the survival flags |

Every method receives the service as `evolve`. These operations on it are fixed, and a provider may call them — but only while `evolve_run` is executing:

- `allocate(parentId)` — creates the next candidate as a full copy of the parent and spends one budget unit; returns `{ id, dir }`, and refuses when the budget is used up.
- `copyTask()` — creates the baseline `c000000`; returns `{ id, dir }`.
- `population()` — the run's population file: `rows()`, `append(row)`, `write(rows)`.
- `files` — a run-scoped file store for search state: `resolve(path)`, `write(path, text)`, `append(path, text)`, `read(path)` (undefined when absent), `list(dir)`, `exists(path)`, `remove(path)`. Paths are relative to the run directory (`run/`) and cannot escape it.
- `context()` — `{ task, root, k, maxPopulation, candidates, budget: { max, used, remaining } }`.
- `spawnWorker(dir, prompt, options)` — starts one worker confined to `dir` and waits for it; returns `{ text, stopReason }`. `options` may set `label`, `description`, `persona`, `model`, `allowedTools` and `maxDepth`. Workers never get a shell (`bash`/`pwsh`), whatever the options say. Leave `maxDepth` unset: a value of 0 stops the worker from starting at all, and the candidate stays an unchanged copy of its parent.

A loop runs the other steps through the service, which calls whichever provider is active in that slot: `evolve.select(population)`, `evolve.mutate({ parent })`, `evolve.evaluate(candidate)` and `evolve.survive(population)`.

**`allocate` and `mutate` are not interchangeable.** `allocate(parentId)` only creates the candidate directory. `mutate({ parent })` creates it and also has a worker work on it: the default mutate calls `allocate(parent)`, then `spawnWorker` with the default prompt, and returns only after that worker has finished, so a loop that calls `mutate` several times runs those workers one after another. A loop that starts its own workers — several at once, or with its own prompts — must create its candidates with `allocate`. Calling `mutate` and then `spawnWorker` on the same candidate runs two workers on it, one after the other, for a single budget unit.

Persist search state (scores, reports, logs, digests) with `evolve.files`, never with `node:fs` or `ctx.fs`. The dynamic sandbox has no `node:fs`, and `ctx.fs` is policy-fenced: a dynamic plugin calls `writeText` without a per-call sandbox policy, so the fence resolves the deployment default policy (`workspace-write`, workspace root `process.cwd()`) and a write under the run directory fails with `FS_SANDBOX_DENIED`. The `evolve.files` handle runs in the plugin's host half, which has no such fence.

Before replacing anything, look at what is active: `evolve.listProviders()` returns the active provider's name for every slot, and `evolve.getProvider(slot)` returns the provider itself. The default mutate exposes `defaultInstruction(parentFitness)` and `defaultPersona()`, so you can read exactly what workers are told today.

### Replacing a provider

A dynamic plugin's host code returns a plugin object. Inject the `evolve` service and register the provider inside `ctx.effect`, so that stopping the plugin removes it:

```js
return {
  name: 'tournament-select',
  inject: ['evolve'],
  apply(ctx) {
    ctx.effect(() => ctx.evolve.register('select', {
      name: 'tournament',
      async select(population, evolve) {
        const alive = (await population.rows()).filter(row => row.survival === 'yes')
        // choose one of `alive` and return its id
      },
    }))
  },
}
```

1. `evolve_define` with this code as `host_code` returns `{ plugin_id, package_id, warnings }`. Warnings flag code that cannot register a provider as expected; fix them before activating.
2. `evolve_activate` with the `plugin_id` starts it. Its result lists the slots whose provider stack `changed`; an activation that changed nothing comes back with a warning, and a failure comes back with its message and stack.
3. To change it, call `evolve_define` again with the same `plugin_id` and the new code, then `evolve_activate`: the running version is switched to the new one.
4. `evolve_deactivate` stops it, and the provider that was active before comes back; `remove: true` also deletes every version.

The newest registration for a slot is the active one, and the next `evolve_run` call uses it. Both activation and deactivation are refused while `evolve_run` is executing. The plugins belong to this session and disappear when DSH restarts.

### Provider trials (Approach A) — when the change is a new search method

A raw `evolve_activate` + later `evolve_run` gain does **not** prove the new provider is a better search tip: Task progress and Search-method progress are different ledgers. To admit a single-slot provider as the new tip, use the trial tools:

1. `evolve_define` the treatment plugin as usual.
2. `evolve_trial_open` with `slot` (`loop` | `select` | `mutate` | `survive` — never `evaluate`), `plugin_id`, even `K` (>=2), and the pinned `max_budget`. This snapshots population S0, reserves K official evaluations for contrast, and activates the treatment. While open, other `evolve_activate` / `evolve_deactivate` calls are refused; `evolve_run` may still spend only the free (non-reserved) budget, and those scores are **Task-only**.
3. `evolve_trial_contrast` restores S0, runs k=K/2 under Treatment, deactivates treatment, restores S0, runs k under Control, and compares mean fitness (Treatment must beat Control by more than `delta`). Task-only scores are ignored.
4. `evolve_trial_close` commits (re-activates treatment) or rejects, and writes `run/trial/certificates.jsonl`.

`evolve_trial_status` and the `trial` field of `evolve_status` show the window. Prefer this path whenever you need attribution for whether a provider change improved the search itself.

### Rules to preserve when changing providers

The service checks the budget when `allocate` is called, but it does not validate every result or population record a provider produces. Keep these rules when replacing providers:

- **Create each new candidate with `allocate(parentId)`.** Only the baseline comes from `copyTask()`. A replacement mutate must return the candidate it just allocated, not an existing or already recorded candidate.
- **Record only candidates created by `allocate` or `copyTask()`.** If a provider writes population rows directly, keep each row tied to the candidate that was evaluated. Do not change a candidate after recording its score.
- **Use the unchanged official evaluator for fitness.** An evaluate provider must return its finite numeric result. The service does not reject a missing or non-numeric value before it enters the population.
- **Keep each worker confined to its candidate directory.** `spawnWorker` accepts `options.confine`, but do not use it to widen where a worker can write.

### Default behavior to account for

- **The default loop** evaluates the baseline if needed, then repeats selection, mutation, evaluation, recording, and survival while budget remains and the call's `candidates` limit has not been reached. A replacement loop must manage its own progress and stopping conditions. If it repeats without allocating, the budget does not advance.
- **The default select, survive, and loop** rank candidates by `merit(fitness)` from `population.js`. Positive fitness ranks by its value, zero ranks last, and negative fitness ranks by `1/|fitness|`.
- **The default mutate** runs one worker per call and waits for it to finish, and it discards the worker's final reply. If later attempts need worker reports, a replacement mutate can save them with `evolve.files`.

## Learn from the next results

Run another chunk and compare its results with what you expected the change to improve. Look at official scores, evaluation findings, which directions received attempts, and how much budget they used. A single strong or weak candidate may not tell you whether the strategy helped.

Keep, revise, or remove the change based on what you learn. Carry useful findings into later search decisions and worker context.

## Build support for the search

If the run reveals a gap in how you inspect results, retain lessons, coordinate work, or make search decisions, you may create or improve a tool, plugin, skill, prompt, or memory record to address it. Start from a concrete need shown by the search, then use later chunks to see whether the change helps you make better decisions or produce better candidates.
