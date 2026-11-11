// Run: node src/engine.test.ts
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { parseScript, Matcher, type Item } from './engine.ts'

const sc = parseScript(readFileSync(new URL('./default-script.md', import.meta.url), 'utf8'))
const sents = sc.items.filter((i): i is Extract<Item, { kind: 'sentence' }> => i.kind === 'sentence')
const text = (i: number) => sents[i].words.map((w) => w.text).join(' ')
const T = sc.tokens.map((t) => t.t)

assert.equal(sc.slides.length, 19, 'slides')
assert.equal(sc.slides[18].start, 17 * 60 + 15, 'slide 19 starts at 17:15')
assert.ok(!sents.some((s) => /If asked|Checkpoint|Before you start/.test(s.words.map((w) => w.text).join(' '))), 'no notes spoken')
assert.ok(text(0).startsWith('Good morning'), text(0))
console.log(`parsed ${sc.slides.length} slides, ${sents.length} sentences, ${T.length} words`)

// Simulate Web Speech: interim results grow word by word inside an utterance, final at the end.
function speak(m: Matcher, words: string[], chunk = 12) {
  for (let u = 0; u < words.length; u += chunk) {
    const utt = words.slice(u, u + chunk)
    for (let n = 1; n <= utt.length; n++) m.feed(utt.slice(0, n).join(' '), false)
    m.feed(utt.join(' '), true)
    m.feed(utt.join(' '), true) // duplicate final must not double-advance
  }
}
const words = (a: number, b: number) => sents.slice(a, b + 1).flatMap((s) => s.words.map((w) => w.text))
const sentAt = (pos: number) => sents.findIndex((s) => pos >= s.first && pos <= s.last)

// 1+2. word-for-word whole script, in short and long utterances
for (const chunk of [5, 12, 30]) {
  const m = new Matcher(T)
  let maxBack = 0
  let prev = -1
  for (let i = 0; i < sents.length; i++) {
    speak(m, words(i, i), chunk)
    maxBack = Math.max(maxBack, prev - m.pos)
    prev = m.pos
    assert.ok(Math.abs(m.pos - sents[i].last) <= 2, `chunk ${chunk}: sentence ${i} pos ${m.pos} vs ${sents[i].last}: ${text(i)}`)
  }
  assert.equal(maxBack, 0)
}
console.log('ok word-for-word (fast/slow utterances)')

// 3. pause: silence / noise words don't move pointer
{
  const m = new Matcher(T)
  speak(m, words(0, 5))
  const p = m.pos
  for (const junk of ['um', 'uh okay', 'sorry let me', 'next slide please']) m.feed(junk, true)
  assert.equal(m.pos, p)
  console.log('ok pause/noise')
}

// 4. repeating a sentence holds position
{
  const m = new Matcher(T)
  speak(m, words(0, 10))
  const p = m.pos
  speak(m, words(9, 9))
  assert.ok(m.pos === p, `repeat moved ${p} -> ${m.pos}`)
  speak(m, words(11, 11))
  assert.ok(sentAt(m.pos) === 11)
  console.log('ok repeat')
}

// 5. skipping a sentence, and skipping two whole slides (12, 13)
{
  const m = new Matcher(T)
  speak(m, words(0, 20))
  speak(m, words(22, 23))
  assert.equal(sentAt(m.pos), 23)
  const s14 = sents.findIndex((s) => s.slide === 14)
  const s12 = sents.findIndex((s) => s.slide === 12)
  speak(m, words(24, s12 - 1))
  speak(m, words(s14, s14 + 1))
  assert.equal(sentAt(m.pos), s14 + 1, 'skip slides 12-13')
  console.log('ok skip sentence / skip slides')
}

// 6. changed wording + recognition errors (drop every 4th word, mangle every 5th)
{
  const m = new Matcher(T)
  for (let i = 0; i < 40; i++) {
    const w = words(i, i)
      .filter((_, k) => k % 4 !== 3)
      .map((x, k) => (k % 5 === 4 ? x.slice(0, -1) + 'z' : x))
    speak(m, w, 8)
    assert.ok(Math.abs(sentAt(m.pos) - i) <= 1, `noisy ${i}: at ${sentAt(m.pos)}`)
  }
  console.log('ok noisy wording')
}

// 7. recognition restart mid-sentence (new session starts with a fragment)
{
  const m = new Matcher(T)
  speak(m, words(0, 30))
  const w = words(31, 31)
  speak(m, w.slice(0, 4))
  speak(m, w.slice(4))
  assert.equal(sentAt(m.pos), 31)
  console.log('ok restart mid-sentence')
}

// 8. phrase that appears multiple times ("over 90% of drug spending is private") must not jump
{
  const m = new Matcher(T)
  const s10 = sents.findIndex((s) => s.slide === 10)
  speak(m, words(0, s10 + 1))
  const slideOf = () => sents[sentAt(m.pos)].slide
  m.feed('the arrow mechanism', true) // also on slides 14 and 19: must stay on 10
  assert.equal(slideOf(), 10)
  m.feed('over 90% of drug spending is private', true) // later on slide 10 AND slide 19: nearest wins
  assert.equal(slideOf(), 10)
  console.log('ok repeated phrase')
}
// 9. latency: after each interim word, how many words behind the speaker is the pointer?
{
  const m = new Matcher(T)
  const lags: number[] = []
  for (let i = 0; i < sents.length; i++) {
    const ws = sents[i].words
    for (let u = 0; u < ws.length; u += 12) {
      const utt = ws.slice(u, u + 12)
      for (let n = 1; n <= utt.length; n++) {
        m.feed(utt.slice(0, n).map((w) => w.text).join(' '), false)
        const target = utt[n - 1].tok.at(-1)
        if (target !== undefined) lags.push(Math.max(0, target - m.pos))
      }
      m.feed(utt.map((w) => w.text).join(' '), true)
    }
  }
  const zero = lags.filter((l) => l === 0).length / lags.length
  const avg = lags.reduce((a, b) => a + b, 0) / lags.length
  console.log(`latency: ${(zero * 100).toFixed(1)}% of words tracked instantly, avg lag ${avg.toFixed(2)} words, max ${Math.max(...lags)}`)
  assert.ok(zero > 0.95 && Math.max(...lags) <= 3)
}
console.log('ALL PASS')
