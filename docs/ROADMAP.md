# Roadmap

The plan of record since 2026-11-16 is the six stages below. Each stage has a gate. On 16 Nov the owner paused the accuracy work (stage 1) and asked for everything else to be built meanwhile, so stages 2 to 5 are built ahead of stage 1's gate; their live checks are still to do.

## Stages

1. **Nail recreation and analysis.** Paused 2026-11-16. Built: the benchmark and score (`pnpm bench`), the accuracy gate checks, measured motion, frames picked from measured motion, the pointer left out of recordings (untested) and of recreations, a warning when nothing moved, tokens and cost per asset. Open: per-element motion, keeping the recreation from before a Refine (ask first), about ten benchmark captures. Gate: on about ten real captures, from the first analysis with no Refine, every motion step within two frames, every still within 2 px, nothing missing, all motion values measured, and the owner judges each the same thing.
2. **Asset types and the MCP server.** Built: asset types in the format (asset.json 3, spec.json 2: text levels, layout regions, measured or estimated on every value), the local read-only MCP server with Connect in Settings and a Claude Code skill, the glossary, search and export. Gate: in a separate project, a prompt naming an asset produces output that visibly matches it, and names get used every week.
3. **Layout and colour lenses, and the Chrome extension.** Built: the lens picker and Another Lens…, the colour lens measured from pixels with a swatch page, the layout lens (prompt-driven), image import, notes, the Chrome extension wired up with exact page styles, the built-in browser removed. Gate: a clipped FAQ section comes back as the same structure, a page screenshot gives a palette that matches the screen, and a clip through the extension saves values that match the page.
4. **Type system and fonts.** Built: the type lens with a specimen built by gil. Built too: font identification against the Google Fonts catalogue, ranked by shape on the Mac (the model step is untested without API credit). Gate: a page with known styles gives the right number of levels, and the three-font test names the right font or closest match each time.
5. **Design systems and private beta.** Built: design systems as named bundles served in one MCP call. Open: release hardening (Developer ID, notarization, hardened runtime, fuses, privacy policy, ffmpeg licence check), 10–20 invited testers, the business model. Gate: testers still capturing after two weeks, and some say they'd pay.
6. **Grow (2027).** First public release, then what testers ask for: a Figma plugin, component mapping, a hosted MCP for web chat apps, Windows.

The phases below are the earlier plan, kept for its detail and history.

## Phase 1 — Capture to disk

Prove the capture mechanics, which are the part most likely to fight back.

- Scaffold: Electron, electron-vite, TypeScript, React, pnpm, lint, typecheck, test runner, git
- Menu bar app with a global shortcut
- Overlay with drag-to-select, context field, Record
- Recording with click-through, stop by shortcut or timer, max duration
- Crop with ffmpeg; write `asset.json`, `clip.mp4`, `poster.png` in the documented format with status `stored`
- Minimal library window: a grid of assets with poster, name, and clip playback
- Screen Recording permission flow
- Screenshots as well as recordings, from the overlay (and from gil's browser, removed 2026-11-16)

Done when: the user presses the shortcut, drags over a hover effect in a browser, triggers the hover while recording, stops, and sees a correctly cropped clip in the library and on disk, with no overlay artifacts in the clip.

## Phase 2 — Analysis

Prove motion fidelity before building anything around it.

- API key entry and secure storage
- Frame extraction, still detection, keyframe selection (pure, tested)
- Describe and recreate steps with zod-validated output
- Sandboxed recreation frame; side-by-side review with replay
- Background job queue, status, notification, failure handling
- Suggested name and tags

Done when: three real captures (a still component, a hover effect, a multi-element entrance animation) each produce a recreation the user recognises as the same thing.

Built during Phase 2 at the user's request (ahead of Phase 4): delete (to the Trash), rename, tags, the live editor for recreations, and the outputs panel with copy buttons.

## Phase 3 — Fidelity and refinement

- Verify-and-correct loop (built)
- Refine with a text instruction (built)
- Editable spec
- Per-asset token usage
- Accuracy score and benchmark runner, `pnpm bench` (built 2026-11-16)
- Version history for Refine: keep the recreation from before each Refine so it can be compared or restored. Today `base.html` equals `index.html` after a Refine, so the earlier version is lost. Gap found 2026-11-16; not started, ask before building.

Placed here on 2026-10-23 (all local-first, on the user's own API keys):

- **Animation analysis.** Measured timing, easing and stagger per motion segment is built (2026-11-16, see Measured motion in ARCHITECTURE.md); per-element tracking, the motion spec and the pattern library are not. Track elements across the recording's frames on the Mac to measure durations, easing and stagger, and save the result as an engine-neutral motion spec. Ship a curated local library of GSAP and Motion pattern snippets (fade-up, stagger, spring, parallax…) and give Claude the closest matches as context.
- **Recreation output.** HTML + GSAP is the default (previews with no build step); React + Motion is the alternative. A "default output" setting picks between them and a request can override it. The other format is generated only on demand from the same analysis ("Get React version" / "Get HTML version").
- **Icons.** Iconify (free, can be self-hosted): recreations use real icons from it instead of drawn approximations.
- **UI components.** shadcn/ui and Magic UI, pulled by name from their registries, with Radix and Headless UI as unstyled bases: recreations map captured elements to real components where they fit.
- **Lottie animations.** For captures of pre-made vector animations (animated illustrations, characters, complex loaders) that GSAP or Motion can only roughly imitate, find a matching or similar free animation through the LottieFiles API and play it with lottie-web. Recreations allow no external requests, so the animation JSON and the player are inlined into the recreation. GSAP and Motion stay the engines for UI motion.
- **Layout references.** Mobbin, Awwwards and Land-book, used only to recognize which known pattern a capture shows. gil stays a capture and recreation tool: no browsing or inspiration feed. Mobbin is an optional connection (through its MCP server) for users with their own account; Awwwards and Land-book have no API, so they are reference links or sites the user captures from. Assets are never copied from any of them.

## Phase 3.5 — Type

Reuses the self-check renderer to render candidate fonts and compare them with the capture.

- **Font identification.** Claude describes the type's traits; gil renders candidate fonts with the same text and ranks them by visual similarity to the capture. Candidates come from a local index of Google Fonts, Fontsource, Fontshare, Font Squirrel and indie foundries (Velvetyne, Collletttivo, Open Foundry, Use & Modify, The League of Moveable Type), refreshed now and then. The user's installed fonts are not used. For paid fonts, name the likely font and the closest free match.
- **Font recreation.** SVG outlines for a captured word or logo; otherwise the closest match tuned for weight, spacing and variable axes. Rebuilding a whole typeface is out of scope.

Done when: for three captures of text (a popular font, a niche free font, a paid font), gil names the font or its closest free match correctly.

## Phase 4 — Library

- Aliases, search, duplicate (rename, tags and delete are built)
- Manual import by drag and drop and by button
- File watcher for outside edits
- Settings: shortcut, library location, max duration, frame budget

## Phase 5 — Use it elsewhere

- MCP server with the four tools, and the registration command shown in settings (built 2026-11-16: also a Claude Desktop Connect button, a Claude Code skill and an `asset` prompt)
- Copy prompt snippet, code and spec (built in the review screen); reveal in Finder
- Connect gil to the user's chat models (Claude, ChatGPT, Gemini) so they can reference assets by name in prompts and projects
- Explore an `/asset <name>` command
- Parked ideas: `/font` and `/animation` skills, thin layers over Phase 3's animation analysis and Phase 3.5's font identification, on the same MCP server

Exploration, to be confirmed against each product's current docs when this phase starts:

- **Local MCP server first.** A stdio server reading the library folder works with desktop and command-line tools that run MCP servers on the user's Mac: Claude Desktop, Claude Code, and other MCP clients such as Gemini CLI. Nothing leaves the machine except what the user's own chat model is given.
- **`/asset <name>`.** MCP servers can also offer *prompts*, which some clients show as slash commands (Claude Code lists them as `/mcp__gil__…`). An `asset` prompt taking a name would insert that asset's spec and code into the conversation. For Claude Code, a gil *skill* can teach the model to look assets up whenever a name appears, and a plain `/asset` custom command can wrap the MCP call. Both are thin layers over the same server.
- **Web chat apps need a reachable endpoint.** claude.ai, ChatGPT and Gemini in the browser cannot reach a server on the user's Mac. They connect to remote MCP servers (custom connectors) over HTTPS, so this needs a hosted endpoint: the paid plan's server (see Later) could serve, read-only and per account, the specs and code the user chooses to publish, never captures. That is a deliberate exception to local-only and needs the user's opt-in per asset.
- **A small HTTP API** behind the same tools would let other apps and scripts fetch assets the same way; the Figma bridge (Phase 6) is a first client.

Done when: in a separate Claude Code project, a prompt that names an asset produces output that visibly matches it.

## Phase 6 — Figma

- Local bridge server
- Plugin: list, insert reference frame, create styles from tokens
- Scope editable-layer conversion as its own piece of work

## Before public release

Needed before gil is offered to anyone beyond invited testers, whichever comes first: a public download or the paid plan. Added 2026-10-27.

- **Apple Developer ID.** Enrolled in the Apple Developer Program, with releases signed and notarized and automatic updates switched on (see Publishing in ARCHITECTURE.md). In progress: waiting on enrollment.
- **Privacy policy and terms**, covering the EU and UK (GDPR, UK GDPR), the US (California's CCPA/CPRA) and Canada (PIPEDA). As long as gil stays local it collects nothing itself: captures stay on the user's Mac and frames go to Anthropic under the user's own key, which the policy says plainly. The paid plan adds sign-in email, usage and billing data, so the policy is updated before that launches.
- **Payment provider: Paddle by default**, for the paid plan. As seller of record it collects and remits EU VAT and US sales tax, which suits a one-person business selling worldwide. Stripe (with Stripe Tax) remains the alternative.

## Later

- **Not chosen:** Unsplash and Pexels, illustration libraries, the Figma API.
- **Dropped:** keyword recognition (Claude picks the right tool itself; a typed keyword match misfires).

- Paid AI plan: gil stays free with the user's own API key ("Have your own key?"). Users who would rather not get a key can sign in and pay a monthly fee to use gil's AI with a usage cap. Needs sign-in, a small server that holds gil's key and forwards analysis requests, a payment provider (such as Stripe or Paddle) so gil never stores card details, and per-account usage limits. The subscription covers AI usage only: captures, specs and recreations stay on the user's Mac on both paths, and there is no cloud storage.
  - Stack: Supabase for email-link sign-in and one small table per user (email, plan status, usage this month), and a Supabase edge function as the proxy. It holds gil's Anthropic key, checks the user's plan and usage, and forwards frames to the API without storing them. Billing through Paddle (or Stripe; see Before public release), with plan status updated from their webhooks; no card data is stored by gil.
  - Before launch: the privacy policy updated for accounts and billing (see Before public release); a price set from the per-analysis cost measured in Phase 2; confirm Anthropic's commercial terms allow offering its models inside a paid product this way.
- Chrome extension: screenshot or record part of a tab in the background, sent to the app over a local capture bridge. Wired up on 2026-11-16 with exact page styles (see ARCHITECTURE.md); untested in Chrome.
- Windows support, including Windows code signing (Microsoft's Azure Trusted Signing or a code-signing certificate) and a Windows build in the release workflow. A sizeable port: capture relies on macOS-only parts.

Collections, sharing, multi-state captures, framework-specific output.
