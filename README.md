# Whiteboard

A shared online whiteboard (Miro-style). There is no login: anyone with a board link can edit it.

- Sticky notes, text, rectangles and ellipses, lines and arrows that attach to objects, a pen with an eraser, and pictures (paperclip button, Ctrl+V or drag & drop)
- Select, multi-select (Shift or drag a box), move, resize, recolour, bring to front or back, duplicate, copy and paste, and undo and redo
- Live collaboration: other people's changes, cursors and avatars appear within about 1 s
- Pan and zoom with the mouse wheel, trackpad, Space+drag or two-finger pinch on phones
- Each board is a URL `/?b=<id>`. Opening `/` creates a new board.

## Shortcuts

| Key | Action | Key | Action |
|---|---|---|---|
| V | select | Double-click | new sticky note / edit text |
| H / Space | pan | Enter | edit selected |
| N | sticky note | Esc | stop editing / deselect |
| T | text | Del | delete |
| R / O | rectangle / ellipse | Ctrl+D | duplicate |
| L / A | line / arrow | Ctrl+C/V/X | copy / paste / cut (also between boards) |
| P / E / I | pen / eraser / insert picture | Ctrl+Z / Ctrl+Y | undo / redo |
| + / − / Shift+1 | zoom / fit | Arrows | nudge |

## How it works

- `public/` is a static app in plain JS and SVG. It has no build step and no dependencies.
- `api/board.js` is one serverless function backed by Upstash Redis. Each request runs one atomic Lua script that
  writes the client's changes, records presence, and returns every object changed since the client's last sequence number.
  Clients poll about every 1 s when others are online and every 2.5 s otherwise, and pause polling when the tab is hidden.
- `api/image.js` stores pictures, which are shrunk in the browser to at most 1600 px and about 1 MB, under global keys `wb:img:<id>`. They are served with a one-year cache.
- Conflicts are resolved per object, and the last write wins. Boards expire one year after their last edit.
- Without a database, the app still works in **local-only** mode and saves to localStorage.

## Deploy

1. Push this repo to GitHub and import it in Vercel. The Framework preset is "Other", and `vercel.json` already sets everything.
2. In Vercel, open the project and go to **Storage → Create Database → Upstash for Redis** and connect it to the project. Then **Redeploy**.

Every push to `main` deploys to production.
