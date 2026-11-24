import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { AssetLens } from '../shared/asset'
import type { OverlayState, OverlayTarget } from '../shared/channels'
import {
  expandRect,
  isSelectable,
  placeOutside,
  rectFromPoints,
  type Point,
  type Rect,
} from '../shared/geometry'
import { MAX_CONTEXT_LENGTH } from '../shared/overlayChannel'

const api = window.gilOverlay

const PANEL_SIZE = { width: 560, height: 78 }
const TIMER_SIZE = { width: 92, height: 28 }
/** Clear space between the recorded region and the inside edge of the outline. */
const OUTLINE_GAP = 1
const OUTLINE_WIDTH = 2
const OUTLINE_OUTSET = OUTLINE_GAP + OUTLINE_WIDTH

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })

function px(rect: Rect) {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
}

export function Overlay() {
  const [state, setState] = useState<OverlayState>({ phase: 'select' })
  // Bumped whenever main asks for the selection UI, so each capture starts from a clean slate.
  const [epoch, setEpoch] = useState(0)

  useEffect(
    () =>
      api.onState((next) => {
        setState(next)
        if (next.phase === 'select') setEpoch((value) => value + 1)
      }),
    [],
  )

  if (state.phase === 'select') return <Selecting key={epoch} />
  return <Recording state={state} />
}

function Selecting() {
  const [dragStart, setDragStart] = useState<Point | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  /** undefined while main is working it out, null if nothing can be recorded there. */
  const [target, setTarget] = useState<OverlayTarget | null | undefined>(undefined)
  const [context, setContext] = useState('')
  const [lens, setLens] = useState<AssetLens>('auto')
  const inputRef = useRef<HTMLInputElement>(null)
  /** Ignores answers for a selection that has since been replaced. */
  const requestRef = useRef(0)

  const selected = rect !== null && dragStart === null && isSelectable(rect)
  // Once main knows which window the selection is in, show the part that will be recorded.
  const shown = target?.region ?? rect

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') api.cancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!selected) return
    // Typing needs this panel to be the key window; it never activates gil itself.
    api.focus()
    inputRef.current?.focus()
  }, [selected])

  const onMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0) return
    setDragStart({ x: event.clientX, y: event.clientY })
    setRect(null)
    setTarget(undefined)
    requestRef.current += 1
  }
  const onMouseMove = (event: ReactMouseEvent) => {
    if (dragStart) setRect(rectFromPoints(dragStart, { x: event.clientX, y: event.clientY }))
  }
  const onMouseUp = (event: ReactMouseEvent) => {
    if (!dragStart) return
    const next = rectFromPoints(dragStart, { x: event.clientX, y: event.clientY })
    setDragStart(null)
    if (!isSelectable(next)) {
      setRect(null)
      return
    }
    setRect(next)
    const request = requestRef.current
    void api.resolveTarget(next).then((resolved) => {
      if (requestRef.current === request) setTarget(resolved)
    })
  }

  const record = () => {
    if (selected && target) api.record({ rect, context, lens })
  }
  const screenshot = () => {
    if (selected && target) api.screenshot({ rect, context, lens })
  }

  // The panel may sit anywhere at this point, nothing is being recorded yet.
  const panelAt =
    selected &&
    shown &&
    (placeOutside(shown, PANEL_SIZE, viewport(), 10) ?? {
      x: Math.max(8, Math.min(shown.x + 8, viewport().width - PANEL_SIZE.width - 8)),
      y: Math.max(8, shown.y + shown.height - PANEL_SIZE.height - 8),
    })

  return (
    <div
      className={rect ? 'select' : 'select empty'}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {shown && (
        <div className="selection" style={px(shown)}>
          <span className="size-label">
            {Math.round(shown.width)} × {Math.round(shown.height)}
          </span>
        </div>
      )}
      {/* After the selection, so the dimming around the selection does not cover it. */}
      {target?.kind === 'window' && (
        <div className="window-frame" style={px(target.frame)} />
      )}
      {!rect && (
        <div className="hint">
          Drag over part of a window, then take a screenshot or record it. gil records that
          window, so you can keep working while it records. Esc to cancel.
        </div>
      )}
      {panelAt && (
        <form
          className="panel"
          style={{ left: panelAt.x, top: panelAt.y, ...PANEL_SIZE }}
          onMouseDown={(event) => event.stopPropagation()}
          onMouseUp={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault()
            record()
          }}
        >
          <div className="target">{describeTarget(target)}</div>
          <div className="row">
            <select
              value={lens}
              title="What gil should look for"
              onChange={(event) => setLens(event.target.value as AssetLens)}
            >
              <option value="auto">Auto</option>
              <option value="motion">Motion</option>
              <option value="component">Component</option>
              <option value="layout">Layout</option>
              <option value="type">Type</option>
              <option value="color">Colour</option>
              <option value="effects">Effects</option>
              <option value="icons">Icons</option>
              <option value="transition">Page transition</option>
              <option value="scroll">Scroll</option>
            </select>
            <input
              ref={inputRef}
              value={context}
              maxLength={MAX_CONTEXT_LENGTH}
              placeholder="What should I look for? (optional)"
              onChange={(event) => setContext(event.target.value)}
            />
            <button type="button" className="secondary" disabled={!target} onClick={screenshot}>
              Screenshot
            </button>
            <button type="submit" disabled={!target}>
              Record
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

function describeTarget(target: OverlayTarget | null | undefined): string {
  if (target === undefined) return 'Finding the window…'
  if (target === null) return 'Nothing to capture there. Drag over the page instead.'
  if (target.kind === 'display') return 'No window here: capturing this part of the screen'
  return `Window: ${target.title ? `${target.app} — ${target.title}` : target.app}`
}

function formatElapsed(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100)
  return `${Math.floor(tenths / 10)}.${tenths % 10}s`
}

function Recording({ state }: { state: Exclude<OverlayState, { phase: 'select' }> }) {
  const [elapsed, setElapsed] = useState(0)
  const startedAt = state.phase === 'recording' ? state.startedAt : null

  useEffect(() => {
    if (state.phase !== 'arming') return
    // Two frames: the first commits this render, the second proves it reached the screen.
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => api.painted())
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [state.phase])

  useEffect(() => {
    if (startedAt === null) return
    const tick = () => setElapsed(Date.now() - startedAt)
    tick()
    const interval = setInterval(tick, 100)
    return () => clearInterval(interval)
  }, [startedAt])

  const outline = expandRect(state.region, OUTLINE_OUTSET)
  const timerAt = placeOutside(outline, TIMER_SIZE, viewport(), 6)

  return (
    <>
      <div className={`outline ${state.phase}`} style={px(outline)} />
      {timerAt && (
        <button
          className="timer"
          style={{ left: timerAt.x, top: timerAt.y, ...TIMER_SIZE }}
          title="Stop recording"
          // The window ignores the mouse while recording; it turns itself back on over the timer.
          onMouseEnter={() => api.setInteractive(true)}
          onMouseLeave={() => api.setInteractive(false)}
          onClick={() => api.stop()}
        >
          <span className="dot" />
          {state.phase === 'recording' ? formatElapsed(elapsed) : 'Starting'}
        </button>
      )}
    </>
  )
}
