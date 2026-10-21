# linkify

Rewrites a coding agent's chat replies so file paths, URLs and issue keys
render as markdown links, before the text reaches the screen. Telling the model
"always link paths" in a prompt works until a long reply, when it drifts back
to bare `src/app.ts` and `ABC-123`; this does it in code instead.

It runs in Claude Code (2.1.305 or later, as a plugin hooks module) and in
OpenCode (as a plugin). The OpenCode adapter passes its tests but has not yet
been run in a live OpenCode session.

## Install in Claude Code

At the prompt of a terminal session:

```
/plugin install linkify --marketplace alekc/agent-linkify
```

From a shell:

```
claude plugin install linkify --marketplace alekc/agent-linkify
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then
Plugins, Add marketplace with `alekc/agent-linkify`, then Add plugin.

## Install in OpenCode

Clone this repository and add the adapter to an OpenCode config (`opencode.json`, or
`~/.config/opencode/opencode.json` for every project), with its absolute path and the same
options as below minus `modelResolve`:

```json
{ "plugin": [["/path/to/agent-linkify/opencode/linkify.ts", { "trackers": ["ABC=..."] }]] }
```

## Layout

The repository root is the Claude Code plugin and its marketplace. A Claude Code
plugin module may import only files inside its own plugin folder, so the core
and the OpenCode adapter live here too.

| Path | What |
| --- | --- |
| `core/linkify.ts` | The rules. No imports; filesystem and model access come in through callbacks |
| `core/linkify.spec.ts` | Core tests, run with `npm test` (Node 23.6 or later strips the types) |
| `hooks/register.ts` | The Claude Code adapter (a mod hooks module) |
| `hooks/register.test.ts` | Adapter tests, run with `claude plugin test .` |
| `opencode/linkify.ts` | The OpenCode adapter (an OpenCode plugin module) |
| `opencode/linkify.spec.ts` | Its tests, also run by `npm test` |

The mod's engine-written `tsconfig.json` covers `hooks/` only, so `opencode/` is outside it.

## Configuring it in Claude Code

To run a local checkout instead of the installed plugin: `claude --plugin-dir <checkout>` for
one session, or the checkout's absolute path in `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json` for every session.

Settings live under `pluginConfigs` in settings, keyed by the plugin name, and show in the
config menu:

```json
{
  "pluginConfigs": {
    "linkify": {
      "options": {
        "trackers": ["ABC=https://linear.app/<workspace>/issue/{key}"],
        "modelResolve": true
      }
    }
  }
}
```

`/linkify` shows whether the hidden model call is on; `/linkify model on|off` switches it
and remembers the choice across sessions, and `/linkify model default` goes back to the
`modelResolve` option.

## How the OpenCode adapter differs

- It rewrites each text part once, when the part finishes. While the part streams, the screen
  shows the raw text; the rewrite replaces it at the end of the part (read from OpenCode
  1.18.20's `session/processor.ts`, not yet seen in the TUI).
- No hidden model call: `modelResolve` is ignored, so PR, repo and unknown-key matches follow
  their rule modes (PR references are flagged, the others left alone).
- Flags show as a warning toast per part. `opencode run` has no TUI, so they are dropped there.
- Subagent (child session) text is rewritten too.

## How the Claude Code adapter behaves

- Main-thread reply text only. Thinking, tool calls and subagent replies pass through.
- Text is released a line at a time, fixed. From the first line holding a reference for the
  model, the rest of that text block is held until the block ends, then one hidden request
  resolves all of them. The request is `$.model.fork`: it reuses the conversation's prompt
  cache, has no tools, and never enters the transcript. It has no timeout of its own: a mod
  hook gets 10 seconds of its own time per response, a `$.clock` wait spends it, and a fork in
  flight does not. The fork always settles, with an answer or an API error.
- Flags print once per turn, under the answer.
- Every call out of the module fails soft. A hook that throws mid-stream is skipped by the
  engine and the text it holds is lost, so a failed fork, `git` or filesystem call leaves the
  text unchanged instead.

## Rules

Each rule is `fix` (rewrite the text), `flag` (leave it, list it in a line
under the reply) or `off`. Defaults below; override per rule in `modes`.

| # | Id | Looks for | Default |
| --- | --- | --- | --- |
| 1 | `backtick-link` | A markdown link wrapped in backticks | fix |
| 2 | `code-path` | A code span that is one absolute path that exists | fix |
| 3 | `code-relpath` | A code span that is one relative path (with a `/` or an extension) that exists under the working directory | fix |
| 4 | `bare-path` | An absolute path in prose that exists | fix |
| 5 | `relative-target` | A link with a relative target: made absolute when it exists, flagged when not | fix |
| 6 | `missing-target` | A link to a local file that does not exist | flag |
| 7 | `bare-filename` | A code span naming a file that is not under the working directory but has exactly one match in the repo | flag |
| 9 | `tracker-key` | An issue key whose prefix is in `trackers` | fix |
| 10 | `unknown-key` | An issue-key shape with an unconfigured prefix | off |
| 11 | `pr-ref` | `PR #95`, `MR !12`, `owner/repo#95` | flag |
| 12 | `repo-ref` | `owner/repo@branch`, or `owner/repo` next to "repo", "fork" or "clone" | off |
| 13 | `dash` | An em or en dash, fixed to ` -- ` | off |
| 14 | `bare-url` | A bare `http(s)://` URL, linked with the full URL as its label | fix |
| 14 | `code-url` | A code span that is one URL | fix |
| 15 | `ref-url` | A PR, repo or issue reference followed by its own URL in parentheses, `o/r#12 (https://...)`, made one link; left alone when the URL does not name the reference | fix |

Rule 8 (a remote file named by a repo-relative path) cannot be decided from
the text and is not implemented. Fenced code blocks, inline code (except the
whole-span cases above), existing links and `<...>` autolinks are never
rewritten. A fence indented four or more spaces (under a nested bullet) is
not recognised, so its contents are treated as prose.

## The hidden model call

With `modelResolve: true`, matches for the rules listed in `askRules` (10, 11
and 12 by default) are not flagged. The adapter sends them to the model in a
hidden request (`resolvePrompt`), reads the JSON reply (`parseResolution`),
and links each one whose URL is on the `hosts` allowlist (`applyResolutions`).
A reference the model answers `null` for stays as text. One with no usable
answer is flagged, and a failed call flags them all. Prefixes in `keyIgnore`
(`UTF`, `SHA`, ...) never reach the model.

`modelResolve` is off by default: a shared install should not make model
calls nobody turned on. Only the Claude Code adapter can make the call; the
OpenCode adapter always runs as if it were off.

Each held block costs one request that re-reads the conversation from the
prompt cache, about a second in testing. Blocks with no such reference cost
nothing.

## Options

| Plugin option | Core config | Meaning |
| --- | --- | --- |
| (session) | `cwd`, `home` | Where relative paths and `~` resolve |
| `trackers` | `trackers` | `PREFIX=URL` rows, `{key}` standing for the whole key |
| `modes` | `modes` | `rule=fix\|flag\|off` rows, rule ids from the table above |
| `modelResolve` | `modelResolve` | The hidden model call toggle |
| (none) | `askRules` | Which candidate rules go to the model |
| `hosts` | `hosts` | Extra hosts a model-supplied URL may point at; subdomains match |
| (none) | `keyIgnore` | Key prefixes that are never issue keys |

A malformed `trackers` or `modes` row is skipped and reported once when the
session starts.

## License

MIT, see [LICENSE](LICENSE).
