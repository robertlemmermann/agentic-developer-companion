# Third-party notices

The `agentic-developer-companion` skill is licensed under the Apache License 2.0 (the
`LICENSE` file at the repository root). This file lists third-party material included in the
skill and the attribution it requires.

## Included third-party code

**None as of 0.1.0.** No file in this skill is ported, vendored or copied from another
project, and the scripts have no runtime dependencies (Node.js built-ins only). Every check,
parser, validator rule and template was written for this skill.

## Rule for future ports

A file that ports or adapts code or text from another project:

1. starts with a header comment naming the source, in the file's own comment syntax:
   `// Ported from <repository URL> at <40-character commit>, <path> (<SPDX license id>)`
   (Markdown and templates: `<!-- Ported from … -->`; JSON cannot carry comments, so ported
   JSON is not allowed);
2. gets an entry below with the fields shown in the template, and the license text when
   the license requires it to travel with the code;
3. keeps the upstream copyright line.

`node tests/selftest.mjs --only footprint` fails when a `Ported from` header has no entry
here naming the same file and source. Only permissive licenses compatible with Apache-2.0 (MIT, BSD,
Apache-2.0, ISC) are accepted.

Entry template:

```text
### <path inside the skill>
- Source: <repository URL>, <path in the source>
- Commit: <40-character SHA>
- License: <SPDX id>, Copyright (c) <year> <holder>
- Changes: <what was changed>
```

## Specifications followed (no code included)

| Specification | Owner and license | How it is used |
|---|---|---|
| [Agent Skills specification](https://agentskills.io/specification) and its `skills-ref` validator rules | `agentskills/agentskills`: code Apache-2.0, documentation CC-BY-4.0 | the frontmatter rules are re-implemented in `scripts/lib/tooling-lint.mjs` and `scripts/lib/frontmatter.mjs`; `skills-ref` itself is only invoked when installed |
| Host documentation: GitHub Copilot (`github/docs`), VS Code (`microsoft/vscode-docs`), Claude Code docs, OpenAI Codex (`openai/codex` source) | the respective owners | facts are cited in the references and in the lint rule catalog; no text is copied |
| [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), [Semantic Versioning](https://semver.org/) | CC-BY-SA, CC-BY | the CHANGELOG format and the release rules |
| Test report and coverage formats (JUnit XML, TRX, Jest and RSpec JSON, `go test -json`, LCOV, Cobertura, Istanbul, Go cover profiles) | the respective projects | parsed by original code in `scripts/lib/reports.mjs` |

## Prior art credited (ideas, not code)

The design builds on ideas from these projects; nothing from them is included:

- [obra/superpowers](https://github.com/obra/superpowers) (MIT): the
  "verification before completion" discipline and per-host session-start output.
- [github/awesome-copilot](https://github.com/github/awesome-copilot) (MIT): the hook
  authoring guidance (paired `bash` and `powershell` entries) and the test-gap audit idea.
- [anthropics/skills](https://github.com/anthropics/skills) `skill-creator` (Apache-2.0):
  the description-tuning loop (labeled trigger queries, three runs per query, a 60/40
  train/validation split). `tooling trigger-set` also reads its `[{"query", "should_trigger"}]`
  list as an interchange format.
- [microsoft/waza](https://github.com/microsoft/waza), promptfoo, diff-cover, StrykerJS,
  Stryker.NET, cargo-mutants, gitleaks and trufflehog: tools the skill integrates with at run
  time when the user has installed them; they are not distributed with the skill.
