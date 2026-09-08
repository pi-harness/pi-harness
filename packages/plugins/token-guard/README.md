# @pi-harness/plugin-token-guard

Token Guard — Use descriptor-safe monitoring to issue at most one abort request per run when a context percentage or SDK-reported run-token budget is reached, with bounded errors and a cached normalized panel.

## Install

```sh
npm install --save-exact @pi-harness/plugin-token-guard
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: token-guard
  name: "@pi-harness/plugin-token-guard"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Budget semantics

`maxPercent` is a context-usage threshold from 1 through 100 (default 90). `maxRunTokens` is an integer from 0 through 10000000 (default 0, disabled). The latter counts the SDK-reported input, output, cache-read and cache-write token delta since `agent_start`, including statistics retained across compaction. It is not an invoice, currency limit, tokenizer-exact live counter, or guarantee against exceeding a provider charge. If enabled mid-run, the run-token baseline is unavailable until the next `agent_start`.

Native `message_end` is emitted before that assistant response enters the session statistics. Token Guard adds the finalized response's reported usage at that boundary, allowing it to abort before tools requested by an already budget-exhausting response execute. Subsequent events use the persisted total, without adding the response twice. Unknown or invalid usage is reported as an inspection error or unknown count; it does not invent a token count or block all activity.

The guard samples the first streaming update and every 32 subsequent updates, plus completed message/tool/turn and session events. A single provider request can already exceed the budget before final usage arrives, and cancellation cannot undo completed model requests or tool side effects. At most one abort request is issued per run; an abort error is reported without automatic retries and cannot be attached to a newer run. The panel counts requested aborts, not independently confirmed remote cancellations.

Counters and baselines reset when the active AgentSession or its native session ID changes. Panel polling is cached for the same session, and discovering a replacement session while polling refreshes statistics without issuing an abort. The next runtime inspection event enforces its threshold. Disposal removes observation and the panel; late abort rejections cannot update disposed state.
