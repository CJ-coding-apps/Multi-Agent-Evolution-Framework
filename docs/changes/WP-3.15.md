# WP-3.15 — one default role set (D-61), and `maf init` no longer chooses a harness (S6)

Branch: `wp/3.15-roles` → `wp/phase-3b`

## What this changes

There were two default role sets, maintained by hand beside each other: the built-in
`DEFAULT_ROLE_SET` in `packages/roles/src/defaults.ts`, and the `.maf/roles.yaml` plus prompt files
the package ships (byte for byte as this repository's `.maf/` holds them, kept identical by
`packages/cli/src/__tests__/assets.test.ts`). They had drifted: the built-in tester held no
`fs.write` while the shipped one did (F2), and the prompts differed. Which set a run used depended
on whether the target directory had a roles file, so the same task ran different roles in two
directories with no visible reason.

**One source now.** `.maf/roles.yaml` and the prompt files it names are the definition. A generated
module, `packages/roles/src/defaultRoleSet.generated.ts`, is their compiled form — each role's
prompt *text* inlined (not its path, which a target without `.maf/prompts/` could not read), plus
**every field the file declares**: the generator copies each key except the four it supplies itself
(`role`, `systemPrompt`, `promptFile`, `allowedTools`), so a field nobody has written yet —
WP-3.14's `requiresTool`, say — is carried without an edit to the generator. A value that is not a
string, number or boolean stops the generator naming the field, rather than being dropped.
`DEFAULT_ROLE_SET` re-exports the generated set; `defaults.ts` no longer writes a role.

`scripts/generate-default-roles.mjs` renders two things from `.maf/roles.yaml` and its prompts: the
module, and the committed default harness `default-<sha>.json` into both `.maf/harnesses/` and
`packages/cli/assets/harnesses/`. It is runnable two ways:

```
node scripts/generate-default-roles.mjs           # rewrite the module and both harness copies
node scripts/generate-default-roles.mjs --check   # exit 1 when any of them is out of date
```

Write mode removes a stale `default-<old-sha>.json` only after re-hashing it with the same
canonicalisation `computeHarnessSha` uses and confirming both its content and its file name are the
old sha — a file that does not hash to its name is reported, never deleted.

### The drift tests

`packages/roles/src/__tests__/one-role-set.test.ts` loads `.maf/roles.yaml` through the same
`RoleRegistry` a run uses and compares, role by role, **whole objects** — not a list of fields.
`promptFile` is the one difference it removes before comparing: the built-in set carries the text
and never a path (D-08), and the text is compared against the prompt file in the same test and the
next one. It also runs the generator's `--check` as a test, so editing `.maf/roles.yaml` or a prompt
without regenerating fails the suite.

`packages/roles/src/__tests__/generator-fieldset.test.ts` runs the real generator in a copy of the
tree and adds `"requiresTool": "test.run"` to the tester **in the source only**: `--check` goes red,
regenerating makes it green, and the generated module carries the field. That is MED-3's case
exercised end to end, including the committed harness, whose sha moves with the field.

`packages/cli/src/__tests__/committed-default.test.ts` mints `id: default` from `.maf/roles.yaml`
through `harnessRoleSetFromRegistry` + `mintHarnessConfig` — the real code, not the generator's own
canonicalisation — and requires both committed copies to be byte for byte that harness. MED-2: an
edited prompt that is regenerated but not written leaves this test red.

### A real defect the move surfaced

Retargeting the R13 test ("a prompt's tool line names exactly what its role may call") to the
shipped syntax — the readers' prompts say `You may use:`; the built-in prompts used to say `Tools
available:` — found that all three shipped reader prompts omitted `lcm.expand` while their
`allowedTools` granted it. A reader was handed a Dolt cue it could follow and a prompt telling it it
could not. The tool is added to the `You may use:` line of `security`, `reviewer` and `analyst` in
`.maf/prompts/` and in `packages/cli/assets/prompts/` (both copies move together). The F7 closing
sentence is checked in the shipped wording, which names the `unexpected_change` failure the guard
produces.

## The harness-sha consequence, measured

Every sha below was measured on this branch with the shipped code (macOS, Node 25.6.0):

| Harness | sha | How it was measured |
|---|---|---|
| committed default (`.maf/harnesses/`, `packages/cli/assets/harnesses/`) | `2b33b58ea80faa9c4c17c9ae08a699c1048ec7ee3c69132466df54630c5800e3` | `computeHarnessSha` of the file equals its name; the generator reproduces it byte for byte |
| `legacy-default` minted from the shipped `.maf/roles.yaml` | `3124b5a9d019624e7e6e6a5d9983244a442eeeb15050f2867c66fd806b618379` | `HarnessStore.mint(harnessRoleSetFromRegistry(RoleRegistry.fromYamlOrDefault('.maf/roles.yaml')), 'legacy-default')` |
| `legacy-default` minted with no roles file (the built-in set) | `bedb6a245c4f28a7ee442cfcef0b2cc5b40379f6f219ec8d0f865ca3d02d6742` | the same call with a path that does not exist |
| goldens baseline (`tests/goldens/`, `packages/cli/assets/goldens/`) | `harnessSha: 2b33b58e…` | regenerated by running the suite |

**Which one a plain run uses.** With no `CURRENT`, the roles file as it is now: `3124b5a9…` in this
repository, or `bedb6a24…` in a directory with no roles file. With `CURRENT` naming
`legacy-default`, the same — that pointer tracks the file. With an operator-set `CURRENT`, that
harness: `2b33b58e…` if they ran `set-current default`, and any other sha they chose. `run` prints
the harness and its source on every run (`[maf] harness: <id> (<sha>) [legacy|current|flag]`).

**`legacy-default` can never equal `default`.** The id is inside the hash. And the **same dispatched
content mints two `legacy-default` shas** (`3124b5a9…` with the file, `bedb6a24…` without) because a
set read from the file carries each role's `promptFile` as provenance and the built-in set does not
(L2). This is stated rather than removed: dropping `promptFile` from the hashed set would re-mint
the committed default and move the goldens baseline a second time for a provenance field the built-in
set could not honour anyway.

The old `default-<sha>.json` is removed from both harness directories and the new one written to
both; the two copies are byte-identical. The goldens baseline was **regenerated by running the
suite**, not edited: `goldens run --adapter scripted --corpus tests/goldens` in this checkout, then
the result copied to both baseline paths. Measured comparison with the old baseline: identical
except `harnessSha` and `ranAt` — same `corpusSha` (`912f22db…`), same 10 tasks, same **4/10**
solved (`coder-sum`, `coder-reverse`, `coder-clamp`, `coder-isodd`). `scripts/compare-goldens.mjs`
compares it to the result with `ranAt` ignored. This is the only baseline move in Wave 2 (WP-3.7's
paid runs must be measured after this merges; WP-3.7b names the harness explicitly with
`--harness <sha>`, so nothing here can move their baseline).

## S6, corrected — `init` chooses no harness; plain runs follow the roles file

The first revision of this work package had `maf init` import the default harness it installed and
point `CURRENT` at it (round 1's S6). Verification found HIGH-1: after `init`, editing
`.maf/roles.yaml` was silently ignored — the run kept dispatching the harness that had been hashed
when it shipped — and the stated remedy (`set-current legacy-default`) failed on a fresh project
because no `legacy-default` had ever been minted. The ruling was amended, and this branch implements
the amended one:

- **`maf init` does not record a harness.** `runInit` writes `.maf/` and nothing else; it no longer
  imports a harness, writes `CURRENT`, or mentions one. Its closing lines say which file a plain run
  dispatches from and how to pin a harness:
  > A plain run uses .maf/roles.yaml as you edit it (the built-in set when the file is absent).
  > To pin a harness instead, run `maf harness set-current <id|sha>`; every run then says when
  > roles.yaml differs from it, and `maf harness set-current legacy-default` hands it back.
- **A plain run with no `CURRENT` dispatches the project's roles file**, as before #63: `legacy`
  source, minted now, adopted into the store.
- **`maf harness show current` with no `CURRENT` prints the roles-file harness and its sha,
  computed now, labelled `[roles file]`.** The note is on stderr; the harness JSON stays on stdout.
- **After `maf harness set-current <ref>`, plain runs use that harness** — and if the roles file then
  differs from it, **every run prints one line** naming both and the way back. The comparison is
  content, ignoring `promptFile` provenance, and is made on `run` and on `goldens`/`evolve` (one
  resolution function, one notice). It is silent when they agree and when dispatch never consulted
  `CURRENT` (a `--harness` ref, or the roles file itself):
  > `[maf] .maf/roles.yaml differs from CURRENT: plain runs use "pinned" (abcdef12), the file would
  > mint "legacy-default" (34567890). Run `maf harness set-current legacy-default` to dispatch from
  > the file again.`
- **A re-run of `init` never redirects dispatch** — it never touches `CURRENT` at all, with or
  without `--force`; an operator's pinned `CURRENT` is untouched and no new one is created.

**`show current` in its three states** (each covered by a test): no `CURRENT` → the roles file,
`[roles file]`; `CURRENT` naming `legacy-default` → the roles file **as it is now**, `[roles file]`,
and follow an edit of it (D-39's tracking pointer, shown rather than assumed); any other `CURRENT` →
that harness, `[current]`, and only in this third state can the drift notice fire.

**MED-1 — the way back works on a fresh project.** `maf harness set-current legacy-default` no
longer looks the ref up and fails; it mints the roles-file harness on demand, stores it, and points
`CURRENT` at it. Tested on a repository that has only run `maf init`, including that an edit to
`roles.yaml` moves the harness the way back points at on the next invocation. `legacy-default` is
the one spelling everywhere (the reserved-id check already refused it as an imported id).

**Tests, added or rewritten:**

- `init.test.ts`: "a fresh init records no CURRENT" (no `CURRENT` file, no stored `<sha>.yaml`, the
  epilogue names the roles file, `set-current <id|sha>` and `set-current legacy-default`);
  "a re-run of init never redirects dispatch" (no `CURRENT` created by a second `--force`, an
  operator's pinned `CURRENT` kept, no `CURRENT →` line).
- `run-harness.test.ts`: the verifier's own case — after `init`, remove `fs.write` from the tester
  in `.maf/roles.yaml`, and a plain run's tester no longer holds it, with a different sha; and the
  drift notice's three-way behaviour (fires for a pinned differing `CURRENT`, silent when equal,
  silent for `legacy`/`flag`).
- `harness-show-current.test.ts`: the three states above, including that `show` on a tracking
  `CURRENT` reports the edited file's sha and does not move `CURRENT`.
- `harness-set-current.test.ts`: the fresh-init way back; the D-39 refusal of an older
  `legacy-default` snapshot is unchanged, and `set-current legacy-default` now means "the roles file
  now" rather than "the newest stored snapshot".

## The other three MEDs, and the LOWs

- **MED-2 — the committed default is tied to its source.** The generator emits it (above) and
  `committed-default.test.ts` re-derives it with the product's own minting code; `--check` is also a
  test. An edited prompt that is not regenerated turns `--check` red; regenerating without writing
  the harness turns the drift test red.
- **MED-3 — no hard-coded field list.** The generator copies every key; the drift test compares
  whole objects; `generator-fieldset.test.ts` adds `requiresTool` to the source only and watches
  both gates go red. The false D-61 sentence is corrected below.
- **MED-4 — every sha measured.** The table above; `legacy-default` from the file is `3124b5a9…`,
  from the built-in set `bedb6a24…`, and neither is `default`'s `2b33b58e…` (the id is hashed).
  Which one a plain run uses is stated per state.
- **L1** — the generator's header and `defaults.ts` now name `one-role-set.test.ts`, not the retired
  `defaults.test.ts`.
- **L2** — same content, two `legacy-default` shas because of `promptFile`; **stated**, with the
  reason not to drop it (above).
- **L3** — there is no package.json script for the generator. Stated: the root `package.json` is
  reserved, and the `--check` **test** is the gate, so CI already runs it.
- **L4** — CRLF checkouts. `.gitattributes` now marks `.maf/roles.yaml`, `.maf/prompts/**`,
  `packages/cli/assets/roles.yaml`, `packages/cli/assets/prompts/**`, and both harness and goldens
  asset directories `-text`, alongside the files already marked: D-61 hashes these bytes, so a
  line-ending conversion would change a fresh clone's sha.
- **L5** — the queued CHANGELOG line now says the change a user sees: a run with no roles file gets
  the shipped set, whose tester holds `fs.write` and whose prompts are the shipped ones.
- **L6** — the generator reads `roles.yaml` as JSON-in-YAML (with `#` comment lines allowed), while
  the product parses YAML. Stated in the generator's header, with what changing it would take
  (the `yaml` package is not a root dependency, so the generator does not import it). The format
  this repository keeps the file in is JSON; a block-YAML source would stop the generator with a
  parse error rather than mis-read it.

## D-61 — One default role set

The built-in role set is the shipped `.maf/roles.yaml` and prompts, compiled in: one source
(`.maf/roles.yaml` + `.maf/prompts/*.md`, written by `maf init` from `packages/cli/assets/`), the
other generated from it (`scripts/generate-default-roles.mjs` → `defaultRoleSet.generated.ts` and
the committed `default-<sha>.json`) with a drift test that fails when either moves alone. The
built-in set carries prompt text, never a `promptFile`: it must run in a target with no
`.maf/prompts/`. **A field added to a role is copied into the built-in set and compared by the
drift test without an edit to either**; it is dispatched only once `roleConfigFromHarness` carries
it too — the two directions of `harnessBridge.ts` remain a pair.

## Docs for WP-3.13 to merge (this fragment does not edit them)

All replacement text below is true **after** this branch, including the S6 correction.

- **`docs/ROLES.md`, the role table** (the "Default roles" table, lines 20–23): add `lcm.expand` to the tool lists for
  `security`, `reviewer` and `analyst`, and `fs.write` to `tester` (the shipped set grants it). The
  rows are:
  - `tester`: `fs.read`, `fs.list`, `fs.stat`, `grep`, `lcm.expand`, `test.run`, `patch.apply`, `fs.write`
  - `security`: `fs.read`, `fs.list`, `fs.stat`, `grep`, `lcm.expand`, `git.diff`, `git.log`
  - `reviewer`: `fs.read`, `grep`, `lcm.expand`, `git.diff`, `git.log`
  - `analyst`: `fs.read`, `fs.list`, `fs.stat`, `grep`, `lcm.expand`, `git.status`, `git.diff`, `git.log`
- **`docs/ROLES.md`, the `\*` footnote ("The two tester definitions in this repository differ")**:
  it is no longer true; replace the whole paragraph with:
  > The built-in role set is the shipped `.maf/roles.yaml` and prompts, generated from them
  > (D-61, `docs/DECISIONS.md`); a target with no roles file gets exactly the set `maf init`
  > writes. The shipped tester holds `fs.write` and is a writer (see [Writer roles](#writer-roles)),
  > so its changes are security-reviewed. On the in-process tier the shipped policy also limits
  > *where* it may write — `tester-write-only-tests` and `tester-no-ci-config` in
  > `.maf/policy.yaml` — because the tool allowlist and the policy work together, and neither alone
  > is sufficient. On the `cli` tier neither the allowlist nor the policy reaches the backend's own
  > tools.
- **`docs/ROLES.md`, "Authoring a new role"**: insert after step 1:
  > Run `node scripts/generate-default-roles.mjs` and commit the regenerated
  > `packages/roles/src/defaultRoleSet.generated.ts` **and** the committed
  > `default-<sha>.json` in both harness directories. Without that, a target with no roles file
  > still gets the old set, and the drift tests fail (D-61).
- **`README.md` (line 42), the `maf init` status row**: replace "with no `roles.yaml`, `run` uses
  the built-in role set, which is not the shipped one, and says so" with "with no `roles.yaml`,
  `run` uses the built-in role set — the one `init` writes, since D-61 — and says so; `init` records
  no harness, so a plain run dispatches `.maf/roles.yaml` as the user edits it".
- **`README.md` (line 194), "Reading a roles file"**: replace the sentence "the built-in role set
  applies — **not** the `roles.yaml` the package ships, which `maf init` writes; the built-in
  `tester` holds no `fs.write` and the prompts differ, so a run without the file prints
  `[maf] roles: no .maf/roles.yaml — using the built-in role set (maf init writes the shipped one)`"
  with:
  > `roles.yaml` is YAML; the JSON form, `#` comment lines included, loads unchanged. If no file
  > exists at the path, the built-in role set applies — the same set the package ships and `maf
  > init` writes (D-61, `docs/DECISIONS.md`) — and the run says so (`[maf] roles: no
  > .maf/roles.yaml — using the built-in role set (the same one maf init writes)`).
- **`README.md` (line 196), "Which harness runs"**: after the `--harness default` sentence, add:
  > A repository that ran `maf init` has no `CURRENT`, so its plain runs mint `legacy-default` from
  > `.maf/roles.yaml` as it is now (`[legacy]`); `maf harness show current` reports that harness and
  > its sha, computed now, labelled `[roles file]`. Once `maf harness set-current <ref>` pins one,
  > plain runs use it (`[current]`) — and if the roles file then differs from it, every run prints
  > one line naming both and `maf harness set-current legacy-default`, which hands dispatch back.
- **`README.md` (line 330), "Run output" item 4**: still true; add one clause after "an unchanged
  role set reuses the stored file" — "`maf init` writes no `CURRENT`; only `maf harness
  set-current` does".
- **`CHANGELOG.md` (WP-3.13), 0.6.0 → Changed:** the built-in and shipped role sets are one
  (D-61); the committed default harness re-mints `0f4a05eb…` → `2b33b58e…` and the offline goldens
  baseline moves once with it (same corpus, same 4/10); a run with no `roles.yaml` now gets the
  shipped set, whose tester holds `fs.write`, and `maf harness show current` names the roles-file
  harness when no `CURRENT` is set.
  → **Fixed:** the readers' prompts now name `lcm.expand`, which their tool lists granted.

## Files

| File | Change |
|---|---|
| `scripts/generate-default-roles.mjs` | new: renders the built-in set **and** the committed default harness from `.maf/roles.yaml` and its prompts; emits every declared field; `--check`; stale removal after re-hash |
| `packages/roles/src/defaultRoleSet.generated.ts` | new, generated |
| `packages/roles/src/defaults.ts` | re-exports the generated set; no role written by hand |
| `packages/roles/src/__tests__/one-role-set.test.ts` | new: drift tests, whole-object comparison |
| `packages/roles/src/__tests__/generator-fieldset.test.ts` | new: a source-only role field turns `--check` red and is regenerated |
| `packages/roles/src/__tests__/defaults.test.ts` | R13 retargeted to the shipped `You may use:` syntax |
| `packages/roles/src/__tests__/phase-3-readers.test.ts` | F7 sentence retargeted to the shipped wording |
| `packages/roles/src/__tests__/role-name-mint.test.ts` | the generated module joins the role-set authors |
| `.maf/prompts/{security,reviewer,analyst}.md` and `packages/cli/assets/prompts/` | `lcm.expand` added to the tool line |
| `.maf/harnesses/default-<sha>.json` and `packages/cli/assets/harnesses/` | re-minted `0f4a05eb…` → `2b33b58e…`, old file removed, now generated |
| `tests/goldens/baseline.json` and `packages/cli/assets/goldens/baseline.json` | regenerated by running the suite |
| `packages/cli/src/commands/init.ts` | S6, corrected: records no harness; the epilogue names the roles file and how to pin |
| `packages/cli/src/commands/harness.ts` | S6: `show current` labels `[roles file]`/`[current]`; `set-current legacy-default` mints on demand (MED-1) |
| `packages/cli/src/wiring.ts` | `harnessDriftNotice`: one line when a pinned `CURRENT` and the roles file differ |
| `packages/cli/src/commands/run.ts` | the F2 notice names the built-in set as the shipped one (line-scoped); prints the drift notice |
| `packages/cli/src/commands/goldens.ts` | `goldens`/`evolve` print the same drift notice (line-scoped) |
| `packages/cli/src/__tests__/{init,harness-show-current,harness-set-current,run-harness}.test.ts` | S6, corrected: no-`CURRENT` init, the three `show` states, the fresh-project way back, the `fs.write` case and the notice |
| `packages/cli/src/__tests__/committed-default.test.ts` | new: MED-2, the committed default is what the source mints |
| `packages/cli/src/__tests__/run-d49-policy.test.ts` | the notice's expected text |
| `.gitattributes` | L4: the hashed role/prompt/harness/goldens bytes are `-text` |

## Verification

Run on `wp/3.15-roles` after the final edit (macOS, Node 25.6.0):

| Gate | Result |
|---|---|
| `pnpm -r build` | exit 0, 0 `error TS` |
| `pnpm run check:build-output` | 27/27 packages emitted their entry point — OK |
| `pnpm run check:test-scripts` | 25/27, two packages with no tests — OK |
| `pnpm run check:workspace-deps` | 27 packages, 94 internal edges, acyclic — OK |
| `pnpm run check:doc-refs` | OK |
| `node scripts/generate-default-roles.mjs --check` | up to date (also run as a test) |
| `goldens run --adapter scripted --corpus tests/goldens -d .` then `compare-goldens` to the baseline | matches, `ranAt` ignored; solved 4/10 |
| `pnpm -r --no-bail test` | 25 packages, **1673 tests / 1670 pass / 1 fail / 2 skipped**, exit 1 — the one failure is the known `packages/tools` G10 timeout below; that package re-run alone: **149 / 148 pass / 0 fail / 1 skipped**, exit 0 (`/tmp/maf-315-r2-tools.txt`) |

**One flake, stated:** the full run's single failure is `packages/tools` "MAF exiting normally kills the runner it started (WP-3.9 G10)", at its `waitForPid` budget after 123.6 s on a machine at 97% disk and ~5.8 load. The same test passed in 1.0 s moments earlier in the same file (`SIGTERM to MAF reaches the runner it started (WP-3.9 G10)`), **no `packages/tools` file is touched by this branch**, and the package re-run is green in 19.9 s. The wall-clock-budget class belongs to WP-3.12; it is recorded here rather than hidden.

## Findings recorded, not fixed

1. **`git log` history of the default harness**: the old `default-0f4a05eb….json` stays in history,
   as every earlier snapshot does; nothing in the repository references it.
2. **The goldens baseline's `ranAt` moves with the re-mint.** It is ignored by every consumer
   (`compare-goldens.mjs`, the offline-baseline tests) but appears in the diff; the next WP to
   regenerate the baseline will move it again.
