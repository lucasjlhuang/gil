import { useCallback, useEffect, useState } from 'react'
import type {
  ActionResult,
  BridgeStatus,
  LibraryItem,
  LibraryListing,
  McpStatus,
  ScreenPermission,
} from '../shared/channels'
import type { GlossaryTerm } from '../shared/glossary'
import { searchAssets } from '../shared/search'
import { MemberPicker } from './MemberPicker'
import { Review, statusLabel } from './Review'

const api = window.gilLibrary

/** The main window: the library. */
export function App() {
  return (
    <div className="app">
      <header>
        <span className="spacer" />
        <kbd>⌘⇧2</kbd>
        <button className="primary" onClick={() => void api.capture(false)}>
          Capture Region
        </button>
      </header>
      <Library />
    </div>
  )
}

function Library() {
  const [listing, setListing] = useState<LibraryListing | null>(null)
  const [permission, setPermission] = useState<ScreenPermission | null>(null)
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void api.appInfo().then((info) => setVersion(info.label))
  }, [])

  const refresh = useCallback(() => {
    void api.list().then(setListing)
    void api.getPermission().then(setPermission)
    void api.hasApiKey().then(setHasKey)
  }, [])

  useEffect(() => {
    refresh()
    const unsubscribe = api.onChanged(refresh)
    // The permission can change in System Settings while this window is in the background.
    window.addEventListener('focus', refresh)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  const items = listing?.items ?? []
  const open = items.find((item) => item.asset.id === openId) ?? null
  const shown = query.trim()
    ? searchAssets(
        items.map((item) => item.asset),
        query,
      ).flatMap((asset) => items.filter((item) => item.asset.id === asset.id))
    : items

  const [newNote, setNewNote] = useState(false)
  const [newSystem, setNewSystem] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const report = (result: ActionResult) => setNotice(result.ok ? null : result.error)

  // Drop image files anywhere on the library grid, or paste an image, to add it.
  useEffect(() => {
    if (open) return
    const over = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    const drop = (event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length === 0) return
      event.preventDefault()
      void api.importFiles(files).then(report)
    }
    const paste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea')) return
      if (![...(event.clipboardData?.items ?? [])].some((entry) => entry.type.startsWith('image/'))) return
      event.preventDefault()
      // A file copied in Finder is imported from disk; the clipboard would only give its icon.
      const files = [...(event.clipboardData?.files ?? [])]
      void (files.length > 0 ? api.importFiles(files) : api.importClipboard()).then(report)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
      window.removeEventListener('paste', paste)
    }
  }, [open])

  if (open) return <Review item={open} items={items} canAnalyze={hasKey === true} onClose={() => setOpenId(null)} />

  return (
    <div className="library">
      <div className="library-bar">
        <span className="count">
          {query.trim() ? `${shown.length} of ${items.length}` : items.length} {items.length === 1 ? 'asset' : 'assets'}
        </span>
        <input
          className="search"
          type="search"
          placeholder="Search names, tags, aliases"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button title="Add images: or drag them here, or paste one" onClick={() => void api.importDialog().then(report)}>
          Import…
        </button>
        <button onClick={() => setNewNote((value) => !value)}>New Note</button>
        <button title="Group assets into one named design system" onClick={() => setNewSystem((value) => !value)}>
          New Design System
        </button>
        <button onClick={() => setShowSettings((value) => !value)}>Settings</button>
      </div>
      <main>
        {permission !== null && permission !== 'granted' && (
          <PermissionNotice permission={permission} onChange={setPermission} />
        )}
        {notice && <div className="error">{notice}</div>}
        {newNote && <NoteForm onDone={() => setNewNote(false)} />}
        {newSystem && <DesignSystemForm items={items} onDone={() => setNewSystem(false)} />}
        {(showSettings || hasKey === false) && (
          <Settings
            hasKey={hasKey === true}
            onChange={() => {
              void api.hasApiKey().then(setHasKey)
            }}
          />
        )}
        {listing && items.length === 0 && (
          <div className="empty">
            Nothing captured yet. Press ⌘⇧2, drag over something on screen, and press Screenshot or
            Record. Or drop or paste an image here.
          </div>
        )}
        <div className="grid">
          {shown.map((item) => (
            <AssetCard key={item.asset.id} item={item} canAnalyze={hasKey === true} onOpen={() => setOpenId(item.asset.id)} />
          ))}
        </div>
        {listing && listing.skipped.length > 0 && (
          <div className="skipped">
            Skipped folders without a valid asset.json:
            <ul>
              {listing.skipped.map((entry) => (
                <li key={entry.folder}>
                  <code>{entry.folder}</code>: {entry.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
      {listing && (
        <footer>
          Library folder: <code>{listing.root}</code>
          {version && <span className="version">gil {version}</span>}
        </footer>
      )}
    </div>
  )
}

/** The Anthropic API key. It is typed here once and never shown or sent back. */
function Settings({ hasKey, onChange }: { hasKey: boolean; onChange: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  return (
    <section className="settings">
      <h2>Anthropic API key</h2>
      <div>
        gil uses your own key to analyze captures with Claude: the frames of each capture are
        sent to Anthropic, and usage is billed to your Anthropic account. The key is stored
        encrypted on this Mac and is never shown again.{' '}
        {hasKey ? <strong>A key is saved.</strong> : <strong>No key is saved yet.</strong>}
      </div>
      <form
        className="key-row"
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setMessage(null)
          void api.setApiKey(key).then((result) => {
            setBusy(false)
            if (result.ok) {
              setKey('')
              setMessage({ ok: true, text: 'Key checked and saved.' })
              onChange()
            } else {
              setMessage({ ok: false, text: result.error })
            }
          })
        }}
      >
        <input
          type="password"
          value={key}
          autoComplete="off"
          spellCheck={false}
          placeholder={hasKey ? 'Paste a new key to replace it' : 'sk-ant-…'}
          onChange={(event) => setKey(event.target.value)}
        />
        <button className="primary" type="submit" disabled={busy || key.trim().length === 0}>
          {busy ? 'Checking…' : 'Save Key'}
        </button>
        {hasKey && (
          <button
            type="button"
            onClick={() =>
              void api.clearApiKey().then(() => {
                setMessage({ ok: true, text: 'Key removed.' })
                onChange()
              })
            }
          >
            Remove Key
          </button>
        )}
      </form>
      {message && <div className={message.ok ? 'ok' : 'error'}>{message.text}</div>}
      <AiTools />
      <ChromeExtension />
      <GlossaryEditor />
    </section>
  )
}

/** Pairing with the Chrome extension, which clips from web pages with exact fonts and colours. */
function ChromeExtension() {
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void api.bridgeStatus().then(setStatus)
  }, [])
  if (!status) return null
  return (
    <>
      <h2>Chrome extension</h2>
      <div>
        Clip from web pages in Chrome. gil also saves the exact fonts, sizes and colours the page
        uses for what you clip (values only, never the site&rsquo;s code or fonts). To set it up,
        open chrome://extensions, turn on Developer mode, choose Load unpacked and pick the folder,
        then paste the pairing code into the extension&rsquo;s options.
      </div>
      {status.state === 'failed' && <div className="error">{status.error}</div>}
      <div className="key-row tool-row">
        <button onClick={() => void api.revealExtension()}>Show Extension Folder</button>
        <button
          onClick={() =>
            void api.copy(status.pairingCode).then(() => {
              setCopied(true)
            })
          }
        >
          {copied ? 'Pairing Code Copied' : 'Copy Pairing Code'}
        </button>
      </div>
    </>
  )
}

/** A design system: a named bundle of assets, fetched by AI tools in one call. */
function DesignSystemForm({ items, onDone }: { items: LibraryItem[]; onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  return (
    <section className="settings">
      <h2>New design system</h2>
      <div>Group the type, colours, components and motion that belong together. AI tools get all of them from its one name.</div>
      <div className="key-row">
        <input value={title} placeholder="Name, for example Acme brand" onChange={(event) => setTitle(event.target.value)} />
      </div>
      <MemberPicker items={items} selected={selected} onChange={setSelected} />
      <div className="key-row">
        <button
          className="primary"
          disabled={!title.trim()}
          onClick={() =>
            void api.createDesignSystem(title, selected).then((result) => {
              if (result.ok) onDone()
              else setError(result.error)
            })
          }
        >
          Save Design System
        </button>
        <button onClick={onDone}>Cancel</button>
      </div>
      {error && <div className="error">{error}</div>}
    </section>
  )
}

/** A note asset: a guideline or a term of your own, with no capture. */
function NoteForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <section className="settings note-form">
      <h2>New note</h2>
      <div>A guideline or a term of your own. AI tools connected to gil can read it by its name.</div>
      <div className="key-row">
        <input value={title} placeholder="Title, for example Button rules" onChange={(event) => setTitle(event.target.value)} />
      </div>
      <textarea
        value={text}
        rows={6}
        placeholder="For example: primary buttons are always pill shaped, 44px tall, never all caps."
        onChange={(event) => setText(event.target.value)}
      />
      <div className="key-row">
        <button
          className="primary"
          disabled={!title.trim()}
          onClick={() =>
            void api.createNote(title, text).then((result) => {
              if (result.ok) onDone()
              else setError(result.error)
            })
          }
        >
          Save Note
        </button>
        <button onClick={onDone}>Cancel</button>
      </div>
      {error && <div className="error">{error}</div>}
    </section>
  )
}

/** The user's own design terms, served to AI tools with the assets. */
function GlossaryEditor() {
  const [terms, setTerms] = useState<GlossaryTerm[] | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    void api.getGlossary().then(setTerms)
  }, [])
  if (!terms) return null
  const update = (index: number, change: Partial<GlossaryTerm>) =>
    setTerms(terms.map((entry, i) => (i === index ? { ...entry, ...change } : entry)))

  return (
    <>
      <h2>Your terms</h2>
      <div>
        Words you use for design things, and what you mean by them. AI tools connected to gil get
        these with your assets, so &ldquo;add a chip&rdquo; means what you mean.
      </div>
      {terms.map((entry, index) => (
        <div className="key-row tool-row" key={index}>
          <input
            className="term"
            value={entry.term}
            placeholder="Term"
            onChange={(event) => update(index, { term: event.target.value })}
          />
          <input
            value={entry.meaning}
            placeholder="What it means"
            onChange={(event) => update(index, { meaning: event.target.value })}
          />
          <button onClick={() => setTerms(terms.filter((_, i) => i !== index))}>Remove</button>
        </div>
      ))}
      <div className="key-row tool-row">
        <button onClick={() => setTerms([...terms, { term: '', meaning: '' }])}>Add Term</button>
        <button
          className="primary"
          onClick={() =>
            void api.saveGlossary(terms).then((result) => {
              setMessage(result.ok ? { ok: true, text: 'Terms saved.' } : { ok: false, text: result.error })
              if (result.ok) void api.getGlossary().then(setTerms)
            })
          }
        >
          Save Terms
        </button>
      </div>
      {message && <div className={message.ok ? 'ok' : 'error'}>{message.text}</div>}
    </>
  )
}

/** Registers gil's MCP server with AI tools, so they can fetch assets by name. */
function AiTools() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const refresh = () => void api.mcpStatus().then(setStatus)
  useEffect(refresh, [])
  const run = (work: () => Promise<ActionResult>, done: string) =>
    void work().then((result) => {
      setMessage(result.ok ? { ok: true, text: done } : { ok: false, text: result.error })
      refresh()
    })
  if (!status) return null

  return (
    <>
      <h2>Use your assets in AI tools</h2>
      <div>
        Connect gil to an AI tool and it can look up any asset by name, for example &ldquo;build a
        button like red-hover-cta&rdquo;. The tool reads the library on this Mac; nothing is
        uploaded by gil.
      </div>
      <div className="key-row tool-row">
        <span>Claude Desktop</span>
        {status.claudeDesktop === 'connected' ? (
          <strong>Connected. Restart Claude Desktop if it was open.</strong>
        ) : (
          <button onClick={() => run(() => api.connectClaudeDesktop(), 'Connected. Restart Claude Desktop to use it.')}>
            {status.claudeDesktop === 'missing' ? 'Connect (Claude Desktop not found)' : 'Connect'}
          </button>
        )}
      </div>
      <div className="key-row tool-row">
        <span>Claude Code: run this once in Terminal</span>
        <button onClick={() => void api.copy(status.claudeCodeCommand).then(() => setMessage({ ok: true, text: 'Command copied.' }))}>
          Copy Command
        </button>
        <button onClick={() => run(() => api.installSkill(), 'Skill installed for Claude Code.')}>
          {status.skill === 'installed'
            ? 'Skill Installed'
            : status.skill === 'outdated'
              ? 'Update Skill'
              : status.skill === 'other'
                ? 'Skill Folder Taken'
                : 'Install Skill'}
        </button>
      </div>
      <code className="mcp-command">{status.claudeCodeCommand}</code>
      {message && <div className={message.ok ? 'ok' : 'error'}>{message.text}</div>}
    </>
  )
}

function PermissionNotice({
  permission,
  onChange,
}: {
  permission: ScreenPermission
  onChange: (permission: ScreenPermission) => void
}) {
  return (
    <section className="permission">
      <h2>gil needs Screen Recording permission</h2>
      <div>
        gil records the region you select so it can save it as a clip. Recordings stay on this
        Mac. macOS currently reports this permission as <strong>{permission}</strong>.
      </div>
      <ol>
        <li>Open System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording.</li>
        <li>
          Turn on gil. When running from source, the entry is named Electron, or it is the
          terminal app you started it from.
        </li>
        <li>Relaunch gil. macOS only applies the change to a freshly started app.</li>
      </ol>
      <div className="actions">
        {permission === 'not-determined' && (
          <button
            className="primary"
            onClick={() => void api.requestPermission().then(onChange)}
          >
            Ask macOS for Access
          </button>
        )}
        <button onClick={() => void api.openPermissionSettings()}>Open System Settings</button>
        <button onClick={() => void api.relaunch()}>Relaunch gil</button>
        <button onClick={() => void api.capture(true)}>Try Capturing Anyway</button>
      </div>
    </section>
  )
}

function AssetCard({
  item,
  canAnalyze,
  onOpen,
}: {
  item: LibraryItem
  canAnalyze: boolean
  onOpen: () => void
}) {
  const { asset, posterUrl } = item
  const capture = asset.capture
  const analyzable = capture !== null && (asset.status === 'stored' || asset.status === 'failed')

  return (
    <article className="card">
      <button className="media" title="Open" onClick={onOpen}>
        {posterUrl ? (
          <img src={posterUrl} alt="" />
        ) : (
          (asset.kind === 'note' || asset.kind === 'design-system') && (
            <div className="note-text">{asset.summary ?? 'Empty note'}</div>
          )
        )}
      </button>
      <div className="meta">
        <div className="name">{asset.name}</div>
        <div className="detail">
          <span className={`status ${asset.status}`}>{statusLabel(asset.status)}</span>
          {capture &&
            (capture.mode === 'screenshot'
              ? ' · screenshot'
              : ` · ${(capture.durationMs / 1000).toFixed(1)}s`)}
        </div>
        {asset.summary && <div className="detail">{asset.summary}</div>}
        {asset.status === 'failed' && asset.analysis?.error && (
          <div className="detail error">{asset.analysis.error}</div>
        )}
        {analyzable && (
          <button
            className="analyze"
            disabled={!canAnalyze}
            title={canAnalyze ? undefined : 'Add your Anthropic API key in Settings first'}
            onClick={() => void api.analyze(asset.id)}
          >
            {asset.status === 'failed' ? 'Try Again' : 'Analyze'}
          </button>
        )}
      </div>
    </article>
  )
}
