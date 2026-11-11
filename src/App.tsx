import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseScript, Matcher, type Item } from './engine.ts'
import defaultMd from './default-script.md?raw'

type Saved = { id: string; title: string; text: string; used: number }
const ls = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k)
      return v == null ? d : (JSON.parse(v) as T)
    } catch {
      return d
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {
      /* storage full or blocked: app still works for this session */
    }
  },
}
const titleOf = (t: string) => (t.match(/^#\s+(.+)$/m)?.[1] ?? t.trim().split('\n')[0] ?? 'Untitled').replace(/[*#]/g, '').slice(0, 80)
const fmt = (s: number) => `${s < 0 ? '-' : ''}${Math.floor(Math.abs(s) / 60)}:${String(Math.floor(Math.abs(s) % 60)).padStart(2, '0')}`

export default function App() {
  const [scripts, setScripts] = useState<Saved[]>(() => {
    const s = ls.get<Saved[]>('vs-scripts', [])
    return s.length ? s : [{ id: 'default', title: titleOf(defaultMd), text: defaultMd, used: Date.now() }]
  })
  const [open, setOpen] = useState<string | null>(() => ls.get('vs-open', null))
  useEffect(() => ls.set('vs-scripts', scripts), [scripts])
  useEffect(() => ls.set('vs-open', open), [open])
  const cur = scripts.find((s) => s.id === open)
  if (cur) return <Presenter key={cur.id} script={cur} onExit={() => setOpen(null)} />
  return (
    <Home
      scripts={scripts}
      onOpen={(id) => {
        setScripts((ss) => ss.map((s) => (s.id === id ? { ...s, used: Date.now() } : s)))
        setOpen(id)
      }}
      onAdd={(text, title) => setScripts((ss) => [{ id: crypto.randomUUID?.() ?? String(Date.now()), title: title || titleOf(text), text, used: Date.now() }, ...ss])}
      onDelete={(id) => confirm('Delete this script?') && setScripts((ss) => ss.filter((s) => s.id !== id))}
    />
  )
}

function Home(p: { scripts: Saved[]; onOpen: (id: string) => void; onAdd: (t: string, title?: string) => void; onDelete: (id: string) => void }) {
  const [text, setText] = useState('')
  return (
    <div className="mx-auto min-h-dvh max-w-xl px-4 pb-16 pt-[max(2rem,env(safe-area-inset-top))]">
      <h1 className="text-3xl font-bold tracking-tight">
        Voice<span className="text-teal-400">Sync</span>
      </h1>
      <p className="mt-1 text-neutral-400">Teleprompter that follows your voice.</p>

      <h2 className="mt-8 mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">Scripts</h2>
      <ul className="divide-y divide-neutral-800">
        {[...p.scripts]
          .sort((a, b) => b.used - a.used)
          .map((s) => (
            <li key={s.id} className="flex items-center gap-2">
              <button className="flex-1 py-4 text-left" onClick={() => p.onOpen(s.id)}>
                <div className="font-medium">{s.title}</div>
                <div className="text-sm text-neutral-500">{s.text.split(/\s+/).length} words · used {new Date(s.used).toLocaleDateString()}</div>
              </button>
              <button aria-label="Delete script" className="px-3 py-4 text-neutral-600 hover:text-red-400" onClick={() => p.onDelete(s.id)}>
                ✕
              </button>
            </li>
          ))}
      </ul>

      <h2 className="mt-8 mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">New script</h2>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'Paste your script (plain text or Markdown).\n# Headings, [stage cues] and > notes are not read aloud.'}
        className="h-48 w-full rounded-xl bg-neutral-900 p-3 text-base outline-none focus:ring-2 focus:ring-teal-500"
      />
      <div className="mt-3 flex gap-3">
        <button
          disabled={!text.trim()}
          onClick={() => {
            p.onAdd(text)
            setText('')
          }}
          className="flex-1 rounded-full bg-teal-500 py-3 font-semibold text-black disabled:opacity-30"
        >
          Save script
        </button>
        <label className="flex-1 cursor-pointer rounded-full bg-neutral-800 py-3 text-center font-semibold">
          Import .txt / .md
          <input
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (f) p.onAdd(await f.text(), f.name.replace(/\.(md|txt|markdown)$/i, ''))
              e.target.value = ''
            }}
          />
        </label>
      </div>
    </div>
  )
}

type Status = 'idle' | 'starting' | 'listening' | 'restarting' | 'denied' | 'nomic' | 'unsupported'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

function Presenter({ script, onExit }: { script: Saved; onExit: () => void }) {
  const sc = useMemo(() => parseScript(script.text), [script.text])
  const matcher = useMemo(() => new Matcher(sc.tokens.map((t) => t.t)), [sc])
  const K = `vs-${script.id}-`
  const [pos, setPosState] = useState<number>(() => Math.min(ls.get(K + 'pos', -1), sc.tokens.length - 1))
  const [t0, setT0] = useState<number | null>(() => ls.get(K + 't0', null))
  const [font, setFont] = useState(() => ls.get('vs-font', 30))
  const [auto, setAuto] = useState(true)
  const [debug, setDebug] = useState(false)
  const [lang, setLang] = useState(() => ls.get('vs-lang', 'en-IN'))
  const [status, setStatus] = useState<Status>(SR ? 'idle' : 'unsupported')
  const [heard, setHeard] = useState('')
  const [conf, setConf] = useState(0)
  const [now, setNow] = useState(Date.now())
  const want = useRef(false)
  const rec = useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const scroller = useRef<HTMLDivElement>(null)
  const refs = useRef<(HTMLElement | null)[]>([])

  useEffect(() => matcher.reset(pos), [matcher]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => ls.set(K + 'pos', pos), [K, pos])
  useEffect(() => ls.set(K + 't0', t0), [K, t0])
  useEffect(() => ls.set('vs-font', font), [font])
  useEffect(() => ls.set('vs-lang', lang), [lang])
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(i)
  }, [])

  const jump = useCallback(
    (p: number) => {
      const q = Math.max(-1, Math.min(p, sc.tokens.length - 1))
      matcher.reset(q)
      setPosState(q)
    },
    [matcher, sc],
  )
  const reg = useCallback((i: number, el: HTMLElement | null) => {
    refs.current[i] = el
  }, [])

  // ---- active sentence ----
  const sentIdx = useMemo(() => sc.items.map((it, i) => (it.kind === 'sentence' ? i : -1)).filter((i) => i >= 0), [sc])
  const S = (i: number) => sc.items[i] as Extract<Item, { kind: 'sentence' }>
  let ai = sentIdx.findIndex((i) => S(i).last >= pos)
  if (ai < 0) ai = sentIdx.length - 1
  { // sentence (nearly) finished: move the eye on now; last words are often misheard numbers
    const a = S(sentIdx[ai])
    if (pos >= 0 && ai < sentIdx.length - 1 && a.last - pos <= (a.last - a.first >= 5 ? 1 : 0)) ai++
  }
  const active = sentIdx[ai] ?? -1
  const slideNo = active >= 0 ? sc.items[active].slide : 0
  const slide = sc.slides.find((s) => s.n === slideNo)

  // ---- timing ----
  const elapsed = t0 ? (now - t0) / 1000 : 0
  const total = sc.slides.reduce((a, s) => a + s.dur, 0)
  let expected = 0
  const span = useMemo(() => {
    const r: Record<number, [number, number]> = {} // slide -> [first token, last token]
    sc.tokens.forEach((t, i) => {
      const n = sc.items[t.item].slide
      r[n] = r[n] ? [r[n][0], i] : [i, i]
    })
    return r
  }, [sc])
  if (slide && total && span[slide.n]) {
    const [a, b] = span[slide.n]
    expected = slide.start + Math.min(1, Math.max(0, (pos - a + 1) / (b - a + 1))) * slide.dur
  }
  const behind = t0 && total ? elapsed - expected : 0

  // ---- auto-scroll: keep the reading point at ~42% of the viewport ----
  useEffect(() => {
    const el = refs.current[active]
    const box = scroller.current
    if (!auto || !el || !box) return
    const H = box.clientHeight
    let y = el.offsetTop + el.offsetHeight / 2
    if (el.offsetHeight > H * 0.3) {
      // tall sentence: follow the line of the next word to be said
      const next = [...el.querySelectorAll<HTMLElement>('[data-t]')].find((w) => Number(w.dataset.t) > pos)
      y = next ? next.offsetTop + next.offsetHeight / 2 : el.offsetTop + el.offsetHeight
    }
    const top = y - H * 0.42
    if (Math.abs(top - box.scrollTop) > font * 0.6) box.scrollTo({ top, behavior: 'smooth' })
  }, [active, auto, font, pos])

  // ---- speech recognition ----
  const lastStart = useRef(0)
  const startRec = () => {
    if (!SR) return
    lastStart.current = Date.now()
    const old = rec.current
    const r = new SR()
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    r.maxAlternatives = 1
    const fed = new Set<number>()
    r.onstart = () => setStatus('listening')
    r.onresult = (e: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        if (res.isFinal) {
          if (fed.has(i)) continue // Android can resend old finals
          fed.add(i)
          apply(matcher.feed(res[0].transcript, true), res[0].transcript)
        } else interim += res[0].transcript + ' '
      }
      if (interim.trim()) apply(matcher.feed(interim, false), interim)
    }
    r.onerror = (e: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        want.current = false
        setStatus('denied')
      } else if (e.error === 'audio-capture') setStatus('nomic')
      // no-speech / network / aborted: onend restarts below
    }
    r.onend = () => {
      if (rec.current !== r) return
      if (want.current) {
        setStatus((s) => (s === 'nomic' ? s : 'restarting'))
        const quick = Date.now() - lastStart.current < 1500 // failing fast: back off
        setTimeout(() => want.current && rec.current === r && startRec(), quick ? 1500 : 30)
      } else setStatus((s) => (s === 'denied' ? s : 'idle'))
    }
    rec.current = r
    old?.abort?.()
    try {
      r.start()
    } catch {
      setTimeout(() => want.current && rec.current === r && startRec(), 1000)
    }
  }
  const apply = (m: { pos: number; score: number; moved: boolean }, text: string) => {
    setHeard(text.trim().split(/\s+/).slice(-14).join(' '))
    if (m.score) setConf(m.score)
    if (m.moved) setPosState(m.pos)
  }
  const listen = (on: boolean) => {
    want.current = on
    if (on) {
      if (!t0) setT0(Date.now())
      setStatus('starting')
      startRec()
    } else {
      rec.current?.abort?.()
      rec.current = null
      setStatus('idle')
    }
  }
  // watchdog: if the browser silently drops recognition, bring it back
  useEffect(() => {
    const i = setInterval(() => {
      if (want.current && status !== 'listening' && Date.now() - lastStart.current > 8000) startRec()
    }, 4000)
    return () => clearInterval(i)
  })
  useEffect(() => () => {
    want.current = false
    rec.current?.abort?.()
  }, [])

  // ---- wake lock while listening ----
  useEffect(() => {
    if (status !== 'listening' && status !== 'restarting') return
    let lock: WakeLockSentinel | null = null
    const get = () => navigator.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => {})
    get()
    const vis = () => document.visibilityState === 'visible' && get()
    document.addEventListener('visibilitychange', vis)
    return () => {
      document.removeEventListener('visibilitychange', vis)
      lock?.release().catch(() => {})
    }
  }, [status === 'listening' || status === 'restarting']) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- controls ----
  const go = (d: number) => {
    const t = sentIdx[Math.max(0, Math.min(sentIdx.length - 1, ai + d))]
    jump(S(t).first - 1)
  }
  const restart = () => {
    if (!confirm('Restart from the beginning and reset the timer?')) return
    jump(-1)
    setT0(want.current ? Date.now() : null)
  }
  const exit = () => {
    listen(false)
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    onExit()
  }
  const full = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})
  const on = want.current
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      const map: Record<string, () => void> = {
        ' ': () => listen(!want.current),
        ArrowDown: () => go(1), ArrowRight: () => go(1), j: () => go(1),
        ArrowUp: () => go(-1), ArrowLeft: () => go(-1), k: () => go(-1),
        '+': () => setFont((f: number) => Math.min(56, f + 2)), '=': () => setFont((f: number) => Math.min(56, f + 2)),
        '-': () => setFont((f: number) => Math.max(18, f - 2)),
        a: () => setAuto((x) => !x), d: () => setDebug((x) => !x), f: full, r: restart, Escape: exit,
      }
      const fn = map[e.key]
      if (fn) {
        e.preventDefault()
        fn()
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const statusInfo: Record<Status, [string, string]> = {
    idle: ['bg-neutral-500', on ? 'Paused' : 'Mic off'],
    starting: ['bg-amber-400 animate-pulse', 'Starting…'],
    listening: ['bg-teal-400 animate-pulse', 'Listening'],
    restarting: ['bg-amber-400', 'Reconnecting…'],
    denied: ['bg-red-500', 'Mic blocked'],
    nomic: ['bg-red-500 animate-pulse', 'No microphone'],
    unsupported: ['bg-red-500', 'No speech API'],
  }
  const progress = sc.tokens.length ? Math.max(0, pos + 1) / sc.tokens.length : 0

  return (
    <div className="fixed inset-0 flex flex-col bg-[#0a0a0a]">
      {/* top bar */}
      <div className="z-10 bg-[#0a0a0a]/95 px-4 pt-[max(0.6rem,env(safe-area-inset-top))] pb-2">
        <div className="flex items-center gap-3 text-sm">
          <span className="rounded-md bg-neutral-800 px-2 py-0.5 font-mono text-teal-300">
            {slideNo || '–'}/{sc.slides.length || '–'}
          </span>
          <span className="min-w-0 flex-1 truncate text-neutral-300">{slide?.title ?? script.title}</span>
          <span className="flex items-center gap-1.5 text-neutral-400">
            <span className={`h-2.5 w-2.5 rounded-full ${statusInfo[status][0]}`} />
            {statusInfo[status][1]}
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-3 font-mono text-sm tabular-nums">
          <span className="text-neutral-200">{fmt(elapsed)}</span>
          {total > 0 && <span className="text-neutral-500">~{fmt(Math.max(0, total - expected))} left</span>}
          {t0 && total > 0 && Math.abs(behind) >= 20 && (
            <span className={behind > 60 ? 'text-red-400' : behind > 0 ? 'text-amber-300' : 'text-teal-300'}>
              {behind > 0 ? `${fmt(behind)} behind` : `${fmt(-behind)} ahead`}
            </span>
          )}
          <span className="ml-auto text-neutral-500">{Math.round(progress * 100)}%</span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-neutral-800">
          <div className="h-full bg-teal-400 transition-[width] duration-500" style={{ width: `${progress * 100}%` }} />
        </div>
        {(status === 'unsupported' || status === 'denied' || status === 'nomic' || !window.isSecureContext) && (
          <div className="mt-2 rounded-lg bg-red-950 px-3 py-2 text-sm text-red-200">
            {status === 'unsupported'
              ? 'Speech recognition is not available in this browser. Use Chrome on Android. Tap sentences or use ◀ ▶ to move.'
              : !window.isSecureContext
                ? 'Microphone needs HTTPS. Open the https:// address.'
                : status === 'denied'
                  ? 'Microphone permission denied. Allow it in site settings (lock icon), then tap the mic.'
                  : 'Microphone disconnected or busy. Retrying… Use ◀ ▶ meanwhile.'}
          </div>
        )}
        {debug && (
          <div className="mt-2 space-y-1 rounded-lg bg-neutral-900 p-2 font-mono text-xs text-neutral-400">
            <div>heard: <span className="text-neutral-200">{heard || '—'}</span></div>
            <div className="flex items-center gap-2">
              match {Math.round(conf * 100)}%
              <span className="h-1.5 w-24 overflow-hidden rounded bg-neutral-800">
                <span className={`block h-full ${conf > 0.7 ? 'bg-teal-400' : conf > 0.5 ? 'bg-amber-400' : 'bg-red-500'}`} style={{ width: `${conf * 100}%` }} />
              </span>
              word {pos + 1}/{sc.tokens.length}
              <select value={lang} onChange={(e) => setLang(e.target.value)} className="ml-auto bg-neutral-800 text-neutral-200">
                {['en-IN', 'en-US', 'en-GB', 'en-AU'].map((l) => <option key={l}>{l}</option>)}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* script */}
      <div ref={scroller} className="relative flex-1 overflow-y-auto overscroll-contain px-5" style={{ fontSize: font }}>
        <div className="mx-auto max-w-2xl" style={{ paddingTop: '40vh', paddingBottom: '60vh' }}>
          {sc.items.map((it, i) => {
            if (it.kind === 'heading')
              return (
                <h2 key={i} className={`mt-[1.6em] mb-[0.5em] text-[0.55em] font-semibold uppercase tracking-widest ${it.slide && it.slide === slideNo ? 'text-teal-400' : 'text-neutral-600'}`}>
                  {it.slide ? `Slide ${it.slide} · ` : ''}{it.text}
                </h2>
              )
            if (it.kind === 'cue')
              return (
                <p key={i} className="my-[0.4em] text-[0.5em] italic text-neutral-600">
                  [{it.text}]
                </p>
              )
            const look = i === active ? 'active' : sentIdx[ai - 1] === i ? 'prev' : i < active ? 'past' : 'next'
            return <Sentence key={i} i={i} it={it} look={look} spoken={look === 'active' ? pos : -1} reg={reg} onJump={jump} />
          })}
          <p className="mt-[2em] text-center text-[0.6em] text-neutral-600">— end of script —</p>
        </div>
      </div>

      {/* controls */}
      <div className="z-10 border-t border-neutral-900 bg-[#0a0a0a]/95 px-2 pt-2 pb-[max(0.6rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-xl items-center justify-between">
          <Btn label="Exit" onClick={exit}>✕</Btn>
          <Btn label="Restart" onClick={restart}>↺</Btn>
          <Btn label="Previous sentence" onClick={() => go(-1)}>◀</Btn>
          <button
            aria-label={on ? 'Pause listening' : 'Start listening'}
            onClick={() => listen(!on)}
            className={`flex h-16 w-16 items-center justify-center rounded-full text-black shadow-lg active:scale-95 ${on ? 'bg-teal-400' : 'bg-white'}`}
          >
            {on ? (
              <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            ) : (
              <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-2.1A7 7 0 0 0 19 12h-2Z" /></svg>
            )}
          </button>
          <Btn label="Next sentence" onClick={() => go(1)}>▶</Btn>
          <Btn label="Auto-scroll" active={auto} onClick={() => setAuto((x) => !x)}>⇅</Btn>
          <Btn label="More" onClick={() => setDebug((x) => !x)} active={debug}>⋯</Btn>
        </div>
        {debug && (
          <div className="mx-auto mt-2 flex max-w-xl items-center justify-center gap-2 text-sm">
            <Btn label="Smaller text" onClick={() => setFont((f: number) => Math.max(18, f - 2))}>A−</Btn>
            <span className="w-10 text-center font-mono text-neutral-400">{font}</span>
            <Btn label="Larger text" onClick={() => setFont((f: number) => Math.min(56, f + 2))}>A+</Btn>
            <Btn label="Full screen" onClick={full}>⤢</Btn>
          </div>
        )}
      </div>
    </div>
  )
}

type SentenceItem = Extract<Item, { kind: 'sentence' }>
const LOOK = {
  active: 'rounded-xl bg-teal-400/10 -mx-3 px-3 py-1 text-white',
  prev: 'text-neutral-500',
  past: 'text-neutral-700',
  next: 'text-neutral-300',
}
// memo: only the active sentence re-renders as each word is heard
const Sentence = memo(function Sentence(p: {
  i: number
  it: SentenceItem
  look: keyof typeof LOOK
  spoken: number
  reg: (i: number, el: HTMLElement | null) => void
  onJump: (pos: number) => void
}) {
  return (
    <p ref={(el) => p.reg(p.i, el)} onClick={() => p.onJump(p.it.first - 1)} className={`mb-[0.55em] leading-[1.4] transition-colors duration-200 ${LOOK[p.look]}`}>
      {p.it.words.map((w, k) => {
        const t = w.tok.length ? w.tok[w.tok.length - 1] : -1
        return (
          <span key={k} data-t={t} className={`${w.bold ? 'font-bold' : ''} ${t >= 0 && t <= p.spoken ? 'text-teal-300' : ''}`}>
            {w.text}{' '}
          </span>
        )
      })}
    </p>
  )
})

function Btn(p: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button
      aria-label={p.label}
      title={p.label}
      onClick={p.onClick}
      className={`flex h-12 w-12 items-center justify-center rounded-full text-lg active:bg-neutral-700 ${p.active ? 'bg-teal-400/15 text-teal-300' : 'text-neutral-300'}`}
    >
      {p.children}
    </button>
  )
}
