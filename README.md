# G1

Organon / `dsh-evolve-loop` **完整版**：在原有可热换 provider 的进化搜索之上，加入 **ProviderTrial（Approach A）**——用单槽 Control/Treatment 对比窗把 Task 进度与 Search-tip 准入拆开，解决「换了 provider 分数涨了，却说不清是不是搜索方法变好了」的归因难。

核心入口：`src/trial.js`、`src/trial-tools.js`；工具链 `evolve_trial_open` → `evolve_trial_contrast` → `evolve_trial_close`。

---
# dsh-evolve-loop

Swappable evolutionary search plugin for DeepSeek Harness (DSH). Provides the `evolve` capability seam on Cordis context (`ctx.evolve`) and the model-facing `evolve_run` tool.

## Architecture: Modular Capability Seam

The search is decomposed into modular Service Providers coordinated by the `evolve` service:

1. **`evolve-loop` (`loop`)**: Coordinates iteration cycles, baseline handling, budget consumption, and termination.
2. **`select`**: Selects parent candidate(s) from alive population (default: fitness-proportional roulette wheel).
3. **`mutate`**: Manages candidate generation and directory allocation. Its default provider, `candidate-builder`, uses the confined subagent supplied by `dsh-candidate-builder`.
4. **`evaluate`**: Scores a candidate with the task's evaluator, `evaluate(program_path)` in `<task>/evaluator/evaluator.py`, following SkyDiscover's evaluator: the task's timeout and retries from `<task>/task.json`, fitness from `combined_score`. The full result is kept in `run/evals/<id>.json` (default: `src/providers/run_evaluator.py` in a `python` subprocess).
5. **`survive`**: Population capacity management and culling (default: top-k retention, default k=5).

## Domain Persistence Modules

Instead of a monolithic disk store, on-disk state is partitioned strictly by domain responsibility:

- **`src/population.js`**: Owns `population.jsonl`. Reads records, handles parent lineage, performs atomic crash-safe rewrites during culling, and tracks alive candidates.
- **`src/budget.js`**: Owns `budget.json`. Pins run budgets, counts spent attempts from candidate folders, and tracks remaining units.
- **`src/candidates.js`**: Owns candidate workspaces (`candidates/c000000`, `candidates/c000001`). Copies the task baseline, allocates child directories, and manages path resolution.
- **`src/files.js`**: Owns raw file I/O for search state under the run directory. `evolve.files` exposes `resolve`, `write` (atomic), `append`, `read`, `list`, `exists` and `remove` on paths confined to `run/`. Dynamic (sandboxed) provider code must use it instead of `node:fs` (absent in the sandbox) or `ctx.fs` (policy-fenced without a caller session, so writes under `run/` fail with `FS_SANDBOX_DENIED`); this module runs in the plugin's host half, which has neither restriction.

## Inspecting and Swapping Providers at Runtime

Any Cordis dynamic plugin or preset can inspect the active providers:

```javascript
const providers = ctx.evolve.listProviders()
// {
//   loop: "evolve-loop",
//   select: "fitness-proportional",
//   mutate: "candidate-builder",
//   evaluate: "python-subprocess",
//   survive: "top-k"
// }
```

### Swapping a Provider

To swap selection to tournament selection, an agent can activate a dynamic plugin:

```javascript
export const name = 'custom-tournament-selection'
export const inject = ['evolve']

export function apply(ctx) {
  ctx.effect(() => {
    return ctx.evolve.register('select', {
      name: 'tournament-selection',
      async select(population, evolve) {
        const rows = await population.rows()
        const alive = rows.filter(r => r.survival === 'yes')
        // Custom tournament logic...
        return winnerId
      }
    })
  })
}
```

When the plugin is unloaded or reloaded, Cordis automatically invokes the disposer and restores the previous provider!

### Runtime tools

DSH 0.1.7 ships the dynamic plugin runner (`dynamicCordisRunner`, from `@deepseek-ai/dsh-cordis-host-runner`, mounted by the web profile) for programmatic callers only. This plugin gives the model four tools over it (`src/runtime.js`), scoped to the calling session:

| tool | does |
| --- | --- |
| `evolve_define` | records a dynamic plugin (host code only), or a new version of one; returns `{ plugin_id, package_id, warnings }` |
| `evolve_activate` | starts it, or switches a running plugin to a newer version; returns the slots whose provider stack `changed` |
| `evolve_deactivate` | stops it (`remove: true` also deletes every version); returns the slots that changed back |
| `evolve_plugins` | lists this session's plugins, their versions and last failure, and every slot's provider stack |

The checks: activation and deactivation are refused while `evolve_run` is executing; an activation or deactivation that changed no slot comes back with a warning; `evolve_define` warns about code that never registers a provider, registers it outside `ctx.effect`, or uses `node:fs`. The host code returns a plugin object, for example `{ name, inject: ['evolve'], apply(ctx) { ctx.effect(() => ctx.evolve.register('select', provider)) } }`. Plugins disappear when DSH restarts. `tests/runtime.spec.ts` runs these tools against the real 0.1.7 runner.

### Provider trials (Approach A)

Task progress during a provider change is not the same as Search-method progress. For single-slot admission of a new search tip, use:

| tool | does |
| --- | --- |
| `evolve_trial_open` | snapshot S0, reserve even `K` evals, activate treatment; freeze other activate/deactivate |
| `evolve_trial_contrast` | Control vs Treatment on restored S0 (`k=K/2` each); Search ledger only |
| `evolve_trial_close` | commit or reject from contrast means; write `run/trial/certificates.jsonl` |
| `evolve_trial_status` | read-only window state |

While open, `evolve_run` gains are Task-only (and cannot spend the reserved `K`). Slot `evaluate` cannot be trialled. See `src/trial.js`, `src/trial-tools.js`, and the Provider trials section in `skills/improving-the-search-strategy`.

## The Evolve Mode preset

This bundle also declares the Evolve Mode agent preset: `presets/evolve.patch.yml` inserts one `@deepseek-ai/dsh-agent-preset` row (`id: evolve`), listed in `package.json` under `dsh.bundle.patch`. Its rows follow DSH 0.1.7's creator preset, with the Evolve persona, the skills in `skills/` beside the shipped creator skills, and no `tool-goal`. Installing the plugin installs the preset; there is no preset folder to copy.

## Tool Interface: `evolve_run`

The `evolve_run` tool takes:
- `max_budget`: Total new candidate budget for the entire run (required).
- `max_population` (optional): Population capacity before triggering `survive` (default 10).
- `k` (optional): Survivors to keep during culling (default 5).
- `candidates` (optional): Max candidates to create in this invocation.

### Return Payload

The tool returns a strictly concise, high-signal payload to the LLM to preserve context window economy:

```json
{
  "best_id": "c000004",
  "best_fitness": 92.5,
  "remaining": 7
}
```

Rendered text:
`Best candidate c000004 (fitness 92.5); 7 of budget remaining.`

## On-Disk State (`<task>/run/`)

```text
<task>/run/
├── budget.json          # { "max": 50 }
├── population.jsonl     # {"id":"c000001","parent":"c000000","fitness":85.0,"survival":"yes"}
├── evals/
│   └── c000001.json     # {"fitness": 85.0, "metrics": {...}}: the evaluator's full result
└── candidates/
    ├── c000000/         # Baseline copy of task, without evaluator/ and task.json (0 budget)
    ├── c000001/         # Attempt 1 (1 budget)
    └── ...
```

