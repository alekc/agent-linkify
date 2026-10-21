import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import plugin from './linkify.ts'

type Toast = { body: { message: string } }

async function setup(options: Record<string, unknown>, failToast = false) {
  const dir = await realpath(await mkdtemp(`${tmpdir()}/linkify-oc-`))
  await writeFile(`${dir}/notes.md`, 'x')
  const toasts: string[] = []
  const client = {
    tui: {
      showToast: async (t: Toast) => {
        if (failToast) throw new Error('no tui')
        toasts.push(t.body.message)
      },
    },
  }
  const input = { directory: dir, client } as unknown as Parameters<typeof plugin.server>[0]
  const hooks = await plugin.server(input, options)
  const complete = async (text: string) => {
    const out = { text }
    await hooks['experimental.text.complete']?.({ sessionID: 's', messageID: 'm', partID: 'p' }, out)
    return out.text
  }
  return { dir, toasts, complete }
}

test('rewrites a finished part and toasts its flags', async () => {
  // modelResolve is ignored: with it on, PR #4 would vanish into a
  // candidate nobody resolves instead of being flagged.
  const { dir, toasts, complete } = await setup({
    trackers: ['ACME=https://linear.app/ws/issue/{key}'], modelResolve: true,
  })
  const text = await complete(`see ${dir}/notes.md, ACME-5 and PR #4\nat https://example.com/x`)
  assert.equal(
    text,
    `see [notes.md](${dir}/notes.md), [ACME-5](https://linear.app/ws/issue/ACME-5) and PR #4\n` +
      'at [https://example.com/x](https://example.com/x)',
  )
  assert.deepEqual(toasts, ['1 flagged: PR #4 (not linked)'])
})

test('leaves a part with nothing to fix alone and stays quiet', async () => {
  const { toasts, complete } = await setup({})
  assert.equal(await complete('plain `code` and UTF-8'), 'plain `code` and UTF-8')
  assert.deepEqual(toasts, [])
})

test('a failing toast keeps the rewrite', async () => {
  const { dir, complete } = await setup({}, true)
  assert.equal(await complete(`${dir}/notes.md PR #1`), `[notes.md](${dir}/notes.md) PR #1`)
})

test('reports malformed options once, at load', async () => {
  const { toasts } = await setup({ modes: ['dash=loud'] })
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(toasts, ['ignored malformed options: dash=loud'])
})
