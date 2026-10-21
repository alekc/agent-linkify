import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyResolutions, configFromOptions, defaultConfig, fixText, formatFlags,
  newState, parseResolution, resolvePrompt, takeLines,
} from './linkify.ts'
import type { Config, Env } from './linkify.ts'

const FILES = new Set([
  '/r/a.ts', '/r/x/b.md', '/r/context/team.md', '/r/work', '/r/scratch/pr.md',
  '/home/u/notes.md', '/r/.claude/rules/output-style.md', '/r/README.md',
])
const BY_NAME: Record<string, string[]> = {
  'output-style.md': ['/r/.claude/rules/output-style.md'],
  'SKILL.md': ['/r/s/a/SKILL.md', '/r/s/b/SKILL.md'],
}
const env: Env = {
  exists: async (p) => FILES.has(p),
  findByName: async (n) => BY_NAME[n] ?? [],
}
const cfg = (over: Partial<Config> = {}): Config => defaultConfig({
  cwd: '/r',
  home: '/home/u',
  trackers: { ACME: 'https://linear.app/ws/issue/{key}' },
  ...over,
})
const fix = async (text: string, c = cfg()) => fixText(text, c, env)

test('rule 1: unwraps a link wrapped in backticks', async () => {
  const r = await fix('see `[a](/r/a.ts)` now')
  assert.equal(r.text, 'see [a](/r/a.ts) now')
})

test('rule 2: links a backticked absolute path that exists', async () => {
  assert.equal((await fix('`/r/x/b.md`')).text, '[b.md](/r/x/b.md)')
  assert.equal((await fix('`~/notes.md`')).text, '[notes.md](/home/u/notes.md)')
  assert.equal((await fix('`/r/gone.md`')).text, '`/r/gone.md`')
})

test('rule 2: keeps a :line suffix in the label only', async () => {
  assert.equal((await fix('`/r/a.ts:42`')).text, '[a.ts:42](/r/a.ts)')
})

test('rule 3: links a relative path that resolves under cwd', async () => {
  const r = await fix('`context/team.md` and `README.md`')
  assert.equal(
    r.text,
    '[team.md](/r/context/team.md) and [README.md](/r/README.md)',
  )
})

test('rule 3: leaves a bare word alone even when it exists', async () => {
  assert.equal((await fix('the `work` folder')).text, 'the `work` folder')
})

test('rule 4: links a bare absolute path in prose', async () => {
  const r = await fix('see /r/x/b.md. and /r/nope/c.md')
  assert.equal(r.text, 'see [b.md](/r/x/b.md). and /r/nope/c.md')
})

test('rule 5: makes a relative link target absolute, keeping the anchor', async () => {
  const r = await fix('[draft](scratch/pr.md#top)')
  assert.equal(r.text, '[draft](/r/scratch/pr.md#top)')
})

test('rule 5: flags a relative target that does not resolve', async () => {
  const r = await fix('[draft](scratch/none.md)')
  assert.equal(r.text, '[draft](scratch/none.md)')
  assert.equal(r.flags[0].rule, 'relative-target')
})

test('rule 6: flags a local link target that does not exist', async () => {
  const r = await fix('[a](/r/gone.md) and [b](/r/a.ts)')
  assert.equal(r.flags.length, 1)
  assert.equal(r.flags[0].rule, 'missing-target')
})

test('rule 7: flags a bare filename only when the name is unique', async () => {
  const r = await fix('see `output-style.md` and `SKILL.md`')
  assert.equal(r.text, 'see `output-style.md` and `SKILL.md`')
  assert.deepEqual(r.flags.map((f) => f.note), [
    '/r/.claude/rules/output-style.md',
  ])
})

test('rule 9: links a configured issue key, never inside a link', async () => {
  const r = await fix('ACME-12 is done, see [ACME-12](https://x.io/ACME-12)')
  assert.equal(
    r.text,
    '[ACME-12](https://linear.app/ws/issue/ACME-12) is done, ' +
      'see [ACME-12](https://x.io/ACME-12)',
  )
})

test('code spans are protected from plain-text rules', async () => {
  assert.equal((await fix('run `ACME-12 /r/a.ts x`')).text, 'run `ACME-12 /r/a.ts x`')
})

test('toggle off: UTF-8, CI/CD and unknown keys produce nothing', async () => {
  const r = await fix('UTF-8, SHA-256, CI/CD, and/or FOO-7')
  assert.equal(r.text, 'UTF-8, SHA-256, CI/CD, and/or FOO-7')
  assert.deepEqual(r.flags, [])
  assert.deepEqual(r.candidates, [])
})

test('toggle on: ignored prefixes still cost no model call', async () => {
  const r = await fix('UTF-8 and CI/CD', cfg({ modelResolve: true }))
  assert.deepEqual(r.candidates, [])
})

test('rule 11: PR refs flag with the toggle off, ask with it on', async () => {
  const off = await fix('fixed in PR #95')
  assert.deepEqual(off.flags.map((f) => f.text), ['PR #95'])
  const on = await fix('fixed in PR #95', cfg({ modelResolve: true }))
  assert.deepEqual(on.flags, [])
  assert.deepEqual(on.candidates.map((c) => c.text), ['PR #95'])
  assert.equal(on.candidates[0].context, 'fixed in PR #95')
})

test('rule 10 and 12: candidates only with the toggle on', async () => {
  const text = 'the repo octo/foo, octo/bar@dev and FOO-7'
  const off = await fix(text)
  assert.deepEqual(off.flags, [])
  const on = await fix(text, cfg({ modelResolve: true }))
  assert.deepEqual(on.candidates.map((c) => c.text), [
    'octo/foo', 'octo/bar@dev', 'FOO-7',
  ])
})

test('a sentence full stop is not part of a repo candidate', async () => {
  const r = await fix('in the repo octo/widgets.', cfg({ modelResolve: true }))
  assert.deepEqual(r.candidates.map((c) => c.text), ['octo/widgets'])
})

test('askRules narrows which candidates go to the model', async () => {
  const c = cfg({ modelResolve: true, askRules: ['pr-ref'] })
  const r = await fix('PR #3 in the repo octo/foo', c)
  assert.deepEqual(r.candidates.map((x) => x.text), ['PR #3'])
})

test('rule 14: links a bare URL, keeping trailing punctuation out', async () => {
  const r = await fix('(see https://example.com/a).')
  assert.equal(r.text, '(see [https://example.com/a](https://example.com/a)).')
})

test('rule 14: a bold or table-cell URL stops at the markup', async () => {
  const u = 'https://x.io/a'
  assert.equal((await fix(`**${u}**`)).text, `**[${u}](${u})**`)
  assert.equal((await fix(`| ${u}| x |`)).text, `| [${u}](${u})| x |`)
})

test('candidate context is the text around a hit late in a long line', async () => {
  const line = 'x '.repeat(200) + 'fixed in PR #95 today ' + 'y '.repeat(200)
  const r = await fix(line, cfg({ modelResolve: true }))
  const ctx = r.candidates[0].context
  assert.match(ctx, /fixed in PR #95 today/)
  assert.ok(ctx.startsWith('...') && ctx.endsWith('...'))
  assert.ok(ctx.length < 300)
})

test('rule 14: links a URL that is a whole code span', async () => {
  assert.equal(
    (await fix('`https://x.io/p`')).text,
    '[https://x.io/p](https://x.io/p)',
  )
  assert.equal((await fix('`https://x.io/{id}`')).text, '`https://x.io/{id}`')
})

test('a URL containing key and path shapes is one link', async () => {
  const u = 'https://github.com/o/r/blob/main/x/ABC-123.md'
  const r = await fix(u, cfg({ modelResolve: true }))
  assert.equal(r.text, `[${u}](${u})`)
  assert.deepEqual(r.candidates, [])
})

test('autolinks and existing links are left alone', async () => {
  const t = '<https://x.io/a> and [x](https://x.io/b)'
  assert.equal((await fix(t)).text, t)
})

test('a fence opened in one call is honoured in the next', async () => {
  const st = newState()
  const c = cfg()
  const a = await fixText('```sh\n', c, env, st)
  const b = await fixText('cat /r/x/b.md\n```\n', c, env, st)
  const d = await fixText('/r/x/b.md', c, env, st)
  assert.equal(a.text + b.text + d.text,
    '```sh\ncat /r/x/b.md\n```\n[b.md](/r/x/b.md)')
})

test('a shorter fence inside a longer one does not close it', async () => {
  const r = await fix('````\n```\n/r/x/b.md\n````\n/r/x/b.md')
  assert.equal(r.text, '````\n```\n/r/x/b.md\n````\n[b.md](/r/x/b.md)')
})

test('dash rule: off by default, fix replaces with a double hyphen', async () => {
  const [en, em] = [String.fromCharCode(0x2013), String.fromCharCode(0x2014)]
  const t = `one ${em} two${en}three`
  assert.equal((await fix(t)).text, t)
  const r = await fix(t, cfg({ modes: { dash: 'fix' } }))
  assert.equal(r.text, 'one -- two -- three')
})

test('resolvePrompt dedupes and quotes the references', () => {
  const p = resolvePrompt([
    { rule: 'pr-ref', text: 'PR #9', context: 'in "PR #9"' },
    { rule: 'pr-ref', text: 'PR #9', context: 'again' },
  ])
  assert.equal(p.split('\n').filter((l) => l.startsWith('- ')).length, 1)
  assert.match(p, /- "PR #9" in: "in \\"PR #9\\""/)
})

test('parseResolution keeps known keys with string or null values', () => {
  const cands = [
    { rule: 'pr-ref' as const, text: 'PR #9', context: '' },
    { rule: 'repo-ref' as const, text: 'a/b', context: '' },
  ]
  const reply = '```json\n{"PR #9": "https://github.com/o/r/pull/9",' +
    ' "a/b": null, "x": "https://evil.io/", "PR #8": 3}\n```'
  assert.deepEqual(parseResolution(reply, cands), {
    'PR #9': 'https://github.com/o/r/pull/9',
    'a/b': null,
  })
  assert.equal(parseResolution('no json here', cands), null)
  assert.equal(parseResolution('[1, 2]', cands), null)
  assert.equal(parseResolution('{' + 'x'.repeat(30000) + '}', cands), null)
})

test('applyResolutions links allowed URLs and flags the rest', () => {
  const c = cfg({ modelResolve: true })
  const cands = [
    { rule: 'pr-ref' as const, text: 'PR #9', context: '' },
    { rule: 'repo-ref' as const, text: 'a/b', context: '' },
    { rule: 'unknown-key' as const, text: 'FOO-1', context: '' },
    { rule: 'unknown-key' as const, text: 'BAR-2', context: '' },
  ]
  const text = 'PR #9 in the repo a/b, FOO-1, BAR-2\n```\nPR #9\n```'
  const r = applyResolutions(text, cands, {
    'PR #9': 'https://github.com/o/r/pull/9',
    'a/b': 'https://evil.io/a/b',
    'FOO-1': null,
  }, c)
  assert.equal(
    r.text,
    '[PR #9](https://github.com/o/r/pull/9) in the repo a/b, FOO-1, BAR-2' +
      '\n```\nPR #9\n```',
  )
  assert.deepEqual(r.flags.map((f) => `${f.text}:${f.note}`), [
    'a/b:unresolved', 'BAR-2:unresolved',
  ])
})

test('applyResolutions leaves code spans and existing links alone', () => {
  const cands = [{ rule: 'pr-ref' as const, text: 'PR #9', context: '' }]
  const url = 'https://github.com/o/r/pull/9'
  const text = '`PR #9` and [PR #9](https://x.io/9)'
  const r = applyResolutions(text, cands, { 'PR #9': url }, cfg())
  assert.equal(r.text, text)
})

test('applyResolutions flags every candidate when the call failed', () => {
  const cands = [{ rule: 'pr-ref' as const, text: 'PR #9', context: '' }]
  const r = applyResolutions('PR #9', cands, null, cfg())
  assert.equal(r.text, 'PR #9')
  assert.equal(r.flags[0].note, 'model unavailable')
})

test('takeLines splits complete lines from the remainder', () => {
  assert.deepEqual(takeLines('a\nb\nc'), ['a\nb\n', 'c'])
  assert.deepEqual(takeLines('abc'), ['', 'abc'])
})

test('formatFlags summarises and caps the list', () => {
  assert.equal(formatFlags([]), '')
  const f = Array.from({ length: 7 }, (_, i) => ({
    rule: 'pr-ref' as const, text: `PR #${i}`, note: 'not linked',
  }))
  assert.equal(
    formatFlags(f, 2),
    'linkify: 7 flagged: PR #0 (not linked); PR #1 (not linked); 5 more',
  )
})

test('rule 15: folds a reference and its own URL into one link', async () => {
  const u = 'https://github.com/octo/widgets/pull/123'
  const r = await fix(`see octo/widgets#123 (${u}) now`, cfg({ modelResolve: true }))
  assert.equal(r.text, `see [octo/widgets#123](${u}) now`)
  assert.deepEqual([r.flags, r.candidates], [[], []])
  const pr = await fix('PR #4 (https://gitlab.com/o/r/-/merge_requests/4).')
  assert.equal(pr.text, '[PR #4](https://gitlab.com/o/r/-/merge_requests/4).')
  const key = await fix('ACME-5 (https://x.atlassian.net/browse/ACME-5)')
  assert.equal(key.text, '[ACME-5](https://x.atlassian.net/browse/ACME-5)')
})

test('rule 15: leaves a URL that names something else, and obeys off', async () => {
  const other = await fix('PR #4 (https://github.com/o/r/pull/5)')
  assert.equal(other.text, 'PR #4 ([https://github.com/o/r/pull/5](https://github.com/o/r/pull/5))')
  assert.deepEqual(other.flags.map((f) => f.text), ['PR #4'])
  const off = await fix('PR #4 (https://github.com/o/r/pull/4)', cfg({ modes: { 'ref-url': 'off' } }))
  assert.deepEqual(off.flags.map((f) => f.text), ['PR #4'])
})

test('configFromOptions parses rows and reports malformed ones', () => {
  const { cfg: c, bad } = configFromOptions({
    trackers: ['ABC=https://x.atlassian.net/browse/{key}', 'nope', 7],
    modes: ['dash=fix', 'pr-ref=loud'],
    hosts: ['git.example.com'],
    modelResolve: 'yes',
  })
  assert.deepEqual(c.trackers, { ABC: 'https://x.atlassian.net/browse/{key}' })
  assert.deepEqual(c.modes, { dash: 'fix' })
  assert.ok(c.hosts.includes('github.com') && c.hosts.includes('git.example.com'))
  assert.equal(c.modelResolve, false)
  assert.deepEqual(bad, ['nope', 'pr-ref=loud'])
  assert.equal(configFromOptions({ modelResolve: true }).cfg.modelResolve, true)
})
