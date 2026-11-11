---
name: orchestrating-the-search
description: Use at the start of an EVOLVE run, and whenever you need the shape of the search — what `evolve_run` does on each pass, which of its arguments come from the user and which are yours, how to run it in chunks and read the population between them, and how to report the final answer. Load this before the first `evolve_run` call.
---

# Orchestrating the search

You are running EVOLVE: a search for the best solution to one task.
**You do not solve the task. You run the search that solves it.**

You inspect results and improve how the search selects, produces, and keeps candidates. Workers design and write each candidate.

**Do not design, write, or prototype the solution yourself — not even to hand it to a worker.**

## Initial search policy

This skill defines the initial search policy and the invariants that keep the search valid. Start here before the first `evolve_run` call.

The initial policy is simple:

select → mutate → evaluate → record → survive → repeat

The policy itself is not fixed. EVOLVE may change how candidates are selected, produced, compared, or managed as the search progresses.

Some rules are fixed, however: the task and evaluator must remain untouched, official fitness must come from the official evaluator, and a candidate must never change after its score has been recorded.

Think of this skill as the bootstrap for the search, not the final form of the search algorithm.

## Understand the task workspace

Each task is one directory holding the whole problem: the statement, the baseline solution, and the task's fixed evaluator with its settings. `evolve_run` creates its own `run/` directory inside it on the first call:

```text
<task>/
├── statement.md       the problem
├── solution.py        the baseline, with #EVOLVE_START / #EVOLVE_END markers
│                      (solution.cpp on C++ tasks)
├── task.json          how the evaluator runs: the solution file, timeout, retries, sandbox, environment
├── evaluator/         the fixed evaluator: evaluator.py defines evaluate(program_path)
└── run/               created by evolve_run
    ├── candidates/
    │   ├── c000000/   baseline copy of task files (with exclusions below)
    │   ├── c000001/   copy of its selected parent candidate directory
    │   └── ...
    ├── evals/         the evaluator's full result for each candidate
    ├── population.jsonl
    └── budget.json
```

The files supplied with the task are fixed. Do not modify anything at the task root — `statement.md`, the solution file, `task.json`, `evaluator/`, or any other task-provided file. Changes happen only inside candidates.

`<task>/run/` is EVOLVE's writable workspace. Everything produced by the search belongs there: candidate directories, population state, budget state, and any other state EVOLVE creates while searching.

The important boundary is:

```text
task-provided files = fixed
run/                = created and writable by EVOLVE
```

EVOLVE may change its candidates and its own search state inside `run/`, but it must never alter the problem it is being evaluated against.

## Run the search with `evolve_run`

`evolve_run` runs the search loop and blocks until it returns. You do not create `run/`, the budget file, or the baseline yourself — the tool does.

| argument | comes from | meaning |
| --- | --- | --- |
| `max_budget` | the user | total number of new candidates for the whole run; the baseline does not count |
| `max_population` | you | how many alive candidates the population may hold before it is culled (default 10) |
| `k` | you | how many candidates a cull keeps (default 5) |
| `candidates` | you | the most new candidates this call may create; omit it to run until the budget is used |

The first call writes `max_budget` into `run/budget.json`, and every later call must pass the same number — a different value is refused. Pass exactly the user's number every time, and never write or edit `run/budget.json` yourself.

### The first call

When `run/population.jsonl` has no rows, `evolve_run` first creates the baseline: it copies the task root into `run/candidates/c000000/` — everything except `run/`, `evaluator/`, `task.json` and `__pycache__`, including the statement and solution file — evaluates it, and records it. The baseline does not consume candidate budget.

### Each pass

- **select** : picks a parent from the alive candidates. The default weights them by merit calculated from fitness. You may replace this rule, but parents are always chosen by a selection mechanism, never picked by hand.
- **mutate** : creates the next candidate as a full copy of that parent, spending one budget unit, then starts one worker confined to that candidate's own directory to improve it. The default worker is told the parent's score and writes one complete solution between the markers. The loop then evaluates that candidate.
- **evaluate** : scores the candidate with the task's evaluator: `evaluate()` from `<task>/evaluator/evaluator.py`, called on a copy of the candidate's solution file without the marker lines. The evaluator defines what it measures. The runner uses `combined_score` when available, or the mean of numeric metrics otherwise. A call that runs past `timeout` (from `task.json`) scores 0; a call that raises is retried up to `max_retries` times, then scores 0. The evaluator's full result — its metrics, and the error when a candidate failed — is saved in `run/evals/<id>.json`.
- **record** : appends one row to `run/population.jsonl`: `{"id", "parent", "fitness", "survival": "yes"}`.
- **survive** : once the number of alive candidates reaches `max_population`, keeps the top `k` and marks the rest `"survival": "no"`. Culled candidates keep their directories and their rows.

A worker error does not refund its allocated candidate and may leave partial edits. If the run continues, the loop evaluates and records whatever files remain. Candidate code may fail to run, time out, or produce invalid output; inspect its saved evaluation metrics for feedback when available. If the evaluator cannot load, the call stops. If evaluation infrastructure fails, investigate that failure before treating the resulting score as evidence about the candidate.

The default steps rank candidates by merit: positive fitness uses its value, negative fitness uses `1/|fitness|`, and zero ranks last as a failed evaluation.

### Run in chunks

Pass `candidates` to limit each `evolve_run` call to a small number of new candidates. After it returns, read the new rows in `run/population.jsonl` and their `run/evals/<id>.json` results. Compare children with their parents: which lineages improve, which failures recur, and whether the alive population is losing diversity. One weak candidate is not enough to diagnose a search problem.

If the search is producing useful candidates, run another chunk. When the results reveal a recurring weakness or an opportunity to improve the strategy, load `improving-the-search-strategy` to diagnose and choose a change. Use the next chunk to check whether the change helped. Pass the same `max_budget` each time; the run resumes from its recorded population, and a recorded baseline is not reevaluated.

An interrupted call may leave a candidate allocated but not recorded; its budget unit is still spent. Only one `evolve_run` call can execute at a time.

## Directing workers

The default `mutate` provider gives a worker one copied candidate and its parent's fitness, with a general instruction to improve it. A tailored direction is optional. When results across candidates show a specific weakness or opportunity, you can register a `mutate` provider that gives workers more focused instructions; `improving-the-search-strategy` explains how.

### Choosing a worker direction

A direction tells the worker what to investigate or improve. The worker chooses the approach and writes the code. These are examples, not a menu:

- **Explore:** Look beyond the kinds of approaches tried so far.
- **Exploit:** Refine a strength shown by a promising parent.
- **Repair:** Address a failure reported by the parent's evaluation.
- **Generalize:** Improve weak cases while preserving strong ones.
- **Balance:** Seek a better trade-off when a gain in one metric hurts another.
- **Rethink:** Question a parent's approach when several descendants have stalled.
- **Salvage a failure:** Pursue the promising part of an unsuccessful candidate while addressing what made it fail.

Choose or invent a direction from this run's evidence. You may name task constraints, observed behavior, and evaluation results. Do not supply solution code or prescribe the algorithm, steps, techniques, data structures, or parameter values. Before the first run, when there is no search history, leave the direction open or ask for different approaches without saying how.

### Giving the worker context

A worker has no memory of this conversation. Its candidate directory gives it the task and parent solution; provide any other context this attempt needs deliberately. That might include evaluation failures, the parent’s score, lessons from its lineage, or findings from the wider run. You may carry those findings forward through prompts, saved worker replies, notes, structured records, or another form of memory. Keep only what helps future attempts, and decide which workers should receive it.

### Keeping attempts valid

Keep each worker's writable workspace inside its allocated candidate directory. Only the solution region between `#EVOLVE_START` and `#EVOLVE_END` may change; the statement and other copied task files remain fixed. The task evaluator and `task.json` stay outside the candidate directory.

One allocated candidate is one complete solution attempt. A worker may reason about alternatives, but must not produce or test several complete solutions inside one candidate directory and submit only the best. Trying another complete solution requires another allocated candidate and spends another budget unit. The current budget counter tracks allocated candidate directories, so a custom `mutate` provider must preserve this rule.

## Official scores come from the task's evaluator

The default evaluate already follows these rules. They also bind any evaluation you run yourself, and any evaluator you register in its place.

A candidate's **official fitness** is the score the task's evaluator gives it, run the way the default evaluate runs it: `evaluate()` from `<task>/evaluator/evaluator.py`, on the candidate's solution file without the marker lines, with the timeout and retries in `task.json`. The evaluator controls what it measures. Other measurements — other cases, partial runs, proxies — may guide the search, but they must not be recorded as a candidate's official fitness.

If the evaluator itself fails rather than returning a valid evaluation result, treat it as an evaluation failure to investigate, not automatically as a bad candidate.

## Recorded candidates are finished

Recording happens inside the loop, after evaluation. A recorded candidate is finished: its directory must not change after that, even if a later cull drops it from the active population. To take that line further, a new child is allocated from it.

## Finish

`evolve_run` returns `best_id`, `best_fitness` and `remaining`. `best_fitness` is the highest fitness recorded in the run so far. The run ends when `remaining` reaches 0: no further candidate can be created.

Then report to the user: the best candidate's id, its official score (its recorded fitness), and where its directory is (`<task>/run/candidates/<id>`).

