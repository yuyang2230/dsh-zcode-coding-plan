# dsh-zcode-coding-plan

[![CI](https://github.com/yuyang2230/dsh-zcode-coding-plan/actions/workflows/ci.yml/badge.svg)](https://github.com/yuyang2230/dsh-zcode-coding-plan/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-5FA04E)](https://nodejs.org)
[![ZCode](https://img.shields.io/badge/ZCode-3.x-8A2BE2)](https://zcode.z.ai/cn/docs)

[中文](README.md) · **English** · [Release notes](https://github.com/yuyang2230/dsh-zcode-coding-plan/releases)

**Subscribed to GLM Coding Plan but only ever use it in another client?** This DeepSeek
Harness desktop plugin puts that already-paid quota to work inside DSH — dispatch heavy
coding tasks through the official ZCode channel for **1.5× (150%) credit**, plus a real
agent (file / Bash / MCP) and native multi-turn sessions.

![Direct API key vs this plugin (via ZCode CLI)](docs/assets/comparison.svg)

> Drives the official ZCode client. **No client modification, no forged requests, no
> limit circumvention.**

**Two tools get registered:**

| Tool | What it does |
| --- | --- |
| `zcode_call` | Dispatch a real agent task to the plan channel, with `resume`-based multi-turn |
| `zcode_quota` | Query plan headroom; paired with the built-in gate for "dispatch only when there's room" |

**Read the comparison before you install** ↓

---

## Why: direct API key vs this plugin

Same GLM Coding Plan key, two very different outcomes.

| Dimension | Direct API key (calling `open.bigmodel.cn/api/anthropic` yourself) | This plugin (via ZCode CLI) |
| --- | --- | --- |
| **Billing** | Draws down your **account balance** (pay-as-you-go, unrelated to the plan) | Draws down **plan credits** (the subscription you already paid for) |
| **ZCode channel multiplier** | N/A — not an official designated tool, so no multiplier applies | **1.5× (150%)** plan credit consumption |
| **Prerequisites** | Any Zhipu API key | **ZCode client installed** + an active **GLM Coding Plan** subscription |
| **Agent capability** | Pure LLM call — only the model's own read/write/execute ability | Native **file / Bash / MCP / Hooks** — a complete agent |
| **Multi-turn** | You implement session state, retries, context trimming | Native `--resume <sessionId>`; the client handles it |
| **Context caching** | None | **Supported** (measured `cacheReadTokens` hits of ~13K–68K) |
| **Credential handling** | You embed the key in your own code | Key lives with the official client; this plugin only routes |
| **Auditability** | No built-in record | ZCode's local `db.sqlite` logs provider / model / token per call |
| **Failure surface** | Yours to maintain | Tied to the ZCode client version (upgrades may change its schema) |

Full billing & capability matrix: **[docs/comparison.md](docs/comparison.md)**.

### When it's worth it

- You **already pay for** GLM Coding Plan but never use it from DSH → the plan is idling; this plugin puts it to work.
- You want to outsource **multi-file refactors / test runs / batch edits** instead of spending your main session quota on them.
- You care about **auditability** — every call's provider, model, and token count recorded locally.

### When it isn't

- **You don't have a Coding Plan subscription** → no effect, wasted effort. Calling the API directly with pay-as-you-go works fine.
- You only want **one-off short Q&A** → spinning up a ZCode child process carries ~66K tokens of system prompt, far heavier than a bare API call.
- You **won't install another Electron client** → this plugin depends on it.

### Quick check: three questions before you install

1. Am I **already subscribed** to GLM Coding Plan? (No → skip this plugin)
2. Do I do my day-to-day work in **DSH** rather than in the ZCode client? (Yes → the plugin is useful)
3. Do I have heavy work (multi-file refactor / tests / batch edits) to outsource? (Yes → direct benefit)

All three "yes" → keep reading.

---

## Install (3 steps)

### 0. Prerequisites: ZCode and a plan key

1. Install the **ZCode client**: <https://zcode.z.ai/cn/docs/install>
2. Subscribe to **GLM Coding Plan** on the Zhipu platform and obtain the plan API key.
3. Put the key in DSH's credentials file `~/.dsh/.credentials.yaml` under `refs:` (**the plugin ships no key**, and without one it cannot work):

   ```yaml
   refs:
     BIGMODEL_CODING_PLAN_API_KEY: your-plan-key
   ```

### 1. Place and register the plugin

Put the repo anywhere on your machine, e.g. `C:/tools/dsh-zcode-coding-plan`.

**A) Register in the DSH profile** — edit `~/.dsh/profiles/desktop/cordis.patch.yml` and append to the top-level list:

```yaml
    - id: zcode-coding-plan
      name: dsh-zcode-coding-plan
      config:
        # these three lines can be omitted entirely — the plugin auto-detects ZCode
        # zcodeExe: 'D:/Program Files/ZCode/ZCode.exe'
        # zcodeCjs: 'D:/Program Files/ZCode/resources/glm/zcode.cjs'
        # builtinProviderConfig: 'D:/Program Files/ZCode/resources/config/provider/zcode-builtin.json'
        providerOverride: 'C:/Users/your-username/.dsh/zcode-provider-override.json'
        defaultMode: yolo
        defaultTimeoutMs: 900000
        # optional quota gate: set a script path to enable it; leave empty to dispatch directly (fail-open)
        quotaScript: ''
```

> Back it up first (`cordis.patch.yml.bak-<purpose>-<timestamp>`) — a running DSH may rewrite the file.

**B) Add the dependency** — append to `dependencies` in the DSH application's `package.json`:

```json
    "dsh-zcode-coding-plan": "link:C:/tools/dsh-zcode-coding-plan"
```

**C) Create the junction** — run in the DSH application directory:

```bash
node -e "require('fs').symlinkSync('C:/tools/dsh-zcode-coding-plan', require('path').join(process.cwd(),'node_modules','dsh-zcode-coding-plan'), 'junction')"
```

> Use `link:` + junction, not `cp` — copied files won't pick up your changes.

### 2. Generate the provider override + self-check

```bash
cd C:/tools/dsh-zcode-coding-plan
node scripts/generate-override.mjs   # reads ~/.dsh/.credentials.yaml, writes ~/.dsh/zcode-provider-override.json
node scripts/setup-check.mjs          # environment self-check; exit code 0 = ready
```

Or run `node scripts/install.mjs` to print every snippet above at once (including the real paths detected on this machine).

Finally **restart the DSH desktop client**. The log should show:

```
[dsh-zcode-coding-plan] tools zcode_call + zcode_quota registered; zcode=… cjs=… override=… probe=windows-paths
```

---

## Usage

### Natural-language trigger

Say any of these to your agent and it goes through this plugin:

- "run this refactor with zcode" / "hand this coding task to ZCode"
- "save DSH quota" / "use the 150% plan credits"
- "let GLM Coding Plan take this heavy job"

The agent calls `zcode_quota` first, then decides whether to `zcode_call`.

### `zcode_call` parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | string | ✅ | The task prompt; state the goal and acceptance criteria |
| `cwd` | string | | Task working directory; absolute or relative to the session dir; omit = session cwd |
| `resume` | string | | `sessionId` from a previous call, to continue a multi-turn session |
| `mode` | string | | `build`/`edit`/`plan`/`yolo`; default `yolo` (fully automatic); use `plan` for advice-only |
| `timeout_ms` | number | | Child-process timeout; default 900000 (15 min), clamped to [30000, 3600000] |
| `force` | boolean | | `true` bypasses the quota gate; default false — insufficient quota returns `quota_insufficient` |

**Returns**

```json
{
  "sessionId": "sess_…",
  "traceId": "…",
  "response": "…",
  "usage": { "inputTokens": 67512, "outputTokens": 4, "totalTokens": 67516 },
  "projection": { "contextWindow": 200000, "contextUsed": 67516 },
  "exitCode": 0
}
```

On failure: `{ error, hint?, timedOut?, timeoutMs?, exitCode?, stderrTail? }`.

### `zcode_quota` parameters

None. Returns plan headroom and the routing verdict:

```json
{
  "available": true,
  "sufficient": true,
  "plan": "pro",
  "windowPct": 4.3, "routeWindowPct": 60,
  "weekPct": 16.0,  "routeWeekPct": 80
}
```

`available: false` means no quota script is configured — a normal state; the gate then fails open.

### Multi-turn example

```
1. zcode_call({ "prompt": "Add an Express service under src/ with a README", "cwd": "D:/work/myproj" })
   → response: …, sessionId: "sess_124bfb13-fc98-42c4-8056-f0b3aa584bed"

2. zcode_call({ "prompt": "Now add the tests and get them green", "cwd": "D:/work/myproj",
                "resume": "sess_124bfb13-fc98-42c4-8056-f0b3aa584bed" })

3. zcode_call({ "prompt": "Should we move to gRPC?", "cwd": "D:/work/myproj",
                "resume": "sess_124bfb13-…", "mode": "plan" })   // discuss only, no edits
```

---

## Quota gate (optional)

Before dispatching, the gate runs a local headroom estimator once: it only lets the call
through when the **5-hour window is under 60%** *and* **the week is under 80%**, otherwise it
returns `quota_insufficient` fast — burning no credits and starting no child process.

**Disabled by default** — the published plugin ships nobody's monitoring script path. Set
`quotaScript` to enable it; missing / erroring / timing-out scripts all fail open.

Script contract (any program satisfying this works):

```
<python> <quotaScript> --json --plan <plan>
→ stdout: {"plan":"pro","window_weighted":5,"window_cap":400,
           "week_weighted":308,"weekly_cap":2000}
```

Results are cached for 60 s so one session doesn't spawn python repeatedly. Force with `force: true`.

---

## Verify the call really went through the plan

ZCode records every call in `~/.zcode/cli/db/db.sqlite` (~440 MB — always open it **read-only**):

```bash
python -c "
import sqlite3
con = sqlite3.connect('file:' + r'C:\Users\your-username\.zcode\cli\db\db.sqlite?mode=ro', uri=True)
for r in con.execute('select session_id, provider_id, model_id, status, input_tokens from model_usage order by rowid desc limit 3'):
    print(r)
"
```

Expect `provider_id == 'dsh-glm-coding-plan'` and `model_id == 'GLM-5.3-Flash'`.
A different provider id means the override didn't take effect (commonly `providerOrder[0]`
isn't ours).

A real call recorded from this repo:

```
('sess_124bfb13-fc98-42c4-8056-f0b3aa584bed', 'dsh-glm-coding-plan', 'GLM-5.3-Flash', 'completed', 67512)
```

---

## Configuration reference

The `config:` block in `cordis.patch.yml`. Everything is optional:

| Key | Default | Description |
| --- | --- | --- |
| `zcodeRoot` | auto-detected | ZCode install root |
| `zcodeExe` / `zcodeCjs` / `builtinProviderConfig` | auto-detected | Set explicitly to skip detection |
| `providerOverride` | `~/.dsh/zcode-provider-override.json` | Override config path (overridable via `DSH_ZCODE_OVERRIDE`) |
| `providerId` | `dsh-glm-coding-plan` | The provider id that gets injected |
| `baseUrl` | `https://open.bigmodel.cn/api/anthropic` | Endpoint |
| `modelIds` | `["GLM-5.3-Flash","GLM-5.3"]` | Models available on the plan |
| `contextWindow` | `200000` | Context window written into the override config |
| `defaultMode` / `defaultTimeoutMs` / `minTimeoutMs` / `maxTimeoutMs` | `yolo` / `900000` / `30000` / `3600000` | Call parameters |
| `maxStdoutBytes` / `maxStderrBytes` | 16MB / 16KB | Output caps |
| `pythonExe` / `quotaScript` / `quotaPlan` | `python` / `` (empty) / `pro` | Quota gate |
| `quotaRouteWindowPct` / `quotaRouteWeekPct` / `quotaCacheTtlMs` | `60` / `80` / `60000` | Gate thresholds and cache |

Path resolution priority: **plugin config > `ZCODE_HOME` env var > platform detection**.

---

## Compliance

This plugin **drives the official ZCode client**, using its existing provider mechanism to
put the plan key first so DSH's requests travel the official Coding Plan channel.

- **Does not modify** any ZCode code or binaries;
- **Does not modify** ZCode's desktop provider registry (`…/provider_config.json`);
- **Does not modify** `~/.zcode/v2/credentials.json`;
- **Does not forge** requests, bypass server-side validation, or circumvent any limit. The
  override config is injected purely via per-spawn environment variables and is never written
  into ZCode's directories;
- Use subject to Zhipu's *GLM Coding Plan Usage Notes* and the official ZCode docs.

Official docs: <https://zcode.z.ai/cn/docs>

---

## Known limitations

1. **ZCode upgrades may change the provider schema.** This plugin depends on the
   `providerConfigRules` / `modelConfigRules` structure. If a major ZCode upgrade yields
   `Model creation failed`, run `node scripts/setup-check.mjs` first and adjust
   `lib/override.js` against ZCode's own `zcode-builtin.json`.
2. **~49K–66K tokens of system prompt per new session** (measured ~67.5K inputTokens for a
   single turn). That's the official client's fixed cost — very poor value for short Q&A.
3. **Billing is per request, not per prompt length.** A single turn with multiple tool calls
   can produce several model records.
4. **macOS / Linux path detection is best-effort and unverified.** All verification for this
   repo was done on **Windows + ZCode 3.14.5**. Other platforms may need explicit
   `zcodeExe` / `zcodeCjs`.
5. **Conservatively serialized:** `zcode_call` is marked not concurrency-safe, so parallel
   dispatches queue — deliberate, to avoid double-billing and thrashing the machine.
6. **The quota gate depends on an external script.** This repo ships no quota estimation
   implementation (there's no general way to estimate real consumption across plans).

---

## Documentation

- [docs/comparison.md](docs/comparison.md) — detailed comparison: billing, multipliers, capability matrix, who should use it
- [docs/how-it-works.md](docs/how-it-works.md) — mechanism: provider injection, model-selection rules, multi-turn, caching
- [docs/troubleshooting.md](docs/troubleshooting.md) — troubleshooting: ZCode not found / Model creation failed / 401 / quota gate / out of credits

## Development

- [CONTRIBUTING.md](CONTRIBUTING.md) — conventions, pre-commit checks, **the two hard requirements for the provider config**
- [CHANGELOG.md](CHANGELOG.md) — changelog

```bash
npm test                                # 3 suites, 114 assertions, zero billing (recommended)
npm run check                           # environment self-check (needs ZCode installed)
npm run test:smoke -- "reply with OK"   # real call (consumes plan credits!)
```

A CI workflow is included (Ubuntu + Windows × Node 18/20/22). **All tests use mock spawn, so
CI never invokes ZCode and never consumes credits**; the real call lives only in
`npm run test:smoke` and is intentionally excluded from CI.

## License

MIT — see [LICENSE](LICENSE).
