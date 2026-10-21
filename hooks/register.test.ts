import { expect, mock, test } from 'claude-code/testing'

const STEP = { turnId: 't1', index: 0, model: 'm', messageCount: 1 }
const DONE = {
  turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn',
  usage: null,
} as const

// Stands for the engine beneath the plugin: the model streams `pieces` as
// text chunks of block 0, then a stop chunk unless `stop` is false.
function engine(on: any, pieces: string[], stop = true) {
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'linkify' } }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({
    value: e.path === '/r/docs/a.md',
  }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('turn.step', async function* () {
    for (const text of pieces) yield { kind: 'text', index: 0, text }
    if (stop) yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return DONE
  })
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
}

async function run($: any, extra: object = {}) {
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false })
  let text = ''
  for await (const c of $.turn.step({ ...STEP, ...extra })) {
    if (c.kind === 'text') text += c.text
  }
  const done = await $.turn.complete({
    turnId: 't1', answer: text, durationMs: 1, isAborted: false,
    reason: 'answer', ...extra,
  })
  return { text, note: done.text }
}

test('a path split across chunks is linked', async ($, on) => {
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  engine(on, ['see `docs/', 'a.md` now\n', 'and https://x.io/a'])
  const r = await run($)
  expect(r.text).toBe(
    'see [a.md](/r/docs/a.md) now\nand [https://x.io/a](https://x.io/a)',
  )
})

test('text left unfinished when the stream ends is still released', async ($, on) => {
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  engine(on, ['one\n', 'two https://x.io/b'], false)
  expect((await run($)).text).toBe('one\ntwo [https://x.io/b](https://x.io/b)')
})

// No clock mock: a `$.clock` wait spends the hook budget, so one added to
// the fork path throws here and turns the link into a flag.
test('with the model call on, a PR ref is linked from the fork', async ($, on) => {
  mock.store(on, { modelResolve: true })
  mock.env(on, { HOME: '/home/u' })
  engine(on, ['fixed in PR #9 today\n'])
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: '{"PR #9": "https://github.com/o/r/pull/9"}',
      usage: null,
    },
  }))
  const r = await run($)
  expect(r.text).toBe('fixed in [PR #9](https://github.com/o/r/pull/9) today\n')
})

test('a failed fork leaves the text and flags it under the answer', async ($, on) => {
  mock.store(on, { modelResolve: true })
  mock.env(on, { HOME: '/home/u' })
  engine(on, ['fixed in PR #9 today\n'])
  on('model.fork', () => ({
    value: { isAnswered: false, reason: 'nothing-to-fork' },
  }))
  const r = await run($)
  expect(r.text).toBe('fixed in PR #9 today\n')
  expect(r.note).toBe('1 flagged: PR #9 (model unavailable)')
})

test('a subagent step passes through untouched', async ($, on) => {
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  engine(on, ['see https://x.io/a\n'])
  const r = await run($, { agentId: 'a1' })
  expect(r.text).toBe('see https://x.io/a\n')
})

test('a fork that throws still releases the text', async ($, on) => {
  mock.store(on, { modelResolve: true })
  mock.env(on, { HOME: '/home/u' })
  engine(on, ['fixed in PR #9 today\n'])
  on('model.fork', () => {
    throw new Error('refused')
  })
  const r = await run($)
  expect(r.text).toBe('fixed in PR #9 today\n')
  expect(r.note).toBe('1 flagged: PR #9 (model unavailable)')
})
