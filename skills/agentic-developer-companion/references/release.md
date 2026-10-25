# release: cutting a version of this skill

The checklist for tagging `agentic-developer-companion` (and the model for releasing any
skill the `tooling plugin release` and `tooling modify` modes help with). One rule holds it
together: **the tag, `metadata.version` in SKILL.md and the top CHANGELOG entry name the same
version**, and every validator ran green on the tagged commit.

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

- **Semantic versioning.** Before 1.0.0, a breaking change bumps the minor version; from
  1.0.0 on, the major. Breaking means: a mode or CLI command renamed or removed, a JSON output
  field removed or retyped, a ledger `schema` change, a hook template change that needs
  re-registration, a raised minimum (Node, Git, a host).
- **One version, three places**: tag `vX.Y.Z`, `metadata.version: "X.Y.Z"` in
  `$S/SKILL.md`, and the first entry of `$S/CHANGELOG.md`, written `## [X.Y.Z] - YYYY-MM-DD`
  ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/) sections: Added, Changed,
  Deprecated, Removed, Fixed, Security). Do not leave an `[Unreleased]` heading above the
  release entry on the tagged commit.
- **Never rename the skill.** `name` equals the folder name and is what every install
  resolves; renames break installs and `gh skill update`.
- **Deprecate before removing**: a dated notice in the CHANGELOG and the affected playbook,
  naming the version that removes it (at least one minor release later).

Manual check (works without Node):

```bash
grep -n '^  version:' "$S/SKILL.md"; grep -m1 -n '^## \[' "$S/CHANGELOG.md"; git tag --list 'v*' --sort=-v:refname | head -3
```

```powershell
Select-String -Path "$S/SKILL.md" -Pattern '^  version:'; Select-String -Path "$S/CHANGELOG.md" -Pattern '^## \[' | Select-Object -First 1; git tag --list 'v*' --sort=-v:refname | Select-Object -First 3
```

## 2. Pre-release checks (free)

```bash
S=skills/agentic-developer-companion
node "$S/scripts/adc.mjs" selftest --json > /tmp/adc-selftest.json; echo "selftest exit $?"
node --test "$S/tests/unit/"
node "$S/scripts/adc.mjs" tooling lint "$S" --strict
node "$S/scripts/adc.mjs" tooling trigger-set "$S"
git status --porcelain
```

```powershell
$S = "skills/agentic-developer-companion"
node "$S/scripts/adc.mjs" selftest --json | Out-File -Encoding utf8 "$env:TEMP/adc-selftest.json"; "selftest exit $LASTEXITCODE"
node --test "$S/tests/unit/"
node "$S/scripts/adc.mjs" tooling lint $S --strict
node "$S/scripts/adc.mjs" tooling trigger-set $S
git status --porcelain
```

What must hold:

- `selftest` exit 0 with `failed: 0` (areas: hooks, frontmatter, scripts, diffs, footprint,
  adc, readme, prereqs, release, evals). `skipped` areas need a reason you accept.
- `tooling lint --strict` reports no errors and no warnings on the skill itself.
- `tooling trigger-set` reports `ready: true` and no warnings (the set is valid).
- `git status --porcelain` is empty: the release commit is what you tested.
- Footprint: at most 100 files in `$S`, no folder above 50 entries, no file above 5 MB, LF
  only, every `references/*.md` linked from SKILL.md, references at most 300 lines.

**Manual fallback** (no Node; expected result in the comments):

```bash
git ls-files "$S" | wc -l                                      # at most 100
git ls-files --eol "$S" | grep -v 'w/lf' | grep -v 'w/none'    # no output (LF only)
grep -rnE -e '[$]ARGUMENTS' -e '[$][{]CLAUDE_SKILL_DIR[}]' "$S/SKILL.md" "$S/references"   # no output
wc -l "$S"/references/*.md                                     # each at most 300
find "$S" -name '.env*'                                       # no output (no .env file in the tree)
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
- `claude plugin validate` does **not** validate a standalone skill (`contents: []` is not a
  pass; see [host notes](host-notes.md) §8). Do not record it as a validator result.
- `gitleaks dir "$S" --redact` when installed: no findings (the tree holds no secret-shaped
  literals; fixtures build them at test time).

## 4. Evals (paid)

Required before v1.0.0 and whenever the description, the mode router or a playbook changes
meaning; optional for patch releases. Each run bills your account: set a ceiling.

```bash
OUT="${TMPDIR:-/tmp}/adc-evals"; mkdir -p "$OUT"
claude plugin eval "$S" --trust-plugin --no-publish --threshold 0.8 --max-cost-usd 10 --output-dir "$OUT" --report "$OUT/report.html" --json "$OUT/result.json"
node "$S/scripts/adc.mjs" tooling trigger-set "$S" --host claude --run --runs 3 --max-cost-usd 10
node "$S/scripts/adc.mjs" tooling trigger-set "$S" --host copilot --run --runs 3
```

```powershell
$OUT = Join-Path $env:TEMP "adc-evals"; New-Item -ItemType Directory -Force $OUT | Out-Null
claude plugin eval $S --trust-plugin --no-publish --threshold 0.8 --max-cost-usd 10 --output-dir $OUT --report "$OUT/report.html" --json "$OUT/result.json"
node "$S/scripts/adc.mjs" tooling trigger-set $S --host claude --run --runs 3 --max-cost-usd 10
```

- The skill folder is the target: `claude plugin eval` resolves it as a plugin named after
  the skill and runs each case with and without it (Claude Code 2.1.269+). `--output-dir` and
  `--report` keep results out of the skill tree (the default is `$S/evals/results/`).
- Cases: `evals/verify-false-pass-claim` (the skill is selected for a distrusted "tests
  pass" claim; its `tool_used: Skill` grader has `arm: both`, so it scores in both arms) and
  `evals/lint-broken-skill` (an `llm` grader checks the defects named in a broken SKILL.md).
  Neither grants a shell tool, so both also run on native Windows without WSL2.
- Pin `--model` and `--judge-model` to the models you release against and write them into
  the matrix. Exit 0 passed, 1 below threshold or a load error, 2 partial (cost ceiling).
- Gates: `claude plugin eval` overall score ≥ 0.8; trigger `suite_score` ≥ 0.8 for Claude
  and for Copilot. Results also land in `.adc/metrics.jsonl` of the checkout.
- **Manual fallback**: run five should-trigger and five near-miss queries from
  `evals/trigger-set.json` by hand in each host and record which loaded the skill.

## 5. Manual matrix

Fill the rows for the tag in `tests/manual-matrix.md`: OS (Windows 11 with pwsh 7, Windows
PowerShell 5.1, Git Bash and cmd launch paths; macOS; Ubuntu) × host (Copilot CLI, VS Code
with Session Target = Copilot, Claude Code, Codex) × step (install, `help` prints the
resolved skill path, `verify` on a sample repository, `setup hooks` plus one edit and one
stop, and on Windows the `.adc/.env.live` ACL check from `doctor`). Columns: version, result,
date. Rows that need an entitlement you lack are marked "manual observation" or "not run",
never "pass".

## 6. Tag and publish

1. Merge the release pull request (version bump, CHANGELOG entry, updated
   [host notes](host-notes.md) dates) into `main` with the checks of §2 and §3 green.
2. Protect tags once per repository: Settings → Rules → Rulesets → New tag ruleset, target
   `v*`, restrict updates and deletions, require signed tags where your plan allows it.
3. Create a signed tag, the archive and the checksums, then the GitHub release:

```bash
V=0.1.0; git switch main && git pull --ff-only
git tag -s "v$V" -m "agentic-developer-companion $V" && git push origin "v$V"
git archive --format=tar.gz --prefix="agentic-developer-companion-$V/" -o "agentic-developer-companion-$V.tar.gz" "v$V" skills/agentic-developer-companion LICENSE README.md
git archive --format=zip --prefix="agentic-developer-companion-$V/" -o "agentic-developer-companion-$V.zip" "v$V" skills/agentic-developer-companion LICENSE README.md
sha256sum "agentic-developer-companion-$V.tar.gz" "agentic-developer-companion-$V.zip" > SHA256SUMS
node -e "const t=require('fs').readFileSync('skills/agentic-developer-companion/CHANGELOG.md','utf8');process.stdout.write('## '+t.split(/^## /m)[1])" > release-notes.md
gh release create "v$V" --verify-tag --title "v$V" --notes-file release-notes.md "agentic-developer-companion-$V.tar.gz" "agentic-developer-companion-$V.zip" SHA256SUMS
gh repo edit --add-topic agent-skills
```

```powershell
$V = "0.1.0"; git switch main; git pull --ff-only
git tag -s "v$V" -m "agentic-developer-companion $V"; git push origin "v$V"
git archive --format=zip --prefix="agentic-developer-companion-$V/" -o "agentic-developer-companion-$V.zip" "v$V" skills/agentic-developer-companion LICENSE README.md
Get-FileHash "agentic-developer-companion-$V.zip" -Algorithm SHA256 | ForEach-Object { "$($_.Hash.ToLower())  agentic-developer-companion-$V.zip" } | Out-File -Encoding ascii SHA256SUMS
node -e "const t=require('fs').readFileSync('skills/agentic-developer-companion/CHANGELOG.md','utf8');process.stdout.write('## '+t.split(/^## /m)[1])" | Out-File -Encoding utf8 release-notes.md
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
  compares the copy with the tag (SKILL.md semantically, because `gh skill install` rewrites
  its frontmatter; every other file byte for byte); exit 1 on drift.
- Re-verify [host notes](host-notes.md) every quarter and on every major host release; move
  resolved open items to §8 there with the date and version.
- Open the next `[X.Y.Z]` CHANGELOG entry only in the next release pull request.

## 8. Release checklist

Copy into the release pull request:

```text
- [ ] version X.Y.Z in SKILL.md metadata.version, top CHANGELOG entry ## [X.Y.Z] - date, tag vX.Y.Z
- [ ] selftest: failed 0 (skipped areas explained)
- [ ] node --test tests/unit: all pass
- [ ] tooling lint --strict on the skill: clean
- [ ] skills-ref validate: pass        - [ ] gh skill publish --dry-run: pass
- [ ] copilot skill list --json lists it - [ ] codex debug prompt-input shows it
- [ ] footprint: <=100 files, <=50 per folder, LF only, references <=300 lines
- [ ] evals (when required): plugin eval >= 0.8, trigger suite >= 0.8 (Claude, Copilot), models recorded
- [ ] manual matrix rows filled for this tag
- [ ] host-notes dates and open items updated
- [ ] signed tag pushed, release with archive + SHA256SUMS, topic agent-skills
```
