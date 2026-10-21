// OpenCode adapter: rewrites each finished assistant text part on
// `experimental.text.complete` and shows its flags in a TUI toast.
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { Plugin } from '@opencode-ai/plugin'
import { configFromOptions, fixText, formatFlags, newState } from '../core/linkify.ts'
import type { Config, Env } from '../core/linkify.ts'

function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', args, { cwd, timeout: 5000 }, (err, out) => done(err ? null : out))
  })
}

function makeEnv(cwd: string): Env {
  const byName = new Map<string, string[]>()
  let top: Promise<string> | undefined
  const root = () => (top ??= git(['rev-parse', '--show-toplevel'], cwd)
    .then((out) => out?.trim() ?? ''))
  return {
    exists: (p) => access(p).then(() => true, () => false),
    findByName: async (name) => {
      const hit = byName.get(name)
      if (hit) return hit
      const out = await git(['ls-files', '-co', '--full-name', '--', `:(glob)**/${name}`], cwd)
      const dir = await root()
      const found = out !== null && dir
        ? out.split('\n').filter(Boolean).map((p) => `${dir}/${p}`)
        : []
      byName.set(name, found)
      return found
    },
  }
}

const server: Plugin = async (input, options = {}) => {
  const parsed = configFromOptions(options)
  // No hidden model call here, so PR, repo and unknown-key matches fall back
  // to their rule modes instead of being sent off and dropped.
  const cfg: Config = {
    ...parsed.cfg, cwd: input.directory, home: homedir(), modelResolve: false,
  }
  const env = makeEnv(input.directory)
  // No TUI under `opencode run`: the toast fails and the flags are dropped.
  const toast = async (message: string) => {
    try {
      await input.client.tui.showToast({
        body: { title: 'linkify', message, variant: 'warning' },
      })
    } catch {}
  }
  if (parsed.bad.length) void toast(`ignored malformed options: ${parsed.bad.join(', ')}`)

  return {
    // The processor reads `out.text` back, so a throw here would abort the
    // reply: anything that fails leaves the part as it came.
    'experimental.text.complete': async (_e, out) => {
      try {
        const pass = await fixText(out.text, cfg, env, newState())
        out.text = pass.text
        const line = formatFlags(pass.flags, 5, '')
        if (line) await toast(line)
      } catch {}
    },
  }
}

export default { id: 'linkify', server }
