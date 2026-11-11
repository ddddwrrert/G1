---
name: writing-search-plugins
description: Write, activate, repair, update, or remove the dynamic plugins that change the search at runtime — host code that registers evolve providers — with evolve_define, evolve_activate, evolve_deactivate, and evolve_plugins. Use it before writing any search plugin code.
---

# Write search plugins

A search plugin is host JavaScript that runs in DSH's dynamic plugin sandbox and changes the search through the `evolve` service. Query the real interface before writing code. Never infer an API from a service name or an example.

## Workflow

1. Call `cordis_inspect_list`, then the smallest set of `cordis_inspect_query` calls for what the code will use: the `evolve` service through `Service.listService`, any other service, and `Builtin.listBuiltins` for globals.
2. Write the host code and call `evolve_define`. It records a new plugin, or a new immutable version when you pass `plugin_id`. Nothing runs yet. Fix every warning it returns before activating.
3. Call `evolve_activate` with the `plugin_id`. It starts the newest version, or switches a running plugin to it. Read `changed`: it lists the slots whose provider stack changed. An activation that changed nothing comes back with a warning.
4. Run the next `evolve_run` chunk; it uses the active providers. When you need to know whether the new provider is a better *search tip* (not just Task progress), use `evolve_trial_open` → `evolve_trial_contrast` → `evolve_trial_close` instead of raw activate + evolve_run (Approach A; see `improving-the-search-strategy`).
5. `evolve_deactivate` stops the plugin and the previous provider comes back. `remove: true` also deletes every version. Deactivate is refused while a provider trial window is open.

`evolve_plugins` lists this session's plugins, their versions, which one runs, the last failure, and every slot's stack. Activation and deactivation are refused while `evolve_run` executes. Plugins belong to this session and disappear when DSH restarts.

## The code

The code is a plain JavaScript function body that returns a Cordis plugin object. It is not compiled.

Do not use `import`, `require`, TypeScript, decorators, JSX, or globals not confirmed by `Builtin.listBuiltins`. `window`, `document`, `process`, `Buffer`, `fetch`, native timers, and `node:fs` do not exist here.

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

- **`inject: ['evolve']`** makes `evolve` a hard dependency: the plugin waits until it exists, and `ctx.evolve` is allowed. Reading `ctx.x` without declaring `x` in `inject` is rejected. For an optional service, use `ctx.get('x')` and handle `undefined`.
- **Register inside `ctx.effect`.** `evolve.register` returns a disposer; `ctx.effect` owns it, so stopping, updating, or removing the plugin removes the provider. Registered outside `ctx.effect`, the provider stays after deactivation.
- **Give every provider a `name`.** It is what `evolve_status`, `evolve_plugins`, and `changed` show.
- **No side effects outside `apply()`.** Register event listeners with `ctx.on()`, and own every other subscription with `ctx.effect()`.
- **Persist search state with `evolve.files`**, never `node:fs` or `ctx.fs`.
- **Timers** are the `timer` service, not a builtin: query it, declare `inject: ['timer']`, then use `ctx.timeout(fn, ms)` or `ctx.interval(fn, ms)`.

The slots, the methods each provider implements, the `evolve` operations a provider may call, and the rules a provider must keep are in `improving-the-search-strategy`. Load it before replacing a provider.

## Live data

Services, event payloads, and DSH objects are live runtime data. Do not `JSON.stringify`, `structuredClone`, or recursively copy them, and do not keep them in long-lived plugin state. Read the scalar fields you need.

## Versions, update, and rollback

- A plugin is the stable instance (`plugin_id`); a version is an immutable package (`package_id`).
- To change a plugin, call `evolve_define` with its `plugin_id` and the complete new code, then `evolve_activate`. Never create a second plugin for the same change: two plugins registering the same slot stack on top of each other.
- To go back, call `evolve_activate` with the older `package_id`.
- A failed update leaves the plugin stopped. Activate the last working `package_id` again to restore it.

## Failures

`evolve_activate` returns `ok: false` with `reason`, `message`, and usually `stack`. `evolve_plugins` shows the last failure of every plugin.

| Failure | Check first |
| --- | --- |
| `service "x" is not injected` | `ctx.x` used without `inject: ['x']`; declare it, or use `ctx.get('x')` with an absence check |
| `cannot get property "timer" without inject` | Declare `inject: ['timer']` |
| `host-half-failed` with a syntax error | `import`, `require`, TypeScript, JSX, or an unavailable global |
| Warning: waiting for services that do not exist | A name in `inject` is misspelled or not mounted; query `Service.listService` |
| Warning: no search slot changed | `evolve.register` is never called, or is called for an invalid slot |
| The provider stays after deactivation | `evolve.register` is outside `ctx.effect` |
| The next `evolve_run` fails in a provider | Read the error, define a fixed version, activate it; or deactivate to restore the previous provider |

After a failure, define a new version under the same `plugin_id`; do not overwrite or duplicate it.
