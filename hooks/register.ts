// Claude Code adapter: rewrites main-thread reply text on `turn.step`, a line
// at a time, and prints flags under the answer on `turn.complete`.
import type { Register } from 'claude-code'
import {
  applyResolutions, configFromOptions, fixText, formatFlags, newState,
  parseResolution, resolvePrompt, takeLines,
} from '../core/linkify.ts'
import type { Candidate, Config, Env, Flag, State } from '../core/linkify.ts'

const STORE_KEY = 'modelResolve'

type Block = {
  buf: string
  st: State
  held: string
  cands: Candidate[]
  index: number
}

export const register: Register = (on, options) => {
  const parsed = configFromOptions(options)
  const bad = parsed.bad
  const optionModel = parsed.cfg.modelResolve
  let cfg: Config = parsed.cfg
  const byName = new Map<string, string[]>()
  const flags = new Map<string, Flag[]>()

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? '/'
    const stored = await $.store.get(STORE_KEY)
    cfg = {
      ...cfg,
      cwd: e.cwd,
      home,
      modelResolve: typeof stored === 'boolean' ? stored : optionModel,
    }
    await $.command.register({
      name: 'linkify',
      description: 'Show or switch the hidden model call that resolves PR and repo links',
      argumentHint: '[model on|off|default]',
      immediate: true,
    })
    if (bad.length) $.ui.log(`linkify: ignored malformed options: ${bad.join(', ')}`)
    return next(e)
  })

  on('command.run', { command: 'linkify' }, async ($, e) => {
    const [what, value] = e.args.trim().split(/\s+/)
    if (what === 'model' && (value === 'on' || value === 'off')) {
      await $.store.set(STORE_KEY, value === 'on')
      cfg = { ...cfg, modelResolve: value === 'on' }
    } else if (what === 'model' && value === 'default') {
      await $.store.delete(STORE_KEY)
      cfg = { ...cfg, modelResolve: optionModel }
    } else if (what) {
      return { text: 'Usage: /linkify [model on|off|default]' }
    }
    const src = (await $.store.get(STORE_KEY)) === undefined ? 'plugin option' : 'set by /linkify'
    return { text: `hidden model call ${cfg.modelResolve ? 'on' : 'off'} (${src})` }
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    let top: Promise<string> | undefined
    const root = () => (top ??= $.process.run(['git', 'rev-parse', '--show-toplevel'])
      .then((r) => (r.exitCode === 0 ? r.stdout.trim() : '')))
    const env: Env = {
      exists: (p) => $.fs.exists(p),
      findByName: async (name) => {
        const hit = byName.get(name)
        if (hit) return hit
        const r = await $.process.run(
          ['git', 'ls-files', '-co', '--full-name', '--', `:(glob)**/${name}`],
          { timeoutMs: 5000 },
        )
        const dir = await root()
        const found = r.exitCode === 0 && dir
          ? r.stdout.split('\n').filter(Boolean).map((p) => `${dir}/${p}`)
          : []
        byName.set(name, found)
        return found
      },
    }
    const turnFlags = flags.get(e.turnId) ?? []
    flags.set(e.turnId, turnFlags)
    const blocks = new Map<number, Block>()

    // A hook that throws mid-stream is skipped and the text it holds is lost,
    // so every call out of the module fails soft to "no answer". No timer:
    // a $.clock wait spends the hook's 10 s budget, a fork in flight does not.
    const resolve = async (cands: Candidate[]) => {
      try {
        const r = await $.model.fork({ prompt: resolvePrompt(cands) })
        return r.isAnswered ? parseResolution(r.text, cands) : null
      } catch {
        return null
      }
    }

    const fix = async (line: string, st: State) => {
      try {
        return await fixText(line, cfg, env, st)
      } catch {
        return { text: line, flags: [], candidates: [] }
      }
    }

    // Fixes the complete lines of `text` one at a time. From the first line
    // with a candidate, text is held for the block's single model call.
    const feed = async (b: Block, text: string): Promise<string> => {
      let out = ''
      for (const line of text.split(/(?<=\n)/)) {
        const pass = await fix(line, b.st)
        turnFlags.push(...pass.flags)
        if (b.cands.length || pass.candidates.length) {
          b.held += pass.text
          b.cands.push(...pass.candidates)
        } else out += pass.text
      }
      return out
    }

    const flush = async (b: Block): Promise<string> => {
      let out = b.buf ? await feed(b, b.buf) : ''
      b.buf = ''
      if (b.cands.length) {
        const r = applyResolutions(b.held, b.cands, await resolve(b.cands), cfg)
        turnFlags.push(...r.flags)
        out += r.text
        b.held = ''
        b.cands = []
      }
      return out
    }

    // Releases what each text block holds: before any non-text chunk, which
    // may close a block, and at the end of a stream that ends on text.
    async function* release() {
      for (const b of blocks.values()) {
        const out = await flush(b)
        if (out) yield { kind: 'text' as const, index: b.index, text: out }
      }
    }

    const stream = next(e)
    while (true) {
      const r = await stream.next()
      if (r.done) {
        yield* release()
        return r.value
      }
      const c = r.value
      if (c.kind === 'text') {
        let b = blocks.get(c.index)
        if (!b) {
          b = { buf: '', st: newState(), held: '', cands: [], index: c.index }
          blocks.set(c.index, b)
        }
        const [lines, rest] = takeLines(b.buf + c.text)
        b.buf = rest
        const out = lines ? await feed(b, lines) : ''
        if (out) yield { ...c, text: out }
        continue
      }
      yield* release()
      yield c
    }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    // The engine prefixes the line with the plugin's name already.
    const line = formatFlags(flags.get(e.turnId) ?? [], 5, '')
    flags.delete(e.turnId)
    return line ? { ...r, text: line } : r
  })
}
