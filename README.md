# gil

Capture anything on screen as a named, reusable design reference. macOS, Electron.

What it is and how it is built: [docs/PRODUCT.md](docs/PRODUCT.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ASSET_FORMAT.md](docs/ASSET_FORMAT.md), [docs/ROADMAP.md](docs/ROADMAP.md).

## Install as an app

```bash
pnpm install
pnpm package
```

This builds `dist/mac-arm64/gil.app`. Drag it into Applications (or run `cp -R dist/mac-arm64/gil.app /Applications/`) and open it like any other app. It lives in the menu bar and keeps running with its window closed. It is signed ad hoc for this Mac only, with no Apple developer certificate.

As an app, gil asks macOS for Screen Recording and Documents access in its own name rather than through a terminal. Because each rebuild changes the ad hoc signature, macOS may ask again after you install a new build. If it is listed but captures fail, remove gil from System Settings → Privacy & Security → Screen & System Audio Recording, then add it again.

## Run from source

Needs Node 22 or newer and pnpm.

```bash
pnpm install
pnpm dev
```

gil lives in the menu bar (look for ✌️). Its window is the library. While the window is open gil also shows in ⌘Tab and the Dock (macOS does not allow one without the other); close it and gil is menu bar only again. The window opens at launch. Captures are saved to `~/Documents/gil/`.

- `Cmd+Shift+2` — start a capture, and stop a recording
- Drag over part of a window. gil outlines and names the window it will record, which is the frontmost one under the middle of your selection
- Optionally type what to look for, then **Screenshot** to save a still right away, or `Enter` / **Record** to record
- While it records you can interact with the window, or cover it, switch apps and keep working: gil records that window, not the screen. Switching tabs inside it does change what is recorded
- `Esc` — cancel while selecting
- Recording stops on the shortcut, a click on the timer, or after 10 seconds

## Analysis

To have Claude turn captures into a spec and a working recreation, open **Library → Settings** and paste your Anthropic API key (from console.anthropic.com). gil checks it, stores it encrypted on your Mac, and analyzes every new capture in the background. Older captures get an **Analyze** button. Analysis sends the capture's frames to Anthropic and is billed to your account. Click a capture to see the original and the recreation side by side, with **Replay**. Before saving, gil plays Claude's recreation, compares it frame by frame with the original and has Claude correct it (up to two rounds). If something is still off, type what to fix in **Refine**.

## Screen Recording permission

macOS will not let gil record until you allow it, and when running from source the permission does not belong to "gil":

1. Press `Cmd+Shift+2`. The library window explains what is missing. Click **Ask macOS for Access** if it is offered.
2. Open **System Settings → Privacy & Security → Screen & System Audio Recording**.
3. Turn on the entry for whatever started the app. From `pnpm dev` that is usually your terminal (Terminal, iTerm, Ghostty, VS Code…), and sometimes **Electron**. If both are listed, turn both on.
4. Quit gil (menu bar icon → Quit gil, or `Ctrl+C` in the terminal), fully quit and reopen the terminal if macOS asks you to, and run `pnpm dev` again. macOS only applies the permission to a freshly started app.

If a capture produces a clip of only your desktop wallpaper and menu bar, the permission is not in effect yet.

macOS may also ask from time to time whether to keep allowing the app to "bypass the system private window picker". That is expected: gil records windows directly so that it can use its own region selection.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
