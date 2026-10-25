# tooling-practices: operating agentic tooling like software

The practices the `tooling scaffold`, `lint`, `modify` and `plugin` modes enforce or
recommend for instructions, skills, agents, prompt files, hooks, plugins and MCP configs, in
one place. Apply them to the user's tooling; this skill follows them itself
([release](release.md)).

## Contents

1. [Versions and changelogs](#1-versions-and-changelogs)
2. [Names never change](#2-names-never-change)
3. [Deprecation](#3-deprecation)
4. [Evals before edits](#4-evals-before-edits)
5. [Review checklist for prompt and instruction changes](#5-review-checklist-for-prompt-and-instruction-changes)
6. [Ownership and branch protection](#6-ownership-and-branch-protection)
7. [Placement in monorepos](#7-placement-in-monorepos)
8. [Secrets and hostnames](#8-secrets-and-hostnames)
9. [Migration catalog](#9-migration-catalog)
10. [Manual fallbacks (guidance-only mode)](#10-manual-fallbacks-guidance-only-mode)

## 1. Versions and changelogs

- Semantic versioning with Git tags `vX.Y.Z` and a `CHANGELOG.md` per repository that ships
  tooling ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/) sections).
- **Skills**: `metadata.version: "X.Y.Z"` in the frontmatter (a string; the six spec fields
  only), mirroring the tag, because `gh skill install` resolves the latest tag first.
- **Plugins**: `version` in the manifest. In Claude Code a pinned manifest version blocks
  updates until it changes, and an omitted one lets every commit be an update: choose
  deliberately. Marketplace entries pin `ref` and a 40-character `sha`.
- **Instructions and agents** have no version field: the repository tag and the changelog
  entry are the version.
- Breaking: a renamed mode or argument, a removed field, a changed output contract, a hook
  that must be re-registered, a raised host minimum.

`node "$ADC" tooling modify compare <path> --note "why" --accept [--bump patch|minor|major|none]`
writes the changelog entry into the repository's `CHANGELOG.md`, bumps `metadata.version`
(skills) or `version` (plugins), and keeps the new measurements as the next baseline. It
refuses when the verdict is not `accept`.

## 2. Names never change

Renaming a published skill or plugin breaks every install, pin and `gh skill update`.

- Keep the old name as a thin skill that points to the new one:

  ```markdown
  ---
  name: old-name
  description: Deprecated alias of new-name; use new-name for releasing and publishing workflows.
  metadata:
    version: "2.0.0"
  ---

  This skill was renamed to `new-name` on 2026-10-25 and will be removed in 3.0.0.
  Use `/new-name` (Codex: `$new-name`) instead.
  ```

  Add `disable-model-invocation: true` where only Copilot and Claude Code read the skill
  (both honor it; it is outside the spec, so `skills-ref validate` and `tooling lint
  --strict` report it, and Codex ignores it).
- Plugins: a marketplace `renames` entry (Claude Code) instead of a new name.
- Custom agents and prompt files: keep the old file name with a one-line pointer for one
  minor release.

## 3. Deprecation

A deprecation has a date, a removal version and a migration path, all three written in the
CHANGELOG ("Deprecated" section) and at the top of the affected file. Remove no earlier
than the next minor release (major from 1.0.0). Run `tooling lint` after the removal: it
reports links and `@imports` that point at the removed file.

## 4. Evals before edits

Build the evaluation before changing behavior ("build evaluations first" is Anthropic's own
guidance for skills). For any non-trivial change to a description, instruction or agent:

1. A trigger set for skills (about 20 queries, 8–10 near misses):
   `node "$ADC" tooling trigger-set <skill-dir> --init`, replace every `TODO`, check it
   with `tooling trigger-set <skill-dir>` (free).
2. At least one outcome case (`claude plugin eval` layout `evals/<case>/prompt.md` +
   `graders/*.md`, or the skill-creator `evals/evals.json`; the formats are not
   interchangeable).
3. A baseline: `node "$ADC" tooling modify baseline <path>` (lint, context cost, trigger
   score when a runner exists, a rendered-context snapshot, outcome results, portability),
   stored under `.adc/tooling/`.
4. The change, then `node "$ADC" tooling modify compare <path> --note "why"`. Accept only
   with no new lint errors, trigger and outcome scores not below the baseline beyond the
   measured variance, context cost not up without a stated reason, and no host lost.
   `tooling modify restore <path>` puts the baseline copy back after a `reject`.

Paid runs (`--host … --run`, `claude plugin eval`) bill the account: set `--max-cost-usd`.

## 5. Review checklist for prompt and instruction changes

Paste into the pull request that changes tooling:

```text
- [ ] One intent per change; what changed and why, in one sentence each
- [ ] Before/after from `tooling modify compare`: lint delta, always-on token delta per host,
      trigger score delta, outcome delta (or "not measured" with the reason)
- [ ] Portability: hosts that load it before and after (no host-specific syntax in shared
      files: no dollar-ARGUMENTS placeholder, dollar-brace CLAUDE_* variable or
      bang-backtick dynamic context in a SKILL.md meant for all hosts)
- [ ] Commands work on Windows (no bash-only syntax without a PowerShell equivalent)
- [ ] No secrets, tokens, internal hostnames or user-specific absolute paths
- [ ] No contradiction with another instruction file (same subject, different rule)
- [ ] `tooling lint --strict` clean on the changed files
- [ ] CHANGELOG entry and version bump (skills: metadata.version; plugins: version)
- [ ] No rename of a published skill or plugin (section 2)
```

## 6. Ownership and branch protection

Tooling in a repository runs on every colleague's machine: Copilot runs repository hooks
after folder trust only, Claude Code after workspace trust, Codex after a one-time review.
Give it owners and protect it:

```text
# .github/CODEOWNERS
/.github/copilot-instructions.md  @your-org/agent-tooling-owners
/.github/instructions/            @your-org/agent-tooling-owners
/.github/skills/                  @your-org/agent-tooling-owners
/.github/agents/                  @your-org/agent-tooling-owners
/.github/prompts/                 @your-org/agent-tooling-owners
/.github/hooks/                   @your-org/agent-tooling-owners
/.github/copilot/                 @your-org/agent-tooling-owners
/AGENTS.md                        @your-org/agent-tooling-owners
/CLAUDE.md                        @your-org/agent-tooling-owners
/.claude/                         @your-org/agent-tooling-owners
/.agents/                         @your-org/agent-tooling-owners
/.codex/                          @your-org/agent-tooling-owners
/.mcp.json                        @your-org/agent-tooling-owners
/.vscode/mcp.json                 @your-org/agent-tooling-owners
```

Require code-owner review on the default branch, pin vendored third-party skills to a tag
and its SHA, check them with `doctor --verify-vendored`, and protect release tags with a
ruleset (signed tags where possible).

## 7. Placement in monorepos

- **One concern per skill**, one topic per instruction file; nothing task-specific in the
  always-on files.
- **Nearest file wins in practice**: Codex concatenates `AGENTS.md` from the repository root
  down to the working directory (32 KiB in total); Claude Code loads nested `CLAUDE.md` and
  `.claude/skills/` on demand; Copilot CLI also checks the parent `.github/skills/`. Put
  package-specific rules in that package's `AGENTS.md` and keep the root file short.
- **Path scoping instead of length**: `.github/instructions/<topic>.instructions.md` with
  `applyTo` globs (Copilot), `.claude/rules/<topic>.md` with `paths` (Claude Code), nested
  `AGENTS.md` (Codex).
- **Canonical source**: `AGENTS.md` holds the shared rules; `CLAUDE.md` contains
  `@AGENTS.md` plus Claude-only notes; no `CLAUDE.local.md` in a project that relies on
  `AGENTS.md`.
- **Skill directories**: `.agents/skills/` serves Copilot and Codex, `.claude/skills/` Claude
  Code, `.github/skills/` Copilot code review ([host notes](host-notes.md) §3).
- Measure always-on cost per host with `node "$ADC" tooling cost --host all` before and
  after moving content; the biggest always-on consumers come first.

## 8. Secrets and hostnames

Never in prompts, instructions, skills, agents or committed MCP configs. Use environment
references (`${VAR}` in `.mcp.json`, `COPILOT_MCP_*` secrets for the cloud agent, the host's
secret store), keep credentials in git-ignored files (the `.adc/.env.live` pattern), and
redact them in logs. `tooling lint` reports literal secrets in MCP headers and env, `curl …
| sh` and base64 blobs in skills and instructions, and instructions that disable hooks,
permissions or sandboxes (security group). Internal hostnames and absolute user paths are
lint findings too: they leak infrastructure and break on other machines.

## 9. Migration catalog

Each migration runs the baseline/compare loop of §4, so the result is proven equivalent:
`node "$ADC" tooling modify <path> --migrate <kind> [--to host]`.

| `--migrate` | From | To | Hosts that read the source | Hosts that read the result |
|---|---|---|---|---|
| `prompt-to-skill` | `.github/prompts/<name>.prompt.md` | a skill with `disable-model-invocation: true`; `agent`, `model`, `tools` dropped (as VS Code's own migration does) | VS Code Local harness, Visual Studio | Copilot (all surfaces), Claude Code, Codex (where installed) |
| `chatmode-to-agent` | `.github/chatmodes/*.chatmode.md` | `.github/agents/<name>.agent.md` | VS Code (legacy) | Copilot CLI, VS Code, cloud agent |
| `claude-commands-to-skills` | `.claude/commands/*.md` | `.claude/skills/<name>/SKILL.md` (or `.agents/skills/`) | Claude Code (legacy), Copilot CLI | Claude Code, Copilot, Codex |
| `vscode-mcp-to-mcp-json` | `.vscode/mcp.json` (`servers`, `${input:…}`) | `.mcp.json` (`mcpServers`, `${VAR}`) | VS Code | Copilot CLI (`.vscode/mcp.json` is not read since 1.0.22), Claude Code, VS Code Copilot harness |
| `copilot-hooks-to-camel` | legacy Copilot hook files | `{"version": 1, "hooks": {...}}` with camelCase events and `bash` + `powershell` | older Copilot CLI | Copilot CLI, VS Code, cloud agent (`bash` only) |

Translating between hosts without changing the format family is `tooling port <path> --to
copilot|claude|codex|all`; it reports every dropped field.

## 10. Manual fallbacks (guidance-only mode)

Without Node, do the same steps by hand and write the results into the pull request:

- **Lint**: check the frontmatter by eye against [tooling lint](tooling-lint.md) (name equals
  the directory, lowercase and hyphens, at most 64 characters; description at most 1,024; the
  six spec fields only; block-style YAML; no unquoted `: ` in scalars), then run the host
  validators that exist: `uvx --from 'git+https://github.com/agentskills/agentskills#subdirectory=skills-ref' skills-ref validate <skill-dir>`,
  `gh skill publish --dry-run`, `copilot skill list --json`, `codex debug prompt-input "x"`.
- **Cost**: characters divided by 4 approximates tokens; `wc -c AGENTS.md .github/copilot-instructions.md`
  (PowerShell: `(Get-Item AGENTS.md).Length`); list which files are always on.
- **Baseline and compare**: copy the artifact to `.adc/tooling/<name>/<date>/` before editing;
  after editing, `git diff --no-index .adc/tooling/<name>/<date>/<file> <file>`, re-run the same
  validators and the same handful of trigger queries in each host, and record both results.
- **Changelog and version**: edit `CHANGELOG.md` and `metadata.version` by hand.
