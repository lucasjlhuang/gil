import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { z } from 'zod'
import type { AssetLens } from '../shared/asset'
import type { AssetDetails, LibraryItem } from '../shared/channels'
import { MemberPicker } from './MemberPicker'
import {
  compileEdits,
  EDITABLE_PROPERTIES,
  hasEdits,
  isSafeValue,
  NO_EDITS,
  parseRootVars,
  splitRecreation,
  type EditableProperty,
  type Edits,
  type RootVar,
} from '../shared/edits'
import type { Spec } from '../shared/spec'

const api = window.gilLibrary

export function statusLabel(status: string): string {
  if (status === 'analyzing') return 'Analyzing…'
  if (status === 'failed') return 'Analysis failed'
  if (status === 'stored') return 'Not analyzed'
  return 'Ready'
}

/** What the sandboxed preview reports when the user clicks an element. Untrusted. */
const pickedSchema = z.object({
  type: z.literal('gil:picked'),
  selector: z.string().max(2000),
  tag: z.string().max(100),
  styles: z.record(z.string(), z.string().max(500)),
})

interface Picked {
  selector: string
  tag: string
  /** Computed styles at the moment it was picked. */
  computed: Record<string, string>
}

/** The original and the recreation side by side, the editor, and the outputs. */
export function Review({
  item,
  items,
  canAnalyze,
  onClose,
}: {
  item: LibraryItem
  /** The whole library, for choosing a design system's members. */
  items: LibraryItem[]
  canAnalyze: boolean
  onClose: () => void
}) {
  const { asset, posterUrl, clipUrl, recreationUrl } = item
  const capture = asset.capture
  const busy = asset.status === 'analyzing'
  const [details, setDetails] = useState<AssetDetails | null>(null)
  const [draft, setDraft] = useState<Edits>(NO_EDITS)
  const [loop, setLoop] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    void api.details(asset.name).then((next) => {
      setDetails(next)
      setDraft(next.edits ?? NO_EDITS)
    })
  }, [asset.name, asset.updatedAt])

  const post = useCallback((message: unknown) => {
    // The frame is sandboxed without same-origin access, so it is reached by message only.
    frameRef.current?.contentWindow?.postMessage(message, '*')
  }, [])

  const replay = useCallback(() => {
    const video = videoRef.current
    if (video) {
      video.currentTime = 0
      void video.play()
    }
    post('gil:replay')
  }, [post])

  // Unsaved edits are shown live in the preview.
  const css = useMemo(() => compileEdits(draft), [draft])
  useEffect(() => post({ type: 'gil:css', css }), [css, post])

  const saved = details?.edits ?? NO_EDITS
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  const run = (work: Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) => {
    setError(null)
    void work.then((result) => {
      if (result.ok) after?.()
      else setError(result.error)
    })
  }

  const size = capture ? { width: capture.width, height: capture.height } : { width: 400, height: 300 }

  return (
    <div className="library review">
      <div className="library-bar">
        <button onClick={onClose}>‹ Library</button>
        <NameEditor
          key={asset.name}
          name={asset.name}
          title={asset.title}
          disabled={busy}
          onSave={(name, title) => run(api.rename(asset.id, name, title))}
        />
        <span className={`status ${asset.status}`}>{statusLabel(asset.status)}</span>
        {asset.analysis?.usage && (
          <span
            className="muted"
            title={`${asset.analysis.usage.inputTokens.toLocaleString()} input and ${asset.analysis.usage.outputTokens.toLocaleString()} output tokens over ${asset.analysis.rounds} rounds`}
          >
            {asset.analysis.usage.costUsd === null ? 'cost unknown' : `$${asset.analysis.usage.costUsd.toFixed(2)}`}
          </span>
        )}
        {clipUrl && (
          <label className="loop">
            <input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} /> Loop
          </label>
        )}
        <button className="primary" onClick={replay}>
          Replay
        </button>
      </div>
      <main>
        <div className="asset-actions">
          <TagEditor
            tags={asset.tags}
            disabled={busy}
            onChange={(tags) => run(api.setTags(asset.id, tags))}
          />
          {capture && asset.kind !== 'font' && (
            <button
              disabled={busy || (!canAnalyze && asset.lens !== 'color')}
              title={canAnalyze || asset.lens === 'color' ? undefined : 'Add your Anthropic API key in Settings first'}
              onClick={() => {
                if (hasEdits(saved) && !window.confirm('Analyzing again replaces the recreation and your edits to it.')) {
                  return
                }
                void api.analyze(asset.id)
              }}
            >
              {asset.status === 'stored' ? 'Analyze' : 'Re-analyze'}
            </button>
          )}
          {capture && (
            <select
              value=""
              disabled={busy}
              title="Save another asset from the same capture, looking for something else"
              onChange={(event) => {
                const lens = event.target.value as Exclude<AssetLens, 'auto'>
                if (!lens) return
                if (lens === 'font') setWorking('Identifying the font: reading the text, then comparing free fonts. This can take a minute.')
                setError(null)
                void api.runLens(asset.id, lens).then((result) => {
                  setWorking(null)
                  if (!result.ok) setError(result.error)
                })
              }}
            >
              <option value="">Another Lens…</option>
              <option value="color">Colour (measured, free)</option>
              <option value="spacing">Spacing and grid (measured, free)</option>
              <option value="layout" disabled={!canAnalyze}>Layout</option>
              <option value="type" disabled={!canAnalyze}>Type</option>
              <option value="font" disabled={!canAnalyze}>Font (identify the typeface)</option>
              <option value="component" disabled={!canAnalyze}>Component</option>
              <option value="motion" disabled={!canAnalyze || !clipUrl}>Motion</option>
              <option value="effects" disabled={!canAnalyze}>Effects and materials</option>
              <option value="icons" disabled={!canAnalyze}>Icons and illustration style</option>
              <option value="transition" disabled={!canAnalyze || !clipUrl}>Page transition</option>
              <option value="scroll" disabled={!canAnalyze || !clipUrl}>Scroll choreography</option>
            </select>
          )}
          <button
            disabled={busy}
            title="Copy this asset's folder somewhere else"
            onClick={() =>
              void api.exportAsset(asset.id).then((result) => {
                if (result.ok) window.alert(`Exported to ${result.path ?? 'the folder you chose'}.`)
                else if (result.error) window.alert(result.error)
              })
            }
          >
            Export
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Move "${asset.name}" to the Trash?`)) run(api.trash(asset.id), onClose)
            }}
          >
            Delete
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {working && <div className="muted">{working}</div>}
        {details && (
          <NotesBox
            key={`${asset.id}-${details.notes.length}`}
            initial={details.notes}
            isNote={asset.kind === 'note'}
            disabled={busy}
            onSave={(text) => run(api.saveNotes(asset.id, text))}
          />
        )}
        {capture && asset.kind !== 'font' && asset.lens !== 'color' && (
          <FocusBox
            key={`${asset.id}-${asset.userContext ?? ''}`}
            initial={asset.userContext ?? ''}
            analyzed={asset.status !== 'stored'}
            disabled={busy}
            onSave={(text) => run(api.setFocus(asset.id, text))}
          />
        )}
        {asset.kind === 'design-system' && details && (
          <MembersBox
            key={details.members.join(',')}
            items={items}
            initial={details.members}
            disabled={busy}
            onSave={(ids) => run(api.setMembers(asset.id, ids))}
          />
        )}
        {asset.kind !== 'note' && asset.kind !== 'design-system' && (
        <div className="side-by-side">
          <figure>
            <figcaption>Original</figcaption>
            <div className="stage">
              {clipUrl ? (
                <video ref={videoRef} src={clipUrl} autoPlay loop={loop} muted style={size} />
              ) : (
                posterUrl && <img src={posterUrl} alt="" style={size} />
              )}
            </div>
          </figure>
          <figure>
            <figcaption>Recreation{dirty ? ' (unsaved edits)' : hasEdits(saved) ? ' (edited)' : ''}</figcaption>
            <div className="stage">
              {recreationUrl ? (
                <iframe
                  ref={frameRef}
                  // Scripts only: no same-origin, forms, pop-ups or navigation.
                  sandbox="allow-scripts"
                  src={recreationUrl}
                  title="Recreation"
                  style={{ ...size, border: 0 }}
                  onLoad={() => post({ type: 'gil:css', css })}
                />
              ) : (
                <div className="placeholder" style={size}>
                  {busy ? 'Analyzing…' : 'Not analyzed yet'}
                </div>
              )}
            </div>
          </figure>
        </div>
        )}
        {asset.analysis?.error && <div className="error">{asset.analysis.error}</div>}
        {recreationUrl && asset.kind !== 'color-system' && asset.kind !== 'spacing-system' && asset.kind !== 'font' && asset.lens !== 'type' && (
          <RefineBox
            disabled={busy || !canAnalyze}
            onRefine={(instruction) => {
              if (
                hasEdits(saved) &&
                !window.confirm('Refining replaces the recreation and your edits to it. Continue?')
              ) {
                return false
              }
              void api.refine(asset.id, instruction)
              return true
            }}
          />
        )}
        {details?.base && recreationUrl && (
          <Editor
            base={details.base}
            draft={draft}
            dirty={dirty}
            hasSaved={hasEdits(saved)}
            disabled={busy}
            frameRef={frameRef}
            post={post}
            replay={replay}
            onChange={setDraft}
            onSave={(edits) => run(api.saveEdits(asset.id, edits))}
            onDiscard={() => setDraft(saved)}
          />
        )}
        {details && <Outputs details={details} summary={asset.summary} />}
      </main>
    </div>
  )
}

/** A design system's members. */
function MembersBox({
  items,
  initial,
  disabled,
  onSave,
}: {
  items: LibraryItem[]
  initial: string[]
  disabled: boolean
  onSave: (ids: string[]) => void
}) {
  const [selected, setSelected] = useState(initial)
  const changed = JSON.stringify(selected) !== JSON.stringify(initial)
  return (
    <section className="notes">
      <h3>In this design system</h3>
      <MemberPicker items={items} selected={selected} onChange={setSelected} />
      {changed && (
        <div className="actions">
          <button className="primary" disabled={disabled} onClick={() => onSave(selected)}>
            Save Members
          </button>
          <button onClick={() => setSelected(initial)}>Discard</button>
        </div>
      )}
    </section>
  )
}

/**
 * What to recreate from the capture, in the user's words ("only the loading animation, not the
 * photo"). The same note as in the capture overlay; it is read the next time gil analyzes.
 */
function FocusBox({
  initial,
  analyzed,
  disabled,
  onSave,
}: {
  initial: string
  analyzed: boolean
  disabled: boolean
  onSave: (text: string) => void
}) {
  const [text, setText] = useState(initial)
  const changed = text.trim() !== initial.trim()
  return (
    <section className="notes">
      <h3>What to recreate</h3>
      <textarea
        value={text}
        rows={2}
        maxLength={2000}
        placeholder="Everything in the capture. Or say which part you want, for example: only the loading animation, not the photo."
        onChange={(event) => setText(event.target.value)}
      />
      {changed && (
        <div className="actions">
          <button className="primary" disabled={disabled} onClick={() => onSave(text)}>
            Save
          </button>
          <button onClick={() => setText(initial)}>Discard</button>
        </div>
      )}
      {!changed && initial.trim() && analyzed && <div className="muted">Used the next time you press Re-analyze.</div>}
    </section>
  )
}

/** The user's notes on an asset, or a note's text. AI tools get them with the asset. */
function NotesBox({
  initial,
  isNote,
  disabled,
  onSave,
}: {
  initial: string
  isNote: boolean
  disabled: boolean
  onSave: (text: string) => void
}) {
  const [text, setText] = useState(initial)
  const changed = text !== initial
  return (
    <section className="notes">
      <h3>{isNote ? 'Note' : 'Notes'}</h3>
      <textarea
        value={text}
        rows={isNote ? 10 : 3}
        placeholder={isNote ? 'Write the guideline or term here.' : 'Your notes on this asset, for you and for AI tools that use it.'}
        onChange={(event) => setText(event.target.value)}
      />
      {changed && (
        <div className="actions">
          <button className="primary" disabled={disabled} onClick={() => onSave(text)}>
            Save {isNote ? 'Note' : 'Notes'}
          </button>
          <button onClick={() => setText(initial)}>Discard</button>
        </div>
      )}
    </section>
  )
}

/** Tell Claude what to fix; it corrects the recreation against the original frames. */
function RefineBox({
  disabled,
  onRefine,
}: {
  disabled: boolean
  onRefine: (instruction: string) => boolean
}) {
  const [text, setText] = useState('')
  return (
    <form
      className="refine"
      onSubmit={(event) => {
        event.preventDefault()
        if (text.trim() && onRefine(text.trim())) setText('')
      }}
    >
      <textarea
        value={text}
        rows={2}
        maxLength={4000}
        disabled={disabled}
        placeholder="Refine: tell Claude what to fix, e.g. “the M morphs into a rounded double arch; match the frames at 1650 and 1900 ms”"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit()
        }}
      />
      <button className="primary" type="submit" disabled={disabled || !text.trim()}>
        Refine
      </button>
    </form>
  )
}

function NameEditor({
  name,
  title,
  disabled,
  onSave,
}: {
  name: string
  title: string
  disabled: boolean
  onSave: (name: string, title: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [nextName, setNextName] = useState(name)
  const [nextTitle, setNextTitle] = useState(title)

  if (!editing) {
    return (
      <span className="review-title">
        <strong>{title}</strong> <code>{name}</code>{' '}
        <button className="link" disabled={disabled} onClick={() => setEditing(true)}>
          Rename
        </button>
      </span>
    )
  }
  return (
    <form
      className="review-title rename"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(nextName.trim(), nextTitle)
        setEditing(false)
      }}
    >
      <input value={nextTitle} placeholder="Title" onChange={(event) => setNextTitle(event.target.value)} />
      <input
        value={nextName}
        placeholder="asset-name"
        spellCheck={false}
        title="Lowercase letters, digits and hyphens. This is the name other tools use."
        onChange={(event) => setNextName(event.target.value.toLowerCase().replace(/\s+/g, '-'))}
      />
      <button className="primary" type="submit">
        Save
      </button>
      <button type="button" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  )
}

function TagEditor({
  tags,
  disabled,
  onChange,
}: {
  tags: string[]
  disabled: boolean
  onChange: (tags: string[]) => void
}) {
  const [input, setInput] = useState('')
  return (
    <div className="tags-editor">
      {tags.map((tag) => (
        <span key={tag} className="tag">
          {tag}
          <button
            className="remove"
            title={`Remove ${tag}`}
            disabled={disabled}
            onClick={() => onChange(tags.filter((other) => other !== tag))}
          >
            ×
          </button>
        </span>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const added = input.split(',').map((tag) => tag.trim()).filter(Boolean)
          if (added.length > 0) onChange([...tags, ...added])
          setInput('')
        }}
      >
        <input
          value={input}
          disabled={disabled}
          placeholder="Add a label"
          onChange={(event) => setInput(event.target.value)}
        />
      </form>
    </div>
  )
}

function Editor({
  base,
  draft,
  dirty,
  hasSaved,
  disabled,
  frameRef,
  post,
  replay,
  onChange,
  onSave,
  onDiscard,
}: {
  base: string
  draft: Edits
  dirty: boolean
  hasSaved: boolean
  disabled: boolean
  frameRef: React.RefObject<HTMLIFrameElement | null>
  post: (message: unknown) => void
  replay: () => void
  onChange: (edits: Edits) => void
  onSave: (edits: Edits) => void
  onDiscard: () => void
}) {
  const [tab, setTab] = useState<'values' | 'element'>('values')
  const vars = useMemo(() => parseRootVars(base), [base])
  const [picked, setPicked] = useState<Picked | null>(null)
  const [picking, setPicking] = useState(false)
  const replayTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      const parsed = pickedSchema.safeParse(event.data)
      if (!parsed.success) return
      setPicking(false)
      setPicked({ selector: parsed.data.selector, tag: parsed.data.tag, computed: parsed.data.styles })
      setTab('element')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [frameRef])

  const setVar = (variable: RootVar, value: string | null) => {
    const vars = { ...draft.vars }
    if (value === null || value === variable.value) delete vars[variable.name]
    else if (isSafeValue(value.trim())) vars[variable.name] = value.trim()
    else return
    onChange({ ...draft, vars })
    // Timing changes only show when the motion plays again.
    if (variable.kind === 'duration' || variable.kind === 'easing') {
      if (replayTimer.current) clearTimeout(replayTimer.current)
      replayTimer.current = setTimeout(replay, 400)
    }
  }

  const ruleFor = (selector: string) => draft.rules.find((rule) => rule.selector === selector)

  const setStyle = (property: EditableProperty, value: string | null) => {
    if (!picked) return
    const existing = ruleFor(picked.selector)
    const styles = { ...existing?.styles }
    if (value === null || value.trim() === '') delete styles[property]
    else if (isSafeValue(value.trim())) styles[property] = value.trim()
    else return
    const others = draft.rules.filter((rule) => rule.selector !== picked.selector)
    const rules = Object.keys(styles).length > 0 ? [...others, { selector: picked.selector, styles }] : others
    onChange({ ...draft, rules })
  }

  const order = (kind: RootVar['kind']) =>
    ['duration', 'easing', 'color', 'length', 'number', 'text'].indexOf(kind)

  return (
    <section className="editor">
      <div className="editor-bar">
        <nav className="tabs">
          <button className={tab === 'values' ? 'tab active' : 'tab'} onClick={() => setTab('values')}>
            Timings &amp; values
          </button>
          <button className={tab === 'element' ? 'tab active' : 'tab'} onClick={() => setTab('element')}>
            Elements
          </button>
        </nav>
        <span className="spacer" />
        {hasSaved && (
          <button
            disabled={disabled}
            onClick={() => {
              if (window.confirm('Remove all your edits and go back to the recreation Claude wrote?')) {
                onSave(NO_EDITS)
              }
            }}
          >
            Revert to Original
          </button>
        )}
        <button disabled={!dirty} onClick={onDiscard}>
          Discard Changes
        </button>
        <button className="primary" disabled={!dirty || disabled} onClick={() => onSave(draft)}>
          Save Edits
        </button>
      </div>

      {tab === 'values' &&
        (vars.length === 0 ? (
          <p className="hint">
            This recreation declares no editable values. Re-analyze it to get one that exposes its
            timings, colors and sizes.
          </p>
        ) : (
          <div className="vars">
            {[...vars]
              .sort((a, b) => order(a.kind) - order(b.kind))
              .map((variable) => (
                <VarControl
                  key={variable.name}
                  variable={variable}
                  value={draft.vars[variable.name] ?? variable.value}
                  edited={variable.name in draft.vars}
                  onChange={(value) => setVar(variable, value)}
                />
              ))}
          </div>
        ))}

      {tab === 'element' && (
        <div className="element-editor">
          <p className="hint">
            <button
              className={picking ? 'primary' : ''}
              onClick={() => {
                const next = !picking
                setPicking(next)
                post({ type: 'gil:pick', on: next })
              }}
            >
              {picking ? 'Click an element in the recreation…' : 'Select an Element'}
            </button>{' '}
            {picked ? (
              <>
                Editing <code>{picked.tag}</code>
              </>
            ) : (
              'Pick something in the recreation to nudge it or restyle it.'
            )}
          </p>
          {picked && (
            <ElementControls
              picked={picked}
              styles={ruleFor(picked.selector)?.styles ?? {}}
              onChange={setStyle}
            />
          )}
        </div>
      )}
    </section>
  )
}

function VarControl({
  variable,
  value,
  edited,
  onChange,
}: {
  variable: RootVar
  value: string
  edited: boolean
  onChange: (value: string | null) => void
}) {
  const label = variable.name.replace(/^--/, '')
  let control: ReactNode
  if (variable.kind === 'duration') {
    const ms = /s$/.test(value) && !/ms$/.test(value) ? parseFloat(value) * 1000 : parseFloat(value)
    control = (
      <>
        <input
          type="range"
          min={0}
          max={Math.max(2000, Math.ceil((parseFloat(variable.value) || 0) * 3))}
          step={10}
          value={Number.isFinite(ms) ? ms : 0}
          onChange={(event) => onChange(`${event.target.value}ms`)}
        />
        <input className="small" value={value} onChange={(event) => onChange(event.target.value)} />
      </>
    )
  } else if (variable.kind === 'easing') {
    control = (
      <>
        <input list="easings" value={value} onChange={(event) => onChange(event.target.value)} />
        <datalist id="easings">
          {[
            'ease',
            'ease-in',
            'ease-out',
            'ease-in-out',
            'linear',
            'cubic-bezier(0.2, 0.8, 0.2, 1)',
            'cubic-bezier(0.34, 1.56, 0.64, 1)',
          ].map((easing) => (
            <option key={easing} value={easing} />
          ))}
        </datalist>
      </>
    )
  } else if (variable.kind === 'color') {
    const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : undefined
    control = (
      <>
        <input type="color" value={hex ?? '#000000'} onChange={(event) => onChange(event.target.value)} />
        <input value={value} onChange={(event) => onChange(event.target.value)} />
      </>
    )
  } else {
    control = <input value={value} onChange={(event) => onChange(event.target.value)} />
  }
  return (
    <div className={edited ? 'var edited' : 'var'}>
      <label title={variable.name}>{label}</label>
      <div className="control">{control}</div>
      <button
        className="link"
        title={`Back to ${variable.value}`}
        disabled={!edited}
        onClick={() => onChange(null)}
      >
        Reset
      </button>
    </div>
  )
}

/** Reads a `translate` value such as `4px -2px` (or `none`) as numbers. */
function parseTranslate(value: string | undefined): { x: number; y: number } {
  const [x, y] = (value && value !== 'none' ? value : '0px 0px').split(/\s+/).map((part) => parseFloat(part) || 0)
  return { x: x ?? 0, y: y ?? 0 }
}

const STYLE_LABELS: Partial<Record<EditableProperty, string>> = {
  color: 'Text color',
  'background-color': 'Background',
  'border-width': 'Border width',
  'border-style': 'Border style',
  'border-color': 'Border color',
  'border-radius': 'Corner radius',
  padding: 'Padding',
  margin: 'Margin',
  width: 'Width',
  height: 'Height',
  'font-size': 'Font size',
  'font-weight': 'Font weight',
  'letter-spacing': 'Letter spacing',
  opacity: 'Opacity',
  'box-shadow': 'Shadow',
}

function ElementControls({
  picked,
  styles,
  onChange,
}: {
  picked: Picked
  styles: Partial<Record<EditableProperty, string>>
  onChange: (property: EditableProperty, value: string | null) => void
}) {
  const offset = parseTranslate(styles.translate ?? picked.computed['translate'])
  const nudge = (dx: number, dy: number) =>
    onChange('translate', `${offset.x + dx}px ${offset.y + dy}px`)

  return (
    <div className="element-controls">
      <div className="var">
        <label>Position</label>
        <div className="control nudge">
          <button onClick={(event) => nudge(event.shiftKey ? -10 : -1, 0)} title="Left (Shift: 10px)">←</button>
          <button onClick={(event) => nudge(0, event.shiftKey ? -10 : -1)} title="Up (Shift: 10px)">↑</button>
          <button onClick={(event) => nudge(0, event.shiftKey ? 10 : 1)} title="Down (Shift: 10px)">↓</button>
          <button onClick={(event) => nudge(event.shiftKey ? 10 : 1, 0)} title="Right (Shift: 10px)">→</button>
          <span className="muted">
            {offset.x}px, {offset.y}px
          </span>
        </div>
        <button className="link" disabled={!styles.translate} onClick={() => onChange('translate', null)}>
          Reset
        </button>
      </div>
      {EDITABLE_PROPERTIES.filter((property) => property !== 'translate').map((property) => {
        const value = styles[property] ?? picked.computed[property] ?? ''
        const isColor = property.endsWith('color')
        return (
          <div key={property} className={styles[property] ? 'var edited' : 'var'}>
            <label>{STYLE_LABELS[property] ?? property}</label>
            <div className="control">
              {isColor && (
                <input
                  type="color"
                  value={toHex(value) ?? '#000000'}
                  onChange={(event) => onChange(property, event.target.value)}
                />
              )}
              {property === 'border-style' ? (
                <select value={value} onChange={(event) => onChange(property, event.target.value)}>
                  {['none', 'solid', 'dashed', 'dotted', 'double'].map((style) => (
                    <option key={style}>{style}</option>
                  ))}
                </select>
              ) : (
                <input value={value} onChange={(event) => onChange(property, event.target.value)} />
              )}
            </div>
            <button className="link" disabled={!styles[property]} onClick={() => onChange(property, null)}>
              Reset
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** `rgb(…)` from computed styles, or a hex value, as `#rrggbb` for the color picker. */
function toHex(value: string): string | null {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value)
  if (!match) return null
  return `#${match
    .slice(1, 4)
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('')}`
}

function Section({ title, copy, children }: { title: string; copy?: string | null; children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  return (
    <details className="output">
      <summary>
        <span>{title}</span>
        {copy && (
          <button
            className="link"
            onClick={(event) => {
              event.preventDefault()
              void api.copy(copy).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </summary>
      <div className="output-body">{children}</div>
    </details>
  )
}

function Code({ text }: { text: string }) {
  // Shown as text only; generated code is never rendered outside the sandboxed frame.
  return (
    <pre>
      <code>{text}</code>
    </pre>
  )
}

function Outputs({ details, summary }: { details: AssetDetails; summary: string | null }) {
  const parts = details.html ? splitRecreation(details.html) : null
  const spec = details.spec
  return (
    <section className="outputs">
      <h2>Outputs</h2>
      {summary && <p className="summary">{summary}</p>}
      <Section title="Prompt" copy={details.prompt}>
        <p className="hint">Paste this into any AI coding tool to build with this asset.</p>
        <Code text={details.prompt} />
      </Section>
      {parts && (
        <>
          <Section title="HTML" copy={parts.markup}>
            <Code text={parts.markup} />
          </Section>
          <Section title="CSS" copy={parts.css}>
            <Code text={parts.css || '(none)'} />
          </Section>
          <Section title="JavaScript" copy={parts.js}>
            <Code text={parts.js || '(none)'} />
          </Section>
          <Section title="Full recreation file" copy={details.html}>
            <Code text={details.html ?? ''} />
          </Section>
        </>
      )}
      {spec && (
        <>
          <Section title="Motion & timings" copy={motionText(spec)}>
            {spec.motion.length === 0 ? <p>No motion: this is a still.</p> : <MotionTable spec={spec} />}
          </Section>
          <Section title="Colors & tokens" copy={JSON.stringify(spec.tokens, null, 2)}>
            <Tokens spec={spec} />
          </Section>
          <Section title="Layout" copy={JSON.stringify(spec.layout, null, 2)}>
            <p>{spec.layout.description}</p>
            {spec.layout.regions.length > 0 && (
              <ul>
                {spec.layout.regions.map((region) => (
                  <li key={region.name}>
                    {region.name} ({region.role}
                    {region.parent ? `, in ${region.parent}` : ''}): {Math.round(region.width)}×{Math.round(region.height)}px,{' '}
                    {region.direction}
                    {region.gap === null ? '' : `, gap ${region.gap}px`}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
      {details.specMarkdown && (
        <Section title="Spec (Markdown)" copy={details.specMarkdown}>
          <Code text={details.specMarkdown} />
        </Section>
      )}
    </section>
  )
}

function motionText(spec: Spec): string {
  return spec.motion
    .map(
      (motion) =>
        `${motion.target} — ${motion.trigger}: ${motion.properties.join(', ')}, ${motion.durationMs}ms, delay ${motion.delayMs}ms, ${motion.easing}`,
    )
    .join('\n')
}

function MotionTable({ spec }: { spec: Spec }) {
  const est = (level: string) => (level === 'estimated' ? <span className="muted"> est.</span> : null)
  return (
    <table className="motion">
      <thead>
        <tr>
          <th>Element</th>
          <th>Trigger</th>
          <th>Properties</th>
          <th>Duration</th>
          <th>Delay</th>
          <th>Easing</th>
        </tr>
      </thead>
      <tbody>
        {spec.motion.map((motion, index) => (
          <tr key={index} title={motion.notes || undefined}>
            <td>{motion.target}</td>
            <td>{motion.trigger}</td>
            <td>{motion.properties.join(', ')}</td>
            <td>
              {motion.durationMs}ms{est(motion.confidence.durationMs)}
            </td>
            <td>
              {motion.delayMs}ms{est(motion.confidence.delayMs)}
            </td>
            <td>
              <code>{motion.easing}</code>
              {est(motion.confidence.easing)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Tokens({ spec }: { spec: Spec }) {
  const { tokens } = spec
  return (
    <>
      <div className="swatches">
        {tokens.colors.map((color) => (
          <span key={`${color.name}-${color.value}`} className="swatch" title={color.role}>
            <span className="chip" style={{ background: color.value }} />
            {color.name} <code>{color.value}</code>
          </span>
        ))}
      </div>
      <ul>
        {tokens.typography.map((type) => (
          <li key={`${type.level}-${type.role}`}>
            {type.level} ({type.role}): {type.fontName ? `${type.fontName}, ` : ''}
            {type.family}, {type.size}px{type.lineHeight === null ? '' : `/${type.lineHeight}px`}, weight {type.weight}
          </li>
        ))}
        {tokens.radii.length > 0 && <li>Radii: {tokens.radii.map((radius) => `${radius.value}px`).join(', ')}</li>}
        {tokens.spacing.length > 0 && <li>Spacing: {tokens.spacing.map((space) => `${space.value}px`).join(', ')}</li>}
        {tokens.shadows.map((shadow) => (
          <li key={shadow.value}>Shadow: {shadow.value}</li>
        ))}
        {tokens.effects.map((effect) => (
          <li key={`${effect.type}-${effect.value}`}>
            {effect.type}: {effect.value}
          </li>
        ))}
      </ul>
      {spec.caveats.length > 0 && (
        <>
          <h3>Caveats</h3>
          <ul>
            {spec.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}
