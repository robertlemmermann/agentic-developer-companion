# tooling-practices: operating agentic tooling like software

The practices the `tooling scaffold`, `lint`, `modify` and `plugin` modes enforce or
recommend for instructions, skills, agents, prompt files, hooks, plugins and MCP configs.
Apply them to the user's tooling; this skill follows them itself ([release](release.md)).
Without Node, each mode's playbook has a manual fallback; write its results into the pull request.

## Contents

1. [Versions and changelogs](#1-versions-and-changelogs)
2. [Names never change](#2-names-never-change)
3. [Deprecation](#3-deprecation)
4. [Evals before edits](#4-evals-before-edits)
5. [Review checklist for prompt and instruction changes](#5-review-checklist-for-prompt-and-instruction-changes)
6. [Ownership and branch protection](#6-ownership-and-branch-protection)
7. [Placement in monorepos](#7-placement-in-monorepos)
8. [Secrets and hostnames](#8-secrets-and-hostnames)

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
- Breaking (bumps the minor before 1.0.0, the major after): a renamed or removed mode,
  command or argument, a removed or retyped field, a changed output contract, a hook that must
  be re-registered, a raised host minimum.
- `tooling modify compare ... --accept` writes the changelog entry and the version bump for a
  measured change ([tooling-modify](tooling-modify.md) §4).

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
  (outside the spec: `skills-ref validate` and `tooling lint --strict` report it, Codex
  ignores it; [host notes](host-notes.md) §5).
- Plugins: a marketplace `renames` entry (Claude Code) instead of a new name.
- Custom agents and prompt files: keep the old file name with a one-line pointer for one
  minor release.

## 3. Deprecation

A deprecation has a date, a removal version and a migration path, all three written in the
CHANGELOG ("Deprecated" section) and at the top of the affected file. Remove no earlier
than the next minor release (major from 1.0.0). Run `tooling lint` after the removal: it
reports links and `@imports` that point at the removed file.

## 4. Evals before edits

Build the evaluation before changing behavior. For any non-trivial change to a description,
instruction or agent: a trigger set for skills ([tooling-eval](tooling-eval.md) §1), at least
one outcome case ([tooling-eval](tooling-eval.md) §4), a baseline, the change, then compare
and accept or restore ([tooling-modify](tooling-modify.md)); format migrations run the same
loop (§5 there). Paid runs (`--host … --run`, `claude plugin eval`) bill the account: set
`--max-cost-usd`.

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
- Path scoping instead of length, and one `AGENTS.md` source for shared rules:
  [tooling-optimize](tooling-optimize.md) §4; skill directories: [host notes](host-notes.md) §3.
- Measure always-on cost per host with `node "$ADC" tooling cost --host all` before and
  after moving content; the biggest always-on consumers come first.

## 8. Secrets and hostnames

Never in prompts, instructions, skills, agents or committed MCP configs. Use environment
references (`${VAR}` in `.mcp.json`, `COPILOT_MCP_*` secrets for the cloud agent, the host's
secret store), keep credentials in git-ignored files (the `.adc/.env.live` pattern), and
redact them in logs. Internal hostnames and absolute user paths leak infrastructure and break
on other machines. [tooling lint](tooling-lint.md) reports them (`IN-HOSTNAME`, `IN-ABS-PATH`)
and the security group: literal secrets, `curl … | sh`, base64 blobs, text that disables guards.
