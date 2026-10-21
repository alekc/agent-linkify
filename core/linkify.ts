// Rewrites assistant chat text so file paths, URLs and issue keys render as
// markdown links. No imports: I/O comes in through Env, so one file serves
// both the Claude Code mod and the OpenCode plugin. Rules: ../README.md.

export type RuleMode = 'fix' | 'flag' | 'off'

export type RuleId =
  | 'backtick-link'
  | 'code-path'
  | 'code-relpath'
  | 'bare-path'
  | 'relative-target'
  | 'missing-target'
  | 'bare-filename'
  | 'tracker-key'
  | 'unknown-key'
  | 'pr-ref'
  | 'repo-ref'
  | 'dash'
  | 'bare-url'
  | 'code-url'
  | 'ref-url'

export type Config = {
  cwd: string
  home: string
  // Issue-key prefix to URL template, `{key}` replaced by the whole key.
  trackers: Record<string, string>
  modes: Partial<Record<RuleId, RuleMode>>
  // The hidden model call for unknown keys, PR and repo references.
  modelResolve: boolean
  askRules: RuleId[]
  // Hosts a model-supplied URL may point at; subdomains match too.
  hosts: string[]
  keyIgnore: string[]
}

export type Env = {
  exists: (absPath: string) => Promise<boolean>
  findByName?: (name: string) => Promise<string[]>
}

export type Flag = { rule: RuleId; text: string; note: string }
export type Candidate = { rule: RuleId; text: string; context: string }
export type Pass = { text: string; flags: Flag[]; candidates: Candidate[] }
export type State = { fence: string | null; seen: Map<string, boolean> }

export const DEFAULT_MODES: Record<RuleId, RuleMode> = {
  'backtick-link': 'fix',
  'code-path': 'fix',
  'code-relpath': 'fix',
  'bare-path': 'fix',
  'relative-target': 'fix',
  'missing-target': 'flag',
  'bare-filename': 'flag',
  'tracker-key': 'fix',
  'unknown-key': 'off',
  'pr-ref': 'flag',
  'repo-ref': 'off',
  'dash': 'off',
  'bare-url': 'fix',
  'code-url': 'fix',
  'ref-url': 'fix',
}

export const DEFAULT_KEY_IGNORE = [
  'UTF', 'SHA', 'ISO', 'RFC', 'TLS', 'SSL', 'AES', 'RSA', 'MD', 'UTC', 'GMT',
  'BST', 'PEP', 'ECMA', 'IPV', 'HTTP', 'CVE', 'GPT', 'COVID', 'EN', 'BS',
]

export function defaultConfig(over: Partial<Config> = {}): Config {
  return {
    cwd: '/',
    home: '/',
    trackers: {},
    modes: {},
    modelResolve: false,
    askRules: ['unknown-key', 'pr-ref', 'repo-ref'],
    hosts: ['github.com', 'gitlab.com', 'linear.app', 'atlassian.net'],
    keyIgnore: DEFAULT_KEY_IGNORE,
    ...over,
  }
}

const MODE_NAMES: string[] = ['fix', 'flag', 'off']

function rows(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
}

// `PREFIX=value` rows from a multi-value option; a malformed row is skipped
// and returned in `bad` for the adapter to report, never silently guessed at.
function pairs(list: string[], bad: string[]): [string, string][] {
  const out: [string, string][] = []
  for (const row of list) {
    const at = row.indexOf('=')
    if (at < 1) bad.push(row)
    else out.push([row.slice(0, at).trim(), row.slice(at + 1).trim()])
  }
  return out
}

// Plugin options, the same shape in both adapters: `trackers`, `modes` and
// `hosts` are lists of strings, `modelResolve` a boolean.
export function configFromOptions(
  options: Record<string, unknown>,
): { cfg: Config; bad: string[] } {
  const bad: string[] = []
  const trackers = Object.fromEntries(pairs(rows(options.trackers), bad))
  const modes: Partial<Record<RuleId, RuleMode>> = {}
  for (const [rule, m] of pairs(rows(options.modes), bad)) {
    if (MODE_NAMES.includes(m)) modes[rule as RuleId] = m as RuleMode
    else bad.push(`${rule}=${m}`)
  }
  const modelResolve = options.modelResolve === true
  const cfg = defaultConfig({ trackers, modes, modelResolve })
  return { cfg: { ...cfg, hosts: [...cfg.hosts, ...rows(options.hosts)] }, bad }
}

export function newState(): State {
  return { fence: null, seen: new Map() }
}

function mode(cfg: Config, rule: RuleId): RuleMode {
  return cfg.modes[rule] ?? DEFAULT_MODES[rule]
}

function asks(cfg: Config, rule: RuleId): boolean {
  return cfg.modelResolve && cfg.askRules.includes(rule)
}

// ---- line buffering for streamed text

// Splits streamed text into complete lines and the unfinished remainder; the
// caller passes the remainder through fixText when its block ends.
export function takeLines(buffer: string): [string, string] {
  const cut = buffer.lastIndexOf('\n')
  if (cut < 0) return ['', buffer]
  return [buffer.slice(0, cut + 1), buffer.slice(cut + 1)]
}

// ---- paths

function normalize(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

function absolute(p: string, cfg: Config): string {
  if (p === '~' || p.startsWith('~/')) return normalize(cfg.home + p.slice(1))
  if (p.startsWith('/')) return normalize(p)
  return normalize(cfg.cwd + '/' + p)
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

// `file.ts:42` and `file.ts:42-50` point into a file; the suffix stays in
// the label and leaves the target, which must be a path that exists.
function splitLine(p: string): [string, string] {
  const m = /^(.*?)(:\d+(?:-\d+)?)$/.exec(p)
  return m ? [m[1] ?? p, m[2] ?? ''] : [p, '']
}

function target(t: string): string {
  return /[\s()]/.test(t) ? `<${t}>` : t
}

function link(label: string, t: string): string {
  return `[${label.replace(/([\[\]])/g, '\\$1')}](${target(t)})`
}

async function exists(abs: string, env: Env, st: State): Promise<boolean> {
  const hit = st.seen.get(abs)
  if (hit !== undefined) return hit
  let ok = false
  try {
    ok = await env.exists(abs)
  } catch {
    ok = false
  }
  st.seen.set(abs, ok)
  return ok
}

// ---- segmentation: code spans, links and autolinks are protected

type Seg =
  | { kind: 'text'; raw: string }
  | { kind: 'code'; raw: string; body: string }
  | { kind: 'link'; raw: string; label: string; href: string; image: boolean }
  | { kind: 'auto'; raw: string }

const SEG_RE = new RegExp(
  [
    '(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)',
    '(!?)\\[([^\\]\\n]*)\\]\\((<[^>\\n]*>|[^)\\s]+)(\\s+"[^"\\n]*")?\\)',
    '<[a-zA-Z][a-zA-Z0-9+.-]*:[^>\\s]*>',
  ].join('|'),
  'g',
)

function segments(line: string): Seg[] {
  const out: Seg[] = []
  let last = 0
  for (const m of line.matchAll(SEG_RE)) {
    const at = m.index ?? 0
    if (at > last) out.push({ kind: 'text', raw: line.slice(last, at) })
    if (m[1] !== undefined) {
      out.push({ kind: 'code', raw: m[0], body: m[2] ?? '' })
    }
    else if (m[4] !== undefined) {
      const href = (m[5] ?? '').replace(/^<(.*)>$/, '$1')
      out.push({
        kind: 'link', raw: m[0], label: m[4], href, image: m[3] === '!',
      })
    } else out.push({ kind: 'auto', raw: m[0] })
    last = at + m[0].length
  }
  if (last < line.length) out.push({ kind: 'text', raw: line.slice(last) })
  return out
}

// ---- matches inside plain text

type Kind = 'refurl' | 'url' | 'path' | 'pr' | 'repo' | 'key' | 'dash'
type Hit = {
  start: number; end: number; kind: Kind; value: string
  ref?: string; url?: string
}

const DASHES = String.fromCharCode(0x2013, 0x2014)
const DASH_RE = new RegExp(`\\s*[${DASHES}]\\s*`, 'g')
const PRIORITY: Kind[] = ['refurl', 'url', 'path', 'pr', 'repo', 'key', 'dash']
const NAME = '[A-Za-z0-9][\\w.-]*\\/[A-Za-z0-9][\\w.-]*'

// A reference followed by its own URL in parentheses, `o/r#12 (https://...)`:
// the form a markdown link takes when a terminal cannot draw it.
const REF_URL_RE = new RegExp(
  `(?<![\\w/.~@-])(${NAME}[#!]\\d+` +
    '|(?:[Pp][Rr]s?|[Mm][Rr]s?|pull request|merge request)\\s*[#!]?\\d+' +
    `|[A-Z][A-Z0-9]{1,9}-\\d+|${NAME}(?:@[\\w./-]*\\w)?)` +
    ' \\((https?:\\/\\/[^\\s()<>`"\'\\[\\]*|]+)\\)',
  'g',
)

// The URL must name the reference, so a reference and an unrelated link
// that happen to sit side by side are left alone.
function namesRef(ref: string, url: string): boolean {
  const u = url.toLowerCase()
  if (/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(ref)) return u.includes(ref.toLowerCase())
  const num = /(\d+)$/.exec(ref)?.[1]
  if (num !== undefined) return new RegExp(`/${num}(?:[/?#]|$)`).test(u)
  return u.includes('/' + (ref.split('@')[0] ?? ref).toLowerCase())
}

function refUrls(s: string): Hit[] {
  const out: Hit[] = []
  for (const m of s.matchAll(REF_URL_RE)) {
    const [whole, ref, url] = m
    if (ref === undefined || url === undefined || !namesRef(ref, url)) continue
    const start = m.index ?? 0
    out.push({ start, end: start + whole.length, kind: 'refurl', value: whole, ref, url })
  }
  return out
}

function trimTail(s: string): string {
  let out = s.replace(/[.,;:!?'"]+$/, '')
  while (out.endsWith(')')) {
    const open = out.split('(').length
    const close = out.split(')').length
    if (close <= open) break
    out = out.slice(0, -1).replace(/[.,;:!?'"]+$/, '')
  }
  return out
}

function collect(s: string, re: RegExp, kind: Kind, group = 0): Hit[] {
  const out: Hit[] = []
  for (const m of s.matchAll(re)) {
    const whole = m[0]
    const sub = m[group]
    if (sub === undefined) continue
    const start = (m.index ?? 0) + (group ? whole.indexOf(sub) : 0)
    const value = kind === 'dash' ? sub : trimTail(sub)
    if (value) out.push({ start, end: start + value.length, kind, value })
  }
  return out
}

function plainHits(s: string, refUrl = true): Hit[] {
  const all: Hit[] = [
    ...(refUrl ? refUrls(s) : []),
    ...collect(s, /https?:\/\/[^\s<>`"'\[\]*|]+/g, 'url'),
    ...collect(
      s,
      /(?<![\w.~\/:@-])~?\/[\w.@+%-]+(?:\/[\w.@+%-]+)+\/?(?::\d+(?:-\d+)?)?/g,
      'path',
    ),
    ...collect(s, new RegExp(`(?<![\\w/.~@-])${NAME}[#!]\\d+\\b`, 'g'), 'pr'),
    ...collect(
      s,
      /\b(?:PRs?|MRs?|pull request|merge request)\s*[#!]?\d+\b/gi,
      'pr',
    ),
    ...collect(
      s,
      new RegExp(`(?<![\\w/.~@-])${NAME}@[\\w./-]*[\\w]`, 'g'),
      'repo',
    ),
    ...collect(
      s,
      new RegExp(
        `\\b(?:repo|repository|fork|clone|cloned)\\s+(?:of\\s+|at\\s+)?(${NAME})`,
        'gi',
      ),
      'repo',
      1,
    ),
    ...collect(
      s,
      new RegExp(`(?<![\\w/.~@-])(${NAME})\\s+(?:repo|repository)\\b`, 'gi'),
      'repo',
      1,
    ),
    ...collect(s, /(?<![\w\/.-])[A-Z][A-Z0-9]{1,9}-\d+(?![\w-])/g, 'key'),
    ...collect(s, DASH_RE, 'dash'),
  ]
  all.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind))
  const kept: Hit[] = []
  for (const h of all) {
    if (kept.every((k) => h.end <= k.start || h.start >= k.end)) kept.push(h)
  }
  return kept.sort((a, b) => a.start - b.start)
}

function keyPrefix(key: string): string {
  return key.slice(0, key.lastIndexOf('-'))
}

// ---- the pass

// `line` and `at` (the current segment's offset in it) give each candidate
// the text around it: one markdown paragraph is often one very long line.
type Out = { flags: Flag[]; candidates: Candidate[]; line: string; at: number }

const AROUND = 120

function around(line: string, at: number, len: number): string {
  const a = Math.max(0, at - AROUND)
  const b = Math.min(line.length, at + len + AROUND)
  const head = a > 0 ? '...' : ''
  const tail = b < line.length ? '...' : ''
  return head + line.slice(a, b).trim() + tail
}

async function fixPlain(
  s: string, cfg: Config, env: Env, st: State, out: Out,
): Promise<string> {
  let res = ''
  let last = 0
  for (const h of plainHits(s, mode(cfg, 'ref-url') !== 'off')) {
    res += s.slice(last, h.start)
    last = h.end
    res += await fixHit(h, cfg, env, st, out)
  }
  return res + s.slice(last)
}

async function fixHit(
  h: Hit, cfg: Config, env: Env, st: State, out: Out,
): Promise<string> {
  const v = h.value
  const note = (rule: RuleId, why: string, fixed: string): string => {
    const m = mode(cfg, rule)
    if (m === 'fix') return fixed
    if (m === 'flag') out.flags.push({ rule, text: v, note: why })
    return v
  }
  if (h.kind === 'refurl') {
    return note('ref-url', 'reference beside its URL', link(h.ref ?? v, h.url ?? v))
  }
  if (h.kind === 'url') return note('bare-url', 'bare URL', link(v, v))
  if (h.kind === 'path') {
    const [p, suffix] = splitLine(v)
    const abs = absolute(p, cfg)
    if (!(await exists(abs, env, st))) return v
    return note('bare-path', 'bare path', link(basename(p) + suffix, abs))
  }
  if (h.kind === 'dash') return note('dash', 'em or en dash', ' -- ')
  if (h.kind === 'key') {
    const prefix = keyPrefix(v)
    const tpl = cfg.trackers[prefix]
    if (tpl) {
      return note('tracker-key', 'bare issue key', link(v, tpl.replaceAll('{key}', v)))
    }
    if (cfg.keyIgnore.includes(prefix)) return v
    return candidate('unknown-key', h, cfg, out)
  }
  return candidate(h.kind === 'pr' ? 'pr-ref' : 'repo-ref', h, cfg, out)
}

function candidate(rule: RuleId, h: Hit, cfg: Config, out: Out): string {
  const v = h.value
  if (asks(cfg, rule)) {
    const context = around(out.line, out.at + h.start, v.length)
    out.candidates.push({ rule, text: v, context })
  } else if (mode(cfg, rule) === 'flag') {
    out.flags.push({ rule, text: v, note: 'not linked' })
  }
  return v
}

const PATHISH = /^(?:~?\/|\.{1,2}\/)?[\w.@+%-]+(?:\/[\w.@+%-]+)*\/?(?::\d+(?:-\d+)?)?$/
const EXT = /\.[A-Za-z][A-Za-z0-9]{0,7}$/

async function fixCode(
  seg: Extract<Seg, { kind: 'code' }>, cfg: Config, env: Env, st: State,
  out: Out,
): Promise<string> {
  const body = seg.body.trim()
  const flag = (rule: RuleId, note: string, fixed: string): string => {
    const m = mode(cfg, rule)
    if (m === 'fix') return fixed
    if (m === 'flag') out.flags.push({ rule, text: seg.raw, note })
    return seg.raw
  }
  const inner = segments(body)
  const only = inner.length === 1 ? inner[0] : undefined
  if (only && only.kind === 'link') {
    const fixed = await fixLink(only, cfg, env, st, out)
    return flag('backtick-link', 'link wrapped in backticks', fixed)
  }
  if (/^https?:\/\/[^\s{}<>`]+$/.test(body)) {
    return flag('code-url', 'URL in backticks', link(body, body))
  }
  if (!PATHISH.test(body)) return seg.raw
  const [p, suffix] = splitLine(body)
  if (p.startsWith('/') || p.startsWith('~/')) {
    const abs = absolute(p, cfg)
    if (!(await exists(abs, env, st))) return seg.raw
    return flag('code-path', 'path in backticks', link(basename(p) + suffix, abs))
  }
  if (!p.includes('/') && !EXT.test(p)) return seg.raw
  const abs = absolute(p, cfg)
  if (await exists(abs, env, st)) {
    return flag('code-relpath', 'relative path', link(basename(p) + suffix, abs))
  }
  if (p.includes('/') || !env.findByName) return seg.raw
  let found: string[] = []
  try {
    found = await env.findByName(p)
  } catch {
    found = []
  }
  const one = found[0]
  if (found.length !== 1 || one === undefined) return seg.raw
  const m = mode(cfg, 'bare-filename')
  if (m === 'fix') return link(p + suffix, one)
  if (m === 'flag') {
    out.flags.push({ rule: 'bare-filename', text: seg.raw, note: one })
  }
  return seg.raw
}

async function fixLink(
  seg: Extract<Seg, { kind: 'link' }>, cfg: Config, env: Env, st: State,
  out: Out,
): Promise<string> {
  const href = seg.href
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith('#')) {
    return seg.raw
  }
  const hash = href.indexOf('#')
  const pathPart = hash < 0 ? href : href.slice(0, hash)
  const anchor = hash < 0 ? '' : href.slice(hash)
  const [p, suffix] = splitLine(pathPart)
  const abs = absolute(p, cfg)
  const ok = await exists(abs, env, st)
  const isAbs = p.startsWith('/')
  if (isAbs && ok) return seg.raw
  if (isAbs) {
    if (mode(cfg, 'missing-target') === 'flag') {
      out.flags.push({ rule: 'missing-target', text: seg.raw, note: 'missing' })
    }
    return seg.raw
  }
  const m = mode(cfg, 'relative-target')
  if (ok && m === 'fix') {
    const bang = seg.image ? '!' : ''
    return bang + link(seg.label, abs + suffix + anchor)
  }
  if (m !== 'off') {
    const note = ok ? 'relative target' : 'relative target, not found'
    out.flags.push({ rule: 'relative-target', text: seg.raw, note })
  }
  return seg.raw
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/

// Returns the fence state after `line`: opened, closed or unchanged.
function fenceAfter(fence: string | null, line: string): string | null {
  const f = FENCE.exec(line)
  const run = f?.[1]
  if (fence === null) return run ?? null
  const closes = run !== undefined && run[0] === fence[0] &&
    run.length >= fence.length && line.trim() === run
  return closes ? null : fence
}

// Fixes complete lines of one text block. Feed lines in order with the same
// State; text inside a fenced block passes through untouched.
export async function fixText(
  text: string, cfg: Config, env: Env, st: State = newState(),
): Promise<Pass> {
  const out: Out = { flags: [], candidates: [], line: '', at: 0 }
  const done: string[] = []
  for (const line of text.split('\n')) {
    const was = st.fence
    st.fence = fenceAfter(was, line)
    if (was !== null || st.fence !== null) {
      done.push(line)
      continue
    }
    out.line = line
    out.at = 0
    let res = ''
    for (const seg of segments(line)) {
      if (seg.kind === 'text') res += await fixPlain(seg.raw, cfg, env, st, out)
      else if (seg.kind === 'code') res += await fixCode(seg, cfg, env, st, out)
      else if (seg.kind === 'link') res += await fixLink(seg, cfg, env, st, out)
      else res += seg.raw
      out.at += seg.raw.length
    }
    done.push(res)
  }
  return { text: done.join('\n'), flags: out.flags, candidates: out.candidates }
}

// ---- the hidden model call: prompt, reply, application

export function resolvePrompt(cands: Candidate[]): string {
  const seen = new Set<string>()
  const rows: string[] = []
  for (const c of cands) {
    if (seen.has(c.text)) continue
    seen.add(c.text)
    rows.push(`- ${JSON.stringify(c.text)} in: ${JSON.stringify(c.context)}`)
  }
  return [
    'The reply you are writing right now contains the references below.',
    'For each, give the https URL it should link to: the issue, pull or',
    'merge request, repository or branch it names. Answer null when it is',
    'not such a reference, or when this conversation does not establish',
    'which one it is. Never guess a repository, host or number.',
    'Answer with one JSON object and nothing else, keyed by the reference',
    'text exactly as given.',
    '',
    ...rows,
  ].join('\n')
}

const MAX_REPLY = 20000

// The fork's reply is model output: parsed defensively, unknown keys dropped.
// Returns null when there is no usable object, which callers treat as failure.
export function parseResolution(
  reply: string, cands: Candidate[],
): Record<string, string | null> | null {
  if (reply.length > MAX_REPLY) return null
  const a = reply.indexOf('{')
  const b = reply.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  let obj: unknown
  try {
    obj = JSON.parse(reply.slice(a, b + 1))
  } catch {
    return null
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  const out: Record<string, string | null> = {}
  for (const c of cands) {
    if (!Object.hasOwn(obj, c.text)) continue
    const v = (obj as Record<string, unknown>)[c.text]
    if (v === null || typeof v === 'string') out[c.text] = v
  }
  return out
}

export function allowedUrl(url: string, cfg: Config): boolean {
  const m = /^https:\/\/([a-z0-9.-]+)(?::\d+)?\/[^\s<>()\[\]`"]*$/i.exec(url)
  if (!m) return false
  const host = (m[1] ?? '').toLowerCase()
  return cfg.hosts.some((h) => host === h || host.endsWith('.' + h))
}

// Links resolved candidates in text that fixText already produced. Start it
// on a line outside a fence: the held text is rescanned from a fresh state.
export function applyResolutions(
  text: string, cands: Candidate[],
  resolved: Record<string, string | null> | null, cfg: Config,
): { text: string; flags: Flag[] } {
  const flags: Flag[] = []
  const urls = new Map<string, string>()
  const flagged = new Set<string>()
  for (const c of cands) {
    if (flagged.has(c.text) || urls.has(c.text)) continue
    const v = resolved ? resolved[c.text] : undefined
    if (v === null) continue
    if (v !== undefined && allowedUrl(v, cfg)) {
      urls.set(c.text, v)
      continue
    }
    flagged.add(c.text)
    const note = resolved ? 'unresolved' : 'model unavailable'
    flags.push({ rule: c.rule, text: c.text, note })
  }
  if (urls.size === 0) return { text, flags }
  let fence: string | null = null
  const lines = text.split('\n').map((line) => {
    const was = fence
    fence = fenceAfter(was, line)
    if (was !== null || fence !== null) return line
    return segments(line).map((seg) => {
      if (seg.kind !== 'text') return seg.raw
      let res = ''
      let last = 0
      for (const h of plainHits(seg.raw)) {
        const url = urls.get(h.value)
        if (!url || (h.kind !== 'pr' && h.kind !== 'repo' && h.kind !== 'key')) {
          continue
        }
        res += seg.raw.slice(last, h.start) + link(h.value, url)
        last = h.end
      }
      return res + seg.raw.slice(last)
    }).join('')
  })
  return { text: lines.join('\n'), flags }
}

export function formatFlags(
  flags: Flag[], max = 5, prefix = 'linkify: ',
): string {
  if (flags.length === 0) return ''
  const shown = flags.slice(0, max).map((f) => `${f.text} (${f.note})`)
  const more = flags.length > max ? `; ${flags.length - max} more` : ''
  return `${prefix}${flags.length} flagged: ${shown.join('; ')}${more}`
}
