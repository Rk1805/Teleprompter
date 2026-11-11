// Script parsing + fuzzy sequential speech matcher. Pure TS, no DOM (tested in engine.test.ts).

export type Word = { text: string; bold: boolean; tok: number[] }
export type Item =
  | { kind: 'heading'; text: string; slide: number; level: number }
  | { kind: 'cue'; text: string; slide: number }
  | { kind: 'sentence'; words: Word[]; slide: number; first: number; last: number }
export type Slide = { n: number; title: string; start: number; dur: number } // seconds
export type Script = { items: Item[]; tokens: { t: string; item: number }[]; slides: Slide[] }

const UNITS = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ')
const TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ')

// "thirty one" -> "31", "one" -> "1", so spoken and written numbers compare equal
function numberWords(t: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < t.length; i++) {
    const ten = TENS.indexOf(t[i])
    const unit = UNITS.indexOf(t[i])
    if (ten >= 0) {
      const u = UNITS.indexOf(t[i + 1] ?? '')
      if (u > 0 && u < 10) {
        out.push(String((ten + 2) * 10 + u))
        i++
      } else out.push(String((ten + 2) * 10))
    } else out.push(unit >= 0 ? String(unit) : t[i])
  }
  return out
}

export function normalize(s: string): string[] {
  const t = s
    .toLowerCase()
    .replace(/\bper cent\b/g, 'percent')
    .replace(/[’‘]/g, "'")
    .replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/%/g, ' percent ')
    .replace(/×/g, ' times ')
    .replace(/&/g, ' and ')
    .replace(/[–—-]/g, ' ')
    .replace(/(\d)\.(\d)/g, '$1§$2') // keep 2.2 as one token
    .replace(/[^a-z0-9'§ ]+/g, ' ')
    .replace(/§/g, '.')
    .replace(/'s\b/g, '')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter(Boolean)
  return numberWords(t)
}

const toSec = (m: string) => {
  const [a, b] = m.split(':').map(Number)
  return a * 60 + b
}

export function parseScript(md: string): Script {
  const lines = md.split(/\r?\n/)
  const qa = lines.findIndex((l) => /^#{1,3}\s*(q\s*&\s*a|q&a bank|questions)/i.test(l))
  const body = qa > 0 ? lines.slice(0, qa) : lines
  // Scripts that wrap speech in quotes: only quoted paragraphs are spoken; otherwise all prose is.
  const quoted = body.some((l) => /^(\*\*)?"/.test(l.trim()))
  const items: Item[] = []
  const tokens: Script['tokens'] = []
  const slides: Slide[] = []
  let slide = 0
  let clock = 0

  const addSpoken = (text: string) => {
    const raw = text.trim().replace(/^\*\*"|^"/, '').replace(/"\*\*$|"$/, '')
    let bold = false
    const words: Word[] = []
    for (const w of raw.split(/\s+/).filter(Boolean)) {
      const n = (w.match(/\*\*/g) || []).length
      const clean = w.replace(/\*/g, '')
      words.push({ text: clean, bold: bold || n > 0, tok: [] })
      if (n % 2) bold = !bold
    }
    let cur: Word[] = []
    const flush = () => {
      if (!cur.length) return
      const idx = items.length
      const first = tokens.length
      for (const w of cur) for (const t of normalize(w.text)) w.tok.push(tokens.push({ t, item: idx }) - 1)
      if (tokens.length === first) return
      items.push({ kind: 'sentence', words: cur, slide, first, last: tokens.length - 1 })
      cur = []
    }
    words.forEach((w, i) => {
      cur.push(w)
      const next = words[i + 1]
      if (next && /[.!?]["'”*)]*$/.test(w.text) && /^["'“(*]*[A-Z0-9]/.test(next.text)) flush()
    })
    flush()
  }

  let para: string[] = []
  const endPara = () => {
    if (para.length) addSpoken(para.join(' '))
    para = []
  }

  for (const line of body) {
    const l = line.trim()
    const h = l.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      endPara()
      const title = h[2].replace(/\*/g, '')
      const sm = title.match(/^slide\s+(\d+)\s*[:.-]?\s*(.*)$/i)
      if (sm) {
        slide = Number(sm[1])
        const tm = sm[2].match(/·\s*(\d+:\d{2})/)
        const dur = tm ? toSec(tm[1]) : 0
        slides.push({ n: slide, title: sm[2].split('·')[0].trim(), start: clock, dur })
        clock += dur
        items.push({ kind: 'heading', text: slides[slides.length - 1].title, slide, level: 3 })
      } else if (!quoted || slide > 0 || /part|section/i.test(title)) {
        items.push({ kind: 'heading', text: title, slide, level: h[1].length })
      }
      continue
    }
    if (!l || /^(---+|\|)/.test(l) || l.startsWith('>')) {
      endPara()
      continue
    }
    // stage cue, possibly followed by spoken text on the same line
    const cue = l.match(/^\*?\[([^\]]+)\]\*?\s*(.*)$/)
    if (cue) {
      endPara()
      if (slide > 0 || !quoted) items.push({ kind: 'cue', text: cue[1], slide })
      if (cue[2] && (!quoted || /^(\*\*)?"/.test(cue[2]))) addSpoken(cue[2])
      continue
    }
    if (quoted) {
      if (/^(\*\*)?"/.test(l) && slide > 0) addSpoken(l)
      continue
    }
    if (/^[-*+]\s|^\d+\.\s/.test(l)) {
      endPara()
      continue
    }
    para.push(l)
  }
  endPara()
  return { items, tokens, slides }
}

// ---------- matcher ----------

const STOP = new Set(
  'the a an of and to in is it that this on for at by as or be are was we our so but with from its it\'s'.split(' '),
)
const wt = (w: string) => (STOP.has(w) ? 0.3 : 1)

function lev1(a: string, b: string) {
  // true when edit distance <= 1
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0, j = 0, e = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++e > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else { i++; j++ }
  }
  return e + (a.length - i) + (b.length - j) <= 1
}

// consonant skeleton: jamison/jameson, colour/color, mortality/mortalities sound-alikes
const skel = (w: string) => w[0] + w.slice(1).replace(/[aeiouyhw]/g, '').replace(/(.)\1+/g, '$1')
const cache = new Map<string, boolean>()

export function same(a: string, b: string) {
  if (a === b) return true
  if (a.length < 4 || b.length < 4) return false
  const key = a + ' ' + b
  let r = cache.get(key)
  if (r === undefined) {
    r =
      (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5)) || // stems: invest/investing
      lev1(a, b) ||
      (a.length >= 5 && b.length >= 5 && !/\d/.test(a + b) && skel(a) === skel(b))
    if (cache.size > 50000) cache.clear()
    cache.set(key, r)
  }
  return r
}

export type Match = { pos: number; score: number; moved: boolean }

export class Matcher {
  pos = -1 // index of last spoken script token
  private pend = { j: -1, n: 0 }
  private hist: string[] = [] // recent final words, so short utterances still have context
  private script: string[]
  constructor(script: string[]) {
    this.script = script
  }

  reset(pos: number) {
    this.pos = pos
    this.hist = []
    this.pend = { j: -1, n: 0 }
  }

  // Idempotent: feeding the same transcript twice gives the same pos, so interim/final repeats never double-advance.
  feed(heard: string, isFinal: boolean): Match {
    const h = normalize(heard)
    const dup = h.length > 0 && h.join(' ') === this.hist.slice(-h.length).join(' ')
    const s = dup ? this.hist : [...this.hist, ...h].slice(-10)
    if (isFinal) this.hist = s
    const S = this.script
    if (s.length < 2) return { pos: this.pos, score: 0, moved: false }
    const k = s.length
    const total = s.reduce((a, w) => a + wt(w), 0)
    let best = { j: -1, val: -Infinity, m: 0 }
    const lo = Math.max(0, this.pos - 40)
    const hi = Math.min(S.length - 1, this.pos + 600)
    for (let j = lo; j <= hi; j++) {
      if (!same(S[j], s[k - 1]) && !same(S[j], s[k - 2]) && !(k > 2 && same(S[j], s[k - 3]))) continue
      const L = k + 4
      const c0 = Math.max(0, j - L + 1)
      const c = S.slice(c0, j + 1)
      // semi-global alignment ending at j: matches score by weight, mismatch costs 1, skipped/extra word 0.5
      const dp: number[][] = Array.from({ length: k + 1 }, () => new Array(c.length + 1).fill(0))
      for (let a = 1; a <= k; a++)
        for (let b = 1; b <= c.length; b++)
          dp[a][b] = Math.max(
            0,
            dp[a - 1][b - 1] + (same(s[a - 1], c[b - 1]) ? wt(s[a - 1]) : -1),
            dp[a - 1][b] - 0.5,
            dp[a][b - 1] - 0.5,
          )
      const m = dp[k][c.length]
      const d = j - this.pos
      if (!this.passes(m, m / total, d)) continue
      const val = m - 0.004 * Math.abs(d)
      if (val > best.val) best = { j, val, m }
    }
    if (best.j < 0) return { pos: this.pos, score: 0, moved: false }
    const score = best.m / total
    if (best.j <= this.pos) return { pos: this.pos, score, moved: false }
    const d = best.j - this.pos
    if (d > 40 && !isFinal) {
      // far jump from interim text: need the same target twice
      if (Math.abs(this.pend.j - best.j) <= 3) this.pend.n++
      else this.pend = { j: best.j, n: 1 }
      if (this.pend.n < 2) return { pos: this.pos, score, moved: false }
    }
    this.pend = { j: -1, n: 0 }
    this.pos = best.j
    return { pos: this.pos, score, moved: true }
  }

  private passes(m: number, r: number, d: number) {
    if (d <= 12) return m >= 1.5 && r >= 0.35 // small step forward: cheap evidence is enough
    if (d <= 30) return m >= 2.3 && r >= 0.5
    if (d <= 150) return m >= 4 && r >= 0.6
    return m >= 6 && r >= 0.75
  }
}
