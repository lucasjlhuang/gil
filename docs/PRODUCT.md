# Product

## The problem

Designers and front-end builders constantly see things worth reusing: a hover effect, a card layout, a page transition, a loading animation. Today the options are a screenshot folder nobody searches, or describing the thing from memory to an AI tool and getting something generic back. There is no way to say "use the nav hover I saved last week" and have a tool know exactly what that means.

## What gil does

gil is a standalone Mac app that connects to AI agents: a personal library of assets you clip, save, upload or write, in your own terms, for use in vibe-coding projects. AI recreation of captures is a core part. It is not a design generator. (Decided 2026-11-16; the plan of record is the review doc "gil: full review".)

The point of an asset is reuse with the user's own content (decided 2026-11-23): the user captures an animation or layout, and later tells their AI "use that animation for our logo", and it is rebuilt with their name, text and images. So each analysis saves two things: an exact recreation, which proves gil understood the capture, and a recipe, which says how it is built with the content taken out, for an AI tool to apply to anything.

Animation is the main use case, not the only one: any recording, screenshot or image can become an asset, and a lens says what to look for: motion, a component, a layout, a type system or a colour system. Notes and design systems (named bundles of assets) are assets too.

gil turns anything on screen into a named, reusable reference.

1. Press a global shortcut.
2. Drag a rectangle over the thing you want.
3. Pick a lens (Auto, Motion, Component, Layout, Type, Colour) and optionally type what to look for ("just the button hover", "the stagger timing on the list").
4. Take a screenshot, or record: interact with the area while gil records it, then stop.
5. gil analyzes the clip and saves an asset: a working recreation in code, a structured spec, and the original clip.
6. Give it a name. From then on, "glass-nav-hover" means that exact thing in Claude Code, in Figma, or anywhere you paste it.

## Who it is for

One person at first: a designer who builds with AI coding tools and Figma, works on several projects at once, and wants a personal library of visual and motion references that those tools can actually use. Single user, local, no accounts for now. A paid plan for AI usage, with sign-in, is planned for later (see Scope); the library stays local either way.

## Core concepts

**Capture.** A screenshot or a recording of a screen region, plus optional user context and metadata about where it came from (app name, window title, and URL when available). A recording is a few seconds long; if nothing moves in it, gil detects that and treats it as a still.

**Asset.** One entry in the library. It has a name, and up to four parts:

- the original capture (clip and poster frame)
- a spec: what it is, colors, typography, spacing, layout, and for motion the properties animated, durations, delays, easing and triggers
- a recreation: self-contained HTML/CSS/JS that renders live in the app
- notes: the user's context and anything they add later

**Name.** The handle. Unique, short, kebab-case (`glass-nav-hover`). The AI suggests one; the user can accept or change it at any time. Assets can also have aliases and tags. Other tools look assets up by name, so naming is a first-class action, not a metadata field buried in a panel.

**Library.** All assets, browsable and searchable in the app, and stored as plain folders on disk.

**Lens.** What gil looks for in a capture. Each lens makes its own named asset, because "the type system from that page" and "the layout from that page" are different lookups for an agent. A saved capture can be run through another lens without capturing again. The colour lens measures colours from the pixels on the Mac, with no AI call.

**Measured or estimated.** gil measures what it can on the Mac (timings and easing from every frame, colours from pixels, exact fonts and sizes from web pages through the Chrome extension), and the model judges the rest. Every value in a spec says which it is.

**Glossary.** The user's own design terms and what they mean, served to AI tools with the assets.

## User flows

### Capture (the main flow)

1. User presses the shortcut (default `Cmd+Shift+2`, configurable).
2. The screen dims and the cursor becomes a crosshair. User drags a rectangle over part of a window. `Esc` cancels.
3. gil outlines the window the selection belongs to and names it, so it is clear exactly what will be captured. A small panel appears beside the selection with one optional text field, "What should I look for?", a Screenshot button and a Record button. Screenshot saves the selection straight away. `Enter` starts recording.
4. The dimming clears. A thin outline marks the region and a small timer shows it is recording. gil records that window on its own, not the screen, so the user can interact with it, or cover it, switch apps and keep working while it records. The outline and timer never appear in the recording, and the mouse passes through to the app underneath so the user can hover, click and scroll to trigger whatever they want captured.
5. User presses the shortcut again, or clicks the timer, to stop. Recording also stops at a maximum length (default 10 seconds).
6. The asset is added to the library immediately as "Analyzing" with its clip playable. gil does not come to the front, so the user stays where they were. A notification fires when analysis finishes.
7. User opens it, sees the original and the recreation side by side, and confirms or edits the suggested name.

The user must never wait on analysis to keep working. Capture is instant; analysis is a background job.

### Review and refine

- Original clip and live recreation side by side, with replay and a loop toggle.
- Outputs in sections that open and close, each with a copy button: a ready-to-paste prompt for AI tools, the HTML, CSS and JavaScript of the recreation, the full recreation file, motion and timings, colors and tokens, layout, and the spec as Markdown.
- **Make it your own.** The recreation can be edited live. *Timings & values* lists every timing, easing, color and size the recreation declares, with a control for each; changing a timing replays the motion so the effect is visible straight away. *Elements* lets the user click any element in the recreation to nudge it, change its colors, add a border, round its corners, or change padding, size, type and opacity. Edits are saved alongside Claude's original, so they can be changed again or reverted at any time, and the saved recreation (and the prompt copied from it) includes them.
- Re-analyze replaces the recreation, and any edits to it, with a new one.
- "Refine" takes a text instruction ("the easing is snappier than that", "ignore the background") and re-runs analysis with the original capture, the current recreation and the instruction.
- Rename (name and title), add and remove tags, delete (to the Trash, so it can be restored). Aliases and duplicate come later.

### Add manually

- Images: drag image files into the library, paste an image, or use Import…. PNG, JPEG, WebP, GIF (first frame), HEIC, TIFF and BMP. Each is analyzed like a screenshot when there is an API key, and the original file is kept with it.
- Notes: New Note saves a guideline or a term of the user's own ("primary buttons are always pill shaped"), with no capture. Every asset also has a Notes box. AI tools connected to gil read both.
- Later: video, SVG, Lottie JSON and code snippets.

### Use in another tool

- **AI coding tools:** through the MCP server, connected from Settings (Claude Desktop with one button, Claude Code with a command and a skill). "Build the pricing cards using `soft-lift-card`" resolves to that asset's spec and code; a design system returns all its members at once.
- **Anywhere:** copy buttons for the code, the spec, or a ready-made prompt snippet that includes both.
- **By path:** each asset is a folder a tool or person can open directly.
- **Figma:** a plugin lists the library and inserts an asset. Later phase.

## What "recreate" means

The recreation is a faithful reference implementation, not a pixel clone and not production code. It should capture what makes the thing distinctive: proportions, color, type treatment, layering, and above all the feel of the motion. It uses placeholder text and neutral placeholder imagery rather than copying the source's content, logos or photos. Its job is to give a person or an AI tool something precise to build from.

gil should be honest about confidence. Motion inferred from sampled frames is an estimate; the spec says which values were measured and which were guessed, and the side-by-side view lets the user judge.

## Scope

### In scope for the first usable version

- macOS
- Shortcut, region selection, context field, recording
- Background analysis producing spec and recreation
- Library with search, naming, side-by-side review, refine
- Manual import
- Plain-file storage, copy buttons, MCP server
- Lenses, measured colours, notes, glossary, design systems
- The Chrome extension as a clipper: on web pages it also saves the exact font names, sizes and colours of what was clipped (values only, never the site's code or font files)

### Later

- A paid plan for AI usage. gil is free with the user's own API key; alternatively a user signs in and pays monthly to use gil's AI, with a usage cap. Sign-in exists only for that plan. The library stays on the user's Mac on both paths.
- Font identification from a crop: name the font, suggest similar free fonts, or redraw a wordmark as an outline
- Figma plugin
- Windows
- Collections, and export or sharing of a library
- Multi-state captures (explicitly recording default, hover and pressed as separate labelled states)
- Framework-specific output (React, SwiftUI) generated on request from the spec

### Not doing

- Cloud storage or sync of the library
- Full-page or whole-site cloning
- Scraping the DOM or source of the captured app; gil works from pixels, plus exact style values the Chrome extension reads on web pages (amended 2026-11-16)
- A built-in browser (removed 2026-11-16; all capture goes through the overlay)
- Editing video
- A design tool; assets are references, not editable canvases

## What good looks like

- From shortcut to recording in under a second, with no window switching.
- A captured hover effect, replayed beside its recreation, is recognisably the same effect.
- Typing an asset name in Claude Code produces output that visibly matches the asset without re-explaining it.
- The library folder makes sense to someone who has never opened the app.
