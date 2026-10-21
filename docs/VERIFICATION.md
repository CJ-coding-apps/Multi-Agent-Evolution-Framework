# Verification record

Every release branch since 0.2.0 was reviewed by verifiers that had not seen the implementation: a clean checkout, the spec, the diff and the suite, with instructions to mutate the code and confirm a test fails, to invent the inputs the spec left out, and to check that each integration note would compile. The one exception is the 0.3.2 hotfix, cut from the 0.3.1 tag with a structural test and the live row that found the defect; no separate verifier pass is recorded for it. This file lists those passes, their verdicts and the findings that mattered. Severity: **HIGH** = wrong or unsafe behaviour, or a shipped claim that is false; **MED** = a user would hit it; **LOW** = polish. In the 0.2.1 and 0.3.0 tables, every HIGH was fixed before the branch merged, and every 0.3.0 MED was fixed before the tag; the one 0.2.1 finding not fixed on the branch, F9, was documented and carried to Phase 2. From 0.3.1 the Resolution column states where a fix landed, including when it moved to a later release. The fix commit cites the finding, in a form such as `[WP-x.y, F<n>]`, `[F<n>]` or `(F<n>)`.

## 0.2.1 (Phase 1, 2026-10-08)

| Pass | Scope | Verdict | HIGH / MED / LOW | What the HIGH findings were | Resolution |
|---|---|---|---|---|---|
| Lane verifier | the merged `wp/phase-1` diff (nine work packages) | NOT MERGEABLE, 17 findings | 2 HIGH, 15 MED or LOW | the integration commit's whole-`.maf` exclusion hid tracked policy, roles and prompts from the security review; a `--  .` pathspec narrowed the review to the `-d` subtree | 16 fixed on the branch (D-29 settles the diff's scope); F9 (`allowPartial` reachable only from code) documented and carried to Phase 2 |
| Fresh-clone proof (macOS, real `claude`) | install → build → test → demo → `run` on a repo with no `.maf/` | all rows green | — | — | found two things no scripted test could: the adapter passed `--max-tokens`, a flag the binary does not have (fixed `af0cba0`); a `cli`-tier node reported `Succeeded` with an empty diff when the backend refused to write (documented, then D-32 in 0.3.0) |

## 0.3.0 (Phase 2, 2026-10-08 … 10-13)

| Pass | Scope | PR | Verdict | HIGH / MED / LOW | What the HIGH findings were | Resolution |
|---|---|---|---|---|---|---|
| Lane verifier | WP-2.1 in-process default, `expectsChange`, strict-MCP | #9 | MERGEABLE WITH FIXES | 0 / 2 / 6 | — | fixed; D-33 (`--tools ""` on in-process turns) came from its F2 |
| Lane verifier | WP-2.2 approval gate | #16 | MERGEABLE WITH FIXES | 0 / 2 / 4 | — | fixed (provider answering nothing is an attested refusal; bounded input preview; timeout from the prompt) |
| Lane verifier | WP-2.3 review gate | #12 | MERGEABLE WITH FIXES | 0 / 3 / 3 | — | fixed; D-34 (the gate exists only when asked for) came from its F3 |
| Lane verifier | WP-2.4 worktree isolation | #14 | MERGEABLE WITH FIXES | 0 / 3 / 6 | — | fixed; D-35 reverted a runtime-state entry that widened the unreviewed set |
| Lane verifier | WP-2.5 config and roles loading | #13 | MERGEABLE WITH FIXES | 0 / 2 / 4 | — | fixed; D-40 (YAML merge keys refused) came from its F2 |
| Lane verifier | WP-2.6 planner failure recall | #11 | MERGEABLE WITH FIXES | **1** / 1 / 3 | recall keyed on the node's instruction, not the run title, so it never fired on a real multi-node plan | fixed; D-37 |
| Lane verifier | WP-2.7 offline evaluation (two stacked PRs) | #15, #18 | #15 MERGEABLE; #18 MERGEABLE WITH FIXES | 0 / 3 / 6 | — | fixed; D-38 (compare like with like), D-39 (reserved harness ids) |
| Lane verifier | WP-2.8 in-toto attestation | #17 | MERGEABLE WITH FIXES | **1** / 1 / 5 | the signed bytes were not RFC 8785 for integer-like keys, so a third party could not reproduce some signatures | fixed; D-36 (a dedicated JCS serializer; `canonicalJson` unchanged so harness shas do not move) |
| Lane verifier | WP-2.9 harness identity | #10 | MERGEABLE WITH FIXES | 0 / 5 / 4 | — | fixed (atomic store writes; `set-current` refuses a stale snapshot; honest messages) |
| Integration verifier | WP-2.10 `run.ts` / `wiring.ts` / `main.ts` | #19 | MERGEABLE WITH FIXES | 0 / 5 / 7 | — | fixed; its F12 (the agent's git tools ran the repository's hooks) became WP-2.14 |
| Release audit | the whole `wp/phase-2` branch, docs against code, by hand from `dist/` | — | RELEASE WITH FIXES | **2** / 1 / 8 | the agent's git tools could leave the worktree (`fs.delete .git`, then `git.reset --hard` reached the user's checkout; no policy file present); an agent-written `.gitattributes` (`*.js -diff`) turned the reviewed diff into "Binary files differ" | WP-2.17 (#25): `.git` writes refused before policy; git calls held to the learned repository root; `--text --no-ext-diff --no-textconv` |
| Re-audit | WP-2.17 against the audit's attacks | #25 | CLOSED WITH NOTES | 0 / 1 / 1 | — | the one residual (a `.git` link rewritten through `test.run` kept the worktree as the top) closed by holding each call to the learned git directory too |
| Fresh-clone proof (macOS, real `claude`) | the release candidate at `f625bbb`, then at `0bca345` | — | 10/11 green, then 11/11 | — | — | the live `run` failed once: the tool catalog carried no field names, so the model sent `patch.apply {path, patch}` for a tool that wants `diff`; WP-2.18 (#27) added an input schema to every catalog entry, made malformed and failing tool calls answers rather than node deaths, and extended `no_change` to the in-process tier |

Totals for the two releases: 13 passes (15 table rows less the two fresh-clone proofs; the two-PR WP-2.7 pass counts once), 107 findings (6 HIGH; 101 MED or LOW — Phase 2 alone: 90 findings, 4 HIGH, 29 MED, 57 LOW, counted by finding id from the persisted verdicts; the audit's F11 is one "polish" finding with several items), all HIGH and MED fixed before the tag. The findings that mattered most — the two release-audit HIGHs — were invisible from inside any single package, and the three defects that reached a real machine were all in the model-facing surface that scripted tests cannot exercise. Both lessons are in `BUILD_PLAN.md` §3.

Also found and fixed along the way, outside any verdict: a "flaky" CI job that failed six runs in nine was Kùzu query results never being closed — a garbage-collected graph wrote into freed memory (WP-2.15, #22, with gdb and valgrind evidence in the PR).

## 0.3.1 and 0.3.2 (2026-10-13 … 10-14)

| Pass | Scope | Verdict | HIGH / MED / LOW | What the HIGH findings were | Resolution |
|---|---|---|---|---|---|
| Real-model sweep (macOS, real `claude`) | nine tasks against the 0.3.0 tag, read with the bundle open | 3 Succeeded, 5 Failed, 1 process death | 3 / 2 / 2 | **F7:** a read-only role on the `cli` tier could edit the tree and the signed bundle attested `Succeeded` with no subject; **F4:** the bundle did not record what the model was shown; **F3:** no built-in role fit a question, so investigations failed `no_change` | F7 and F4 fixed in 0.3.1 (D-42: a reader's turn is bracketed by two tree snapshots; `modelSurfaces`, `policyInForce`, `executionTiers` in the bundle); F3 became the `analyst` role in 0.4.0 |
| Lane verifiers | 0.3.1's PRs #30 (twice) and #31 | MERGEABLE after fixes | not tallied here | — | fixed before merge |
| Release proof (fresh clone of the tag, real `claude`) | the 0.3.1 commit | green | 0 / 2 / 1 | — | F8 (cli-tier calls unrecorded), F9 (the reviewer was never given a diff), F10 (a denied writer's failure did not name the rule): all three fixed in 0.4.0 |
| Live row of the next work package | the shipped `.env` rule, by a real model | FAIL | **1** / 0 / 0 | **F11:** the shipped `deny-env-files` rule named `fs.write` only; a real model renamed the key through `patch.apply` and was allowed | **0.3.2**, a hotfix from the 0.3.1 tag: the rule names every write tool, and a structural test now requires every path-scoped rule to (it found two more rules missing `fs.delete`) |

## 0.4.0 (Phase 3a, 2026-10-14 … 10-20)

> **Note on release numbers in this section.** "0.5.0" below means the next release *as planned when this section was written*: D-48 later renumbered that work 0.6.0 and gave 0.5.0 to packaging. The rows themselves are historical and are left as they were written.

Three work packages, each verified until a pass found nothing above LOW, then a whole-branch audit, then live rows on a real `claude`. Findings are counted once, in the pass that first reported them.

| Pass | Scope | PR | Passes | HIGH / MED / LOW | What the HIGH findings were | Resolution |
|---|---|---|---|---|---|---|
| Lane verifier | WP-3.0b `analyst`, readers in-process, planner role block from config | #37 | 2 | 0 / 4 / 9 | — | fixed; the reader tool-call cap raised after a mutation showed it had become a hard turn limit |
| Lane verifier | WP-3.0c every role call in the record; attribution of a reader's diff to a concurrent writer | #42 | 5 | 2 / 5 / 15 | the attribution rule was untested, and excused a change that no gate would ever review | each pass found the rule's next layer down: any overlap → containment by path → content → paths parsed from diff text instead of git's own listing (a non-ASCII name, a mode change or a rename passed unreviewed). Settled when the paths came from `git diff --name-only -z --no-renames` and every tree id went into the record |
| Lane verifier | WP-3.1 `no_work`; the turn names its toolset; failure as a value | #43 | 3 | 5 / 4 / 13 | the new failure message quoted the model's answer unmasked into the signed bundle; the outcome claimed to classify every failure but skipped gate refusals; three doc sentences written during the fix round said the opposite of the code | fixed; four spec amendments recorded where the spec was imprecise |
| Live rows | each work package on a real `claude` | — | 3 sessions | 0 / 3 / 4 | — (F11 is counted under 0.3.2) | the first real-model attribution reproduced byte-for-byte; `no_work` observed firing on a real model; the rest → 0.5.0 backlog |
| Release audit | the whole branch against `main`, docs against code | — | 1 | **5** / 1 / 7 | the release contradicted its own plan; the built-in `tester` could claim work it never did; two more paths quoted model text unmasked; two docs one lane left false for the next | audit-fix PR #44; D-47 re-scoped the release; `no_work` generalised to every role that does not expect a change |
| Audit-fix verifier | PR #44 | #44 | 2 | 2 / 2 / 7 | the fix changed who `no_work` judges and five docs still said otherwise; a parsed security review still reached the record unmasked | fixed; every failure path traced and shown masked or free of model text |
| Release proof (fresh clone of the tagged commit, real `claude`) | `bc51971` | — | 1 | 0 / 0 / 2 | — | 7/7 green; two LOWs to 0.5.0 (stray `.orig`/`.rej` artifacts; the coder prompt makes the model abstain from a requested `.env` edit) |

Totals since 0.2.0: **at least 208 findings** (**at least 24 HIGH**), counted by finding id from the persisted verdicts and rulings: 107 in 0.2.1–0.3.0, 11 in 0.3.1–0.3.2 (a floor — the lane verifiers' findings for #30/#31 were not tallied), 90 in 0.4.0. Every HIGH was fixed, at the latest in the next minor release after the one it was found against. Every MED was fixed or is stated in the docs as a known limit; the two 0.4.0 MEDs whose fix is a design change (the broader claims-against-record check; a check that the task's tool was the one called) are carried to 0.5.0. F9, from 0.2.1, was carried to Phase 2 and is listed in the README as planned. The LOWs are on the record.

What the later releases added to the lessons below: a live row is where policy data gets tested, not just prompts. F11 was a one-word omission in a shipped rule, invisible to every scripted test because the script's author reached for the tool the rule named. Masking had to be traced path by path: three separate passes each found one more place where model text reached the record. And when a verifier ran past its own earlier verdict, it said so.
