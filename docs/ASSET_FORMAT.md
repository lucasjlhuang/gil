# Asset format

The library is a folder. Each asset is a subfolder named by its slug. This layout is a public contract: the app, the MCP server, the Figma bridge, and people browsing in Finder all read it. Change it only with a `schemaVersion` bump and a migration.

```
~/Documents/gil/
  glass-nav-hover/
    asset.json            identity, status, metadata
    spec.json             structured spec (machine-readable)
    recipe.md             how it is built, with the content taken out, for applying it to other content (written by analysis)
    spec.md               the same spec, readable; what AI tools are given
    notes.md              the user's notes on the asset; a note asset's text (optional)
    capture/
      clip.mp4            cropped recording (recordings only)
      poster.png          representative frame; for a screenshot, the screenshot itself
      frames/             frames sent to the model, named by timestamp in ms (.jpg for recordings, .png for a screenshot)
      page-styles.json    exact fonts, sizes and colours read from the web page (clips from the Chrome extension)
      motion.json         motion measured from every frame of the clip: segments with times, area, easing, stagger and progress times (recordings where something moves); `backdrop` (`x` or `y`, optional) when page content scrolling behind the thing along that axis was left out
      focus.json          the part of the capture the user asked for, when that is not all of it: `fromMs`, `toMs` and an optional `box` (fractions of the capture)
      focus.mp4           the capture cut to that part in time and area; `motion.json` and `frames/` are then of this clip (screenshots have only `focus.png`)
      focus.png           its first frame
    recreation/
      index.html          self-contained recreation, including the user's edits
      base.html           the recreation as Claude wrote it (written by analysis and the editor)
      first.html          the recreation as first made by analysis, before any Refine (never overwritten until re-analysis)
      edits.json          the user's edits, when there are any
      refinements.json    the changes the user asked for with Refine, when there are any
    files/                the original file of an imported image (optional)
```

Only `asset.json` is required. An imported image has `asset.json`, `capture/poster.png` (the image as PNG at full size) and `files/` with the original file. A note has `asset.json` and `notes.md`. A design system has `asset.json` and `design-system.json`. A recording that has not been analyzed has `asset.json` and `capture/clip.mp4` and `capture/poster.png`. A screenshot has `asset.json` and `capture/poster.png` and no clip.

`capture/page-styles.json` (clips from the Chrome extension):

```json
{
  "texts": [{ "sample": "Pricing", "fontFamily": "Inter, sans-serif", "fontSize": 32, "lineHeight": 40, "fontWeight": 700, "letterSpacing": -0.5, "color": "rgb(17, 17, 17)", "count": 1 }],
  "colors": [{ "value": "rgb(255, 255, 255)", "uses": ["background"], "count": 64 }]
}
```

Clips made since 2026-11-22 may also have `boxes` (each element's `label` such as `button.cta`, `x`, `y`, `width`, `height` relative to the clip, `radius` and `padding` as computed, at most 40) and `motions` (`kind` `animation` or `transition`, `label`, `properties`, `durationMs`, `delayMs`, `easing`, and for animations `iterations` (-1 for endless) and `keyframes` in short, at most 30). Sizes are CSS pixels; `lineHeight` is `null` for `normal`; `fontFamily` is the page's computed font-family list; `count` is how many text runs or sample points use it. At most 40 of each, texts largest first, colours most used first.

`design-system.json` (design systems only) lists the assets it bundles by `id`, so renaming a member does not break it; ids of assets no longer in the library are ignored by readers, and a design system never contains another:

```json
{ "version": 1, "members": ["01JAB3X9K2M4Q7R8S5T6V0W1YZ", "01JAB3X9K2M4Q7R8S5T6V0W1YA"] }
```

A design system has `kind` `design-system`, `origin` `written`, `status` `ready`, `capture` and `analysis` `null`, a name made from its title, and the summary "A design system bundling N assets." At most 100 members.

`font.json` (font assets only):

```json
{
  "version": 1,
  "text": "MIREGO",
  "modelGuess": "Neue Haas Grotesk",
  "category": "sans-serif",
  "weight": 800,
  "italic": false,
  "traits": ["tight spacing", "flat terminals"],
  "matches": [{ "family": "Inter", "id": "inter", "weight": 800, "score": 77.9 }]
}
```

`text` is what the model read and the candidates were set in; `modelGuess` may be a paid font that is not in the free catalogue; `matches` are free Google Fonts families ranked by shape match (0–100), best first.

Files directly in the library folder are not assets. One is defined: `glossary.json`, the user's own design terms, which the app edits in Settings and the MCP server serves:

```json
{ "version": 1, "terms": [{ "term": "chip", "meaning": "the small rounded status label" }] }
```

Terms are 1–80 characters and meanings 1–2000, one entry per term (compared without case), sorted, at most 500. Readers treat a missing or unreadable file as an empty glossary and ignore unknown fields; writers keep them.

Folders whose names start with a dot are not assets. The app assembles a new capture in `.staging-<id>/` and renames it into place when it is complete; readers must skip these.

## asset.json

```json
{
  "schemaVersion": 4,
  "id": "01JAB3X9K2M4Q7R8S5T6V0W1YZ",
  "name": "glass-nav-hover",
  "title": "Glass nav hover",
  "aliases": ["frosted nav"],
  "tags": ["navigation", "hover", "glassmorphism"],
  "kind": "motion",
  "lens": "auto",
  "origin": "capture",
  "status": "ready",
  "summary": "Nav links with a frosted pill that slides between items on hover.",
  "userContext": "Just the pill sliding between links, ignore the logo.",
  "source": { "app": "Arc", "windowTitle": "Example — Home", "url": null },
  "capture": { "mode": "recording", "width": 640, "height": 96, "scale": 2, "durationMs": 4200, "isStill": false },
  "analysis": { "model": "…", "rounds": 2, "error": null, "usage": { "inputTokens": 48210, "outputTokens": 9120, "costUsd": 0.375 } },
  "createdAt": "2026-10-13T18:04:11Z",
  "updatedAt": "2026-10-13T18:05:02Z"
}
```

- Every field shown above is always present. `summary`, `userContext`, `capture`, `analysis` and each field of `source` may be `null`; nothing else may.
- `id` is a ULID. It is permanent and never changes. `name` is the slug, equals the folder name, and can be renamed.
- `name`: lowercase letters, digits and hyphens, starting with a letter, unique across the library, at most 48 characters. Aliases are free text and must not collide with another asset's name.
- `kind` is the asset type, which decides what gil extracts, saves and serves for it:
  - `motion`: a recording where the point is how it moves (timings, easing, order, and a recreation).
  - `component`: one element or widget (tokens and a recreation).
  - `layout`: the arrangement of a section or page (`spec.layout.regions`).
  - `type-system`: the text levels of a page (`spec.tokens.typography`); its `recreation/index.html` is a type specimen written by gil from those values (colours and font names are checked before they go into it). It is re-analyzed, not refined.
  - `color-system`: the palette of a page (`spec.tokens.colors`). The colour lens makes one from any asset with an image: `capture/poster.png` copied from the source, colours measured from its pixels (all `measured`), roles guessed from area and contrast, contrast ratios in `caveats`, `recreation/index.html` a swatch page written by gil, `analysis` `null`, named `<source>-colors`. When the colour lens is chosen at capture, the captured asset itself becomes the colour system instead: it keeps its capture (a recording keeps its clip, with `isStill` `true`), gains the spec and swatch page, and its capture-time name becomes `colors` (`colors-2`…).
  - `spacing-system`: the spacing scale and column grid of a page (`spec.tokens.spacing`, and the unit and grid in `spec.layout.description`). The spacing lens makes one from any asset with an image, on the Mac with no model call: the boxes come from `capture/page-styles.json` when the capture came through the Chrome extension, otherwise they are cut from `capture/poster.png`; the gaps between neighbouring boxes are grouped into steps and checked against a base unit (12, 10, 8, 6, 5, 4, 3 or 2 px); equal boxes evenly spaced in a row are a grid. `recreation/index.html` is a specimen page written by gil, `analysis` `null`, named `<source>-spacing`.
  - `effect`: a look or material (blur, glass, shadows, gradients, grain, glows), made by the Effects lens; analyzed like a component, with the effect's exact CSS values in `spec.tokens.effects` and `shadows`.
  - `icon-style`: an icon set or illustration style, made by the Icons lens; analyzed like a component, with the rules to draw new icons to (grid, stroke, corners, fill) in the recipe.
  - `note`: a guideline or term of the user's own, with no capture (see below).
  - `design-system`: a named bundle of other assets (see below).
  - `font`: the typeface of text in a capture, made by Another Lens… → Font on any asset with an image: `capture/poster.png` copied from the source, `font.json` (below), a spec with one typography entry whose `fontName` is the best free match (or the model's guess), and a recreation page that sets the captured text in the three best free matches, with those fonts embedded as `data:` URLs. Named `<source>-font`.
  - `other`: anything else, including captures not analyzed yet.
- `lens`: what the user asked gil to look for when capturing (the lens picker next to "What should I look for?") or when running another lens on a saved asset: `auto` (analysis decides), `motion`, `component`, `layout`, `type`, `color`, `font`, `spacing`, `effects`, `icons`, `transition` (a page or view transition) or `scroll` (scroll choreography). A lens other than `auto` decides `kind` (`type` makes `type-system`, `color` makes `color-system`, `spacing` makes `spacing-system`, `effects` makes `effect`, `icons` makes `icon-style`, `transition` and `scroll` make `motion`). Version 4 added the kinds `spacing-system`, `effect` and `icon-style` and the lenses from `spacing` on; a version 3 file is read as version 4 unchanged. The colour lens runs on the Mac without a model call; the others shape the analysis. `font` is never chosen at capture: it is run on a saved asset and makes a font asset (see `font` above: only the poster is copied, `capture` becomes a screenshot, and `analysis` records the identification call). Font assets are not re-analyzed or refined. Another motion, component, layout or type lens on a saved asset makes a new asset `<source>-<lens>` (or a fresh capture-time name if the source has none yet) with a copy of the capture (clip, poster, page styles) and of `files/`, not of what analysis made. A version 3 `asset.json` without `lens` is read as `auto`.
- `origin`: `capture` (from gil's overlay), `import` (an image added by drag, paste or Import) or `written` (a note the user typed).
- `status`: `analyzing`, `ready`, `failed`, `stored` (saved as is, not analyzed: imports, and captures that analysis has not been run on).
- A capture that has not been analyzed has a provisional `name` of the form `capture-YYYYMMDD-HHMMSS` (local time, with `-2`, `-3`… if taken), a matching `title`, `kind` `other`, empty `aliases` and `tags`, and `null` for `summary` and `analysis`. `source.app` and `source.windowTitle` are the recorded window's app and title (older captures from gil's former built-in browser have `gil browser` and the page title, and set `source.url`); each is `null` when it could not be read (the title needs Screen Recording permission, and a capture over the desktop has no window). An imported image is stored like an unanalyzed screenshot: provisional name `image-YYYYMMDD-HHMMSS`, title `Image …`, `origin` `import`, `capture.mode` `screenshot` with its CSS size taken as its pixel size (`scale` 1), and all `source` fields `null`; it can be analyzed like a screenshot. A note has `kind` `note`, `origin` `written`, `status` `ready`, `capture` and `analysis` `null`, a name made from its title, and `summary` set from its text (on one line, at most 200 characters), which the app keeps in step when the text changes.
- `createdAt` and `updatedAt` are ISO 8601 in UTC.
- After analysis, `status` is `ready` (or `failed`, with `analysis.error` saying why and `analysis.rounds` `0`), and `title`, `kind`, `summary` and `tags` come from the analysis. An asset that still has its capture-time name is renamed to the suggested name; a name the user chose is kept. `analysis.model` is the model that wrote the saved recreation (analysis uses a small model to plan, a main one to build and a cheaper one for a correction); `analysis.rounds` counts the first recreation plus each verify-and-correct or refine round. `analysis.usage` (missing on assets analyzed before it was recorded) is the tokens (cached input included in `inputTokens`) and US dollars spent on the current analysis and its refinements, each call priced at the model that answered it; a fresh analysis starts it again, and `costUsd` is `null` when a call was answered by a model gil has no price for. A refinement that fails leaves `status` `ready` with the previous recreation and the reason in `analysis.error`. `capture.isStill` is set by motion detection.
- `capture.mode` is `recording` (there is a `clip.mp4`) or `screenshot` (a single image, `poster.png`, at full resolution; `durationMs` is `0` and `isStill` is `true`).
- Captures from the Chrome extension (a later phase) set `source.app` to the browser's name, `source.windowTitle` to the tab title and `source.url` to the tab's address.
- `capture.width` and `height` are in CSS pixels; `scale` is the number of clip pixels per CSS pixel, so the clip is `width × scale` by `height × scale` to within a pixel (clip dimensions are always even). It is measured from the recording and is usually, but not always, the scale factor of the display the window was on. `capture.isStill` is `false` until motion detection has run.

## spec.json

```json
{
  "schemaVersion": 2,
  "description": "Longer description of what this is and what makes it distinctive.",
  "tokens": {
    "colors": [{ "name": "pill", "value": "rgba(255,255,255,0.12)", "role": "surface", "confidence": "estimated" }],
    "typography": [
      {
        "level": "body",
        "role": "link",
        "family": "sans-serif, geometric",
        "fontName": "Inter",
        "size": 14,
        "lineHeight": 20,
        "weight": 500,
        "letterSpacing": 0,
        "confidence": { "family": "estimated", "size": "measured", "lineHeight": "estimated", "weight": "estimated", "letterSpacing": "estimated" }
      }
    ],
    "radii": [{ "value": 999, "confidence": "estimated" }],
    "spacing": [{ "value": 8, "confidence": "estimated" }, { "value": 16, "confidence": "estimated" }],
    "shadows": [],
    "effects": [{ "type": "backdrop-blur", "value": "12px", "confidence": "estimated" }]
  },
  "layout": {
    "description": "A horizontal row of links with a pill behind the hovered one.",
    "regions": [
      { "name": "nav", "role": "navigation", "parent": null, "x": 0, "y": 0, "width": 640, "height": 96, "direction": "row", "gap": 24, "align": "center", "confidence": "estimated" }
    ]
  },
  "motion": [
    {
      "target": "pill",
      "trigger": "hover on a different link",
      "properties": ["transform", "width"],
      "durationMs": 320,
      "delayMs": 0,
      "easing": "cubic-bezier(0.2, 0.8, 0.2, 1)",
      "confidence": { "durationMs": "measured", "delayMs": "measured", "easing": "estimated" },
      "notes": "Slight overshoot visible in two frames."
    }
  ],
  "states": ["default", "hover"],
  "caveats": ["Font family inferred from letterforms; not identified exactly."]
}
```

`motion` is an empty array for stills. Every value carries a `confidence`: `measured` (measured from the capture, by gil or exactly pinned down by the frames) or `estimated` (the AI's reading). Typography has one entry per text level, largest first; `fontName` is the font it looks like, or `null`; `lineHeight` is `null` when it cannot be seen. Layout regions are boxes in CSS pixels from the capture's top left, nested through `parent` (a region's `name`, or `null` at the top level); `direction` is `row`, `column`, `grid`, `stack` or `none`, and `gap` is `null` when there is none. `spec.md` is generated from `spec.json` and regenerated whenever the spec changes; if a user edits the spec in the app, the app writes both.

Version 1 specs (before 2026-11-16) may still be on disk: readers upgrade them in memory (`migrateSpec` in `src/shared/spec.ts`). Every token value becomes `estimated`; typography gets `level` from its role and `null` `fontName` and `lineHeight`; radii, spacing and shadows become `{ value, confidence }`; and the layout sentence becomes `{ "description": …, "regions": [] }`. The file is rewritten in the new version the next time the asset is analyzed.

## recipe.md

The main thing an AI tool builds from when the user wants an asset with their own content ("use this animation for our logo"). The recreation is one worked example with the captured content; the recipe is the technique with the content taken out. Markdown with these sections, in this order: a summary in terms of roles; **Parts** (each part's role and its slot: what the user supplies for it, or "Fixed"); **Steps, in order** (each move with its trigger, start, duration and easing; left out for stills); **Layout** (sizes and gaps, as numbers and proportions); **Shapes as captured** (content-specific shapes as SVG path data with what to notice); **How it is built** (rules that hold for any content, including how content-specific shapes are constructed); **To apply it to new content**; **Keep as captured**. Written by analysis since 2026-11-23; older assets have none until they are analyzed again. Type systems, colour systems, fonts, notes and design systems have none.

## recreation/index.html

`index.html` is the only file other tools need. It is self-contained: when gil matched its text to real fonts, each font is embedded as `url("data:font/woff2;gil=<family>-<weight>-<style>;base64,…")`, where the `gil=` part names the Google Font so the data can be recognised and left out when the code is given to an AI tool. When the user has edited the recreation it is `base.html` with one `<style data-gil-edits>` element added at the end of the body; with no edits the two are identical. Older assets may have only `index.html`.

`edits.json`:

```json
{
  "version": 1,
  "vars": { "--pill-duration": "480ms", "--pill": "#2f6bff" },
  "rules": [
    { "selector": "body > nav:nth-child(1) > a:nth-child(2)", "styles": { "translate": "4px 0px", "border-radius": "12px" } }
  ]
}
```

`vars` are new values for the custom properties on `:root`; `rules` are style overrides for one element, addressed by a structural selector of `tag:nth-child(n)` steps from `body`, limited to a fixed list of properties (`translate`, colors, border, radius, padding, margin, size, type, opacity, shadow). Values may not contain `;`, braces, angle brackets, backslashes, `url(` or `@import`. Re-analyzing replaces `base.html`, `index.html` and `first.html` and removes `edits.json` and `refinements.json`. `first.html` is the recreation exactly as analysis first made it; a Refine never changes it, so a refined asset can still be compared with its first result (assets analyzed before 2026-11-22 get it at their first Refine, from what they had then). A refinement also replaces both HTML files and removes `edits.json`.

`refinements.json` lists, oldest first, the instructions the user gave Refine since the last analysis, so later checks against the original frames keep those deliberate changes (at most 50, each at most 2000 characters):

```json
{ "version": 1, "requests": ["Change Mirego to the owner and keep the same animation"] }
```

- One file. All CSS and JS inline. No external requests of any kind: no CDNs, fonts, images or fetch calls. System font stacks only.
- Placeholder text and neutral shapes in place of the source's real content, logos or photos.
- Renders correctly at the capture's width and height and stays centred if the frame is larger.
- Motion that the capture triggered by hover or click responds to the same interaction.
- Exposes `window.replay()`, which plays the full captured sequence from the start without user input. The app's Replay button and the verify step both call it.
- Design tokens and every timing (durations and delays in `ms`, easings) declared as CSS custom properties on `:root`, named to match `spec.json`, and used through `var(...)`, so a reader can lift them out and the editor can change them. Script-driven motion reads them when it runs.

## Compatibility

### Versions

- **3** (current): `kind` takes the asset types, and `lens` and `origin` `written` are added. (Version 3 was settled before any release wrote it, so `lens` `font`, `origin` `written` and `analysis.usage` are part of it from the start.) The app upgrades a version 2 `asset.json` in place on its first scan: `animation` becomes `motion`, `style` and `illustration` become `component`, and `component`, `layout` and `other` stay; `lens` is set to `auto`. (The MCP server upgrades in memory only; it never writes.)
- **2**: added `capture.mode`.
- **1**: no `capture.mode`; every capture was a recording. The app upgrades a version 1 `asset.json` in place, adding `"mode": "recording"`, the first time it scans the library. Other readers should treat a version 1 capture the same way.

Readers must ignore unknown fields. Writers must preserve fields they do not understand. An asset folder with a missing or invalid `asset.json` is skipped and reported, never deleted.
