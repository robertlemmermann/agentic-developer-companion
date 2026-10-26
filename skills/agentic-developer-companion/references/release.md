# release: cutting a version of this skill

The checklist for tagging `agentic-developer-companion`, and the model for releasing any skill
the `tooling plugin release` and `tooling modify` modes help with: **one version in three
places**, and every validator green on the tagged commit.

## Contents

1. [Versioning rules](#1-versioning-rules)
2. [Pre-release checks (free)](#2-pre-release-checks-free)
3. [External validators (free)](#3-external-validators-free)
4. [Evals (paid)](#4-evals-paid)
5. [Manual matrix](#5-manual-matrix)
6. [Tag and publish](#6-tag-and-publish)
7. [After the release](#7-after-the-release)
8. [Release checklist](#8-release-checklist)

All commands run from the repository root; `S=skills/agentic-developer-companion`.

## 1. Versioning rules

Semantic versioning, breaking changes, never renaming and deprecation follow
[tooling-practices](tooling-practices.md) §1-§3; for this skill a ledger `schema` change and a
raised Node or Git minimum are breaking too.

- **One version, three places**: tag `vX.Y.Z`, `metadata.version: "X.Y.Z"` in
  `$S/SKILL.md`, and the first entry of the root `CHANGELOG.md`, written `## [X.Y.Z] - YYYY-MM-DD`
  (Keep a Changelog sections: Added, Changed, Deprecated, Removed, Fixed, Security). No
  `[Unreleased]` heading above the release entry on the tagged commit.

Manual check (works without Node):

```bash
grep -n '^  version:' "$S/SKILL.md"; grep -m1 -n '^## \[' CHANGELOG.md; git tag --list 'v*' --sort=-v:refname | head -3
```

```powershell
Select-String -Path "$S/SKILL.md" -Pattern '^  version:'; Select-String -Path CHANGELOG.md -Pattern '^## \[' | Select-Object -First 1; git tag --list 'v*' --sort=-v:refname | Select-Object -First 3
```

## 2. Pre-release checks (free)

```bash
S=skills/agentic-developer-companion
node tests/selftest.mjs --json > "${TMPDIR:-/tmp}/adc-selftest.json"; echo "selftest exit $?"
node --test "tests/unit/*.test.mjs"
node "$S/scripts/adc.mjs" tooling lint "$S" --strict
node "$S/scripts/adc.mjs" tooling trigger-set "$S" --set evals/trigger-set.json
git status --porcelain
```

```powershell
$S = "skills/agentic-developer-companion"
node tests/selftest.mjs --json | Out-File -Encoding utf8 "$env:TEMP/adc-selftest.json"; "selftest exit $LASTEXITCODE"
node --test "tests/unit/*.test.mjs"
node "$S/scripts/adc.mjs" tooling lint $S --strict
node "$S/scripts/adc.mjs" tooling trigger-set $S --set evals/trigger-set.json
git status --porcelain
```

What must hold:

- `tests/selftest.mjs` exit 0 with `failed: 0` (areas: footprint, frontmatter, scripts,
  prereqs, readme, release, evals, hooks, adc, diffs and the unit-file areas detect, reports,
  evidence, live, tooling, scaffold). `skipped` cases need a reason you accept.
- `tooling lint --strict` reports no errors and no warnings on the skill itself.
- `tooling trigger-set` reports `ready: true` and no warnings (the set is valid).
- `git status --porcelain` is empty: the release commit is what you tested.
- Footprint (selftest `footprint`): at most 100 files in `$S`, 50 entries per folder, 5 MB per
  file, LF only, every `references/*.md` linked from SKILL.md and at most 300 lines; `$S` holds
  only `SKILL.md`, `PREREQUISITES.md`, `references/`, `scripts/`, `assets/`.

**Manual fallback** (no Node; expected result in the comments):

```bash
git ls-files "$S" | wc -l                                      # at most 100
git ls-files --eol "$S" | grep -v 'w/lf' | grep -v 'w/none'    # no output (LF only)
grep -rnE -e '[$]ARGUMENTS' -e '[$][{]CLAUDE_SKILL_DIR[}]' "$S/SKILL.md" "$S/references"   # no output
wc -l "$S"/references/*.md                                     # each at most 300
find "$S" -name '.env*'                                       # no output (no .env file in the tree)
ls "$S"                                   # PREREQUISITES.md SKILL.md assets references scripts
```

## 3. External validators (free)

Run each that is installed; a missing validator is noted in the release PR, not skipped
silently.

```bash
uvx --from 'git+https://github.com/agentskills/agentskills#subdirectory=skills-ref' skills-ref validate "$S"
gh skill publish --dry-run
R=$(mktemp -d) && git -C "$R" init -q && (cd "$R" && gh skill install --from-local "$OLDPWD" agentic-developer-companion --dir .github/skills && copilot skill list --json && gh skill install --from-local "$OLDPWD" agentic-developer-companion --agent codex && codex debug prompt-input "hello" | grep -c agentic-developer-companion)
```

- `skills-ref validate` must pass (it uses strictyaml: no flow-style YAML in the frontmatter).
- `gh skill publish --dry-run` must pass; the only accepted warning is a missing tag ruleset
  while §6 is not done yet.
- `copilot skill list --json` lists `agentic-developer-companion` with `source: "project"`;
  `codex debug prompt-input` shows it (count ≥ 1). Neither needs a login.
- Do not record `claude plugin validate` as a result: it does not validate a standalone skill ([host notes](host-notes.md) §8).
- `gitleaks dir "$S" --redact` when installed: no findings (the tree holds no secret-shaped
  literals; fixtures build them at test time).

## 4. Evals (paid)

Required before v1.0.0 and whenever the description, the mode router or a playbook changes
meaning; optional for patch releases. Each run bills your account: set a ceiling.

```bash
node tests/run-evals.mjs --json "${TMPDIR:-/tmp}/adc-evals.json"
node "$S/scripts/adc.mjs" tooling trigger-set "$S" --set evals/trigger-set.json --host claude --run --runs 3 --max-cost-usd 10
node "$S/scripts/adc.mjs" tooling trigger-set "$S" --set evals/trigger-set.json --host copilot --run --runs 3
```

```powershell
node tests/run-evals.mjs --json (Join-Path $env:TEMP "adc-evals.json")
node "$S/scripts/adc.mjs" tooling trigger-set $S --set evals/trigger-set.json --host claude --run --runs 3 --max-cost-usd 10
```

- `tests/run-evals.mjs` runs `claude plugin eval` (Claude Code 2.1.269+) on a temp copy of the
  skill with `evals/` inside ([host notes](host-notes.md) §8), with defaults `--ablation none
  --threshold 0.8 --max-cost-usd 10 --no-publish` and a temp `--output-dir`; any `claude plugin
  eval` option passes through.
- Cases: `evals/verify-false-pass-claim` (the skill is selected for a distrusted "tests
  pass" claim; its `tool_used: Skill` grader has `arm: both`) and
  `evals/lint-broken-skill` (an `llm` grader checks the defects named in a broken SKILL.md).
  Neither grants a shell tool, so both also run on native Windows without WSL2.
- Pin `--model` and `--judge-model` to the models you release against and write them into
  the matrix. Exit 0 passed, 1 below threshold or a load error, 2 partial (cost ceiling).
- Gates: `claude plugin eval` overall score ≥ 0.8; trigger `suite_score` ≥ 0.8 for Claude
  and for Copilot. Results also land in `.adc/metrics.jsonl` of the checkout.
- **Manual fallback**: run five should-trigger and five near-miss queries from
  `evals/trigger-set.json` by hand in each host and record which loaded the skill.

## 5. Manual matrix

Fill the rows for the tag in `tests/manual-matrix.md` (OS and launch path × host × step; version,
result, date). Releasable: every row `pass`, `n/a` or an accepted `manual`; a row not run stays
`not run`, never `pass`.

## 6. Tag and publish

1. Merge the release pull request (version bump, CHANGELOG entry, updated
   [host notes](host-notes.md) dates) into `main` with the checks of §2 and §3 green.
2. Protect tags once per repository: Settings → Rules → Rulesets → New tag ruleset, target
   `v*`, restrict updates and deletions, require signed tags where your plan allows it.
3. Create a signed tag, the archive and the checksums, then the GitHub release:

```bash
V=0.1.0; git switch main && git pull --ff-only
git tag -s "v$V" -m "agentic-developer-companion $V" && git push origin "v$V"
git archive --format=tar.gz --prefix="agentic-developer-companion-$V/" -o "agentic-developer-companion-$V.tar.gz" "v$V" skills/agentic-developer-companion LICENSE README.md CHANGELOG.md THIRD_PARTY_NOTICES.md
git archive --format=zip --prefix="agentic-developer-companion-$V/" -o "agentic-developer-companion-$V.zip" "v$V" skills/agentic-developer-companion LICENSE README.md CHANGELOG.md THIRD_PARTY_NOTICES.md
sha256sum "agentic-developer-companion-$V.tar.gz" "agentic-developer-companion-$V.zip" > SHA256SUMS
node -e "const t=require('fs').readFileSync('CHANGELOG.md','utf8');process.stdout.write('## '+t.split(/^## /m)[1])" > release-notes.md
gh release create "v$V" --verify-tag --title "v$V" --notes-file release-notes.md "agentic-developer-companion-$V.tar.gz" "agentic-developer-companion-$V.zip" SHA256SUMS
gh repo edit --add-topic agent-skills
```

```powershell
$V = "0.1.0"; git switch main; git pull --ff-only
git tag -s "v$V" -m "agentic-developer-companion $V"; git push origin "v$V"
git archive --format=zip --prefix="agentic-developer-companion-$V/" -o "agentic-developer-companion-$V.zip" "v$V" skills/agentic-developer-companion LICENSE README.md CHANGELOG.md THIRD_PARTY_NOTICES.md
Get-FileHash "agentic-developer-companion-$V.zip" -Algorithm SHA256 | ForEach-Object { "$($_.Hash.ToLower())  agentic-developer-companion-$V.zip" } | Out-File -Encoding ascii SHA256SUMS
node -e "const t=require('fs').readFileSync('CHANGELOG.md','utf8');process.stdout.write('## '+t.split(/^## /m)[1])" | Out-File -Encoding utf8 release-notes.md
gh release create "v$V" --verify-tag --title "v$V" --notes-file release-notes.md "agentic-developer-companion-$V.zip" SHA256SUMS
```

`gh skill publish --tag vX.Y.Z` is the alternative that creates the tag, the release and the
`agent-skills` topic in one step; its tag is not signed. Never move or re-push a published
tag: users pin it, and `gh skill install` resolves "latest tag" first.

## 7. After the release

- Install the tag on a clean machine per host (`gh skill install
  robertlemmermann/agentic-developer-companion agentic-developer-companion@vX.Y.Z`) and run
  `doctor`; record it in the matrix.
- Vendored copies at work: `node <copy>/scripts/adc.mjs doctor --verify-vendored --ref vX.Y.Z`
  compares the copy with the tag (SKILL.md semantically, every other file byte for byte); exit 1 on drift.
- Re-verify [host notes](host-notes.md) every quarter and on every major host release; move
  resolved open items to §8 there with the date and version.
- Open the next `[X.Y.Z]` CHANGELOG entry only in the next release pull request.

## 8. Release checklist

Copy into the release pull request:

```text
- [ ] version X.Y.Z in SKILL.md metadata.version, top CHANGELOG entry ## [X.Y.Z] - date, tag vX.Y.Z
- [ ] node tests/selftest.mjs: failed 0 (skipped cases explained)
- [ ] node --test "tests/unit/*.test.mjs": all pass
- [ ] tooling lint --strict on the skill: clean
- [ ] skills-ref validate: pass        - [ ] gh skill publish --dry-run: pass
- [ ] copilot skill list --json lists it - [ ] codex debug prompt-input shows it
- [ ] footprint: <=100 files, <=50 per folder, LF only, references <=300 lines
- [ ] evals (when required): plugin eval >= 0.8, trigger suite >= 0.8 (Claude, Copilot), models recorded
- [ ] manual matrix rows filled for this tag
- [ ] host-notes dates and open items updated
- [ ] signed tag pushed, release with archive + SHA256SUMS, topic agent-skills
```
