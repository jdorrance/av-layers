# Nested complexity

Keep the reachable surface small. Nest detail behind it. Shake off anything no
current caller, reader, or check reaches. YAGNI, KISS, and DRY are that cut:
build the present need, keep it plain, and give each fact one owner. Fast
execution and low compute cost are a priority on that same surface: move fewer
bytes, use less CPU, and hold less memory. Apply this to code, types, docs,
tests, commands, comments, config, and UI.

- Read the nearest README and public types before implementation files.
  [Architecture](docs/architecture.md) owns the workspace map.
- Keep entry points small. State purpose, inputs, outputs, and ownership.
  Keep helpers private.
- Keep required units, absence, errors, and lifecycle at the boundary. Put
  algorithms, provenance, and troubleshooting one layer in.
- Give each fact one owner. Generate signatures from code. Link to that owner
  from the next doc, comment, or module.
- Extract around a distinct responsibility that reduces what the caller must
  hold. Prefer a direct call when a new file would only forward.
- Keep one decision in view: one function, one paragraph, one screen region.
  Split when a reader would otherwise track two jobs.
- Spend work only on what a current caller needs. Bound time, memory,
  concurrency, and bytes with the [build budgets](apps/batch/src/capacity.ts)
  and [serving budgets](docs/serving-budgets.md). A path that keeps the forecast
  result and does less work replaces the heavier one. Raise a limit only with
  a measurement.
- GFS, ICON-EU, and the current layers are the implemented scope. A new model or product waits
  for a real caller and follows [extensions](docs/extensions.md).
- Remove unreachable code, exports, docs, and comments in the change that
  leaves them unreached. A comment records an obligation the code cannot state.
- Preserve public contracts and forecast behavior during structural edits.
  Validate with the [root checks](README.md#development-checks).
