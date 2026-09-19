# Spool Web UI Design

Status: Canonical UI design for the current Spool Web.

This document defines the interaction model, layout, and visual language of
Spool Web.

The goal is not to imitate a terminal.
The goal is a durable Web UI inspired by TUI applications and wireframe tools:
clear structure, explicit commands, low decoration, and long-term stability.

---

## 1. Product model

Spool is an append-only plain-text store.

A record is:

- one plain text
- immutable after save
- appended chronologically
- read-only after creation

The editable area before saving is not a record.

The model is:

    mutable Composer
          |
          | Save
          v
    immutable Record

Spool is not a document editor and is not a synchronization application.

---

## 2. Primary operations

### Paste as New

`PASTE AS NEW` is the shortest capture path and the primary command.

Behavior:

    Clipboard plain text
          |
          v
    create new record immediately
          |
          v
    refresh records
          |
          v
    show saved record

There is no intermediate confirmation step.

If clipboard access fails, show a small error and leave the Composer unchanged.

Do not add a separate `Paste` button.

Users who want to inspect or modify clipboard text before saving can paste
normally into the Composer and use `SAVE`.

### Save

`SAVE` appends the current Composer contents as a new record.

The Composer remains mutable until Save.

Saving must never modify an existing record.

### Search

Search opens a temporary dmenu-like record finder.

Activation:

- `[ SEARCH ]` button only

No global keyboard shortcuts (no Ctrl+K / Cmd+K / `/`):
the Composer is an ordinary notepad and browser/OS shortcuts must not be taken
over. Keyboard handling below applies only while the Search overlay input has
focus.

Inside Search:

    ↑ / ↓     move selection (desktop: preview follows selection)
    Enter     open selected record in a separate read-only tab
    Esc       close search

Result row click / tap also opens the selected record in a separate tab.

Opening a record does not close Search: query, session data, selection, and
preview remain, and exploration continues after switching back.

Search is not a permanent pane.

### Preview

There is no permanent preview pane in the normal layout.

`OPEN PREVIEW` is a Composer-local command (next to `SAVE`) that opens a
dedicated same-origin Markdown Preview page
(`/markdown-preview.html?session=<session-id>`) in a separate browser tab.
It renders the CURRENT Composer text as read-only Markdown — it is not a
Saved Record view and adds no storage behavior or editing. The Composer stays
a mutable plain-text / Markdown source editor; the Preview is a derived
read-only rendering of the current Composer text only. There is no inline or
permanent preview pane in the Composer (no split editor, no third column).

- 1 Composer tab = 1 ephemeral session (`crypto.randomUUID`, not persisted;
  reload starts a new session). The BroadcastChannel name is
  `spool-markdown-preview:<session-id>`, so multiple Composer tabs never mix.
- Handshake: Preview sends `{ type: "ready" }`; Composer replies with
  `{ type: "source", text: <current textarea value> }`. Live updates follow
  every Composer textarea change (`input` events and programmatic changes
  such as the clear after Save). A Preview reload re-runs the same ready
  handshake, so it re-syncs regardless of load timing. No ordering protocol
  beyond channel order; Preview applies a light render debounce (~75 ms).
- The one Preview tab per Composer is reused via the window name; reopening
  focuses it instead of spawning duplicates.
- Renderer: `markdown-it` with `html: false` (raw HTML is escaped, never
  rendered) and its default link validation (`javascript:` etc. rejected).
  No sanitizer or highlighting dependency. No `unsafe-inline` / `unsafe-eval`
  / CDN additions: the production build (hashed JS/CSS) works under the
  existing CSP, and the Markdown Preview page is part of the offline shell
  (`sw.js`).
- Preview states: missing session query → "Preview session missing.";
  no BroadcastChannel → "Live preview unavailable."; empty source →
  "Nothing to preview.". Preview is read-only: no Save / Edit / Delete /
  Search / Export / Markdown source editing.

### Saved Record retrieval (transitional note)

While Search is open, the overlay itself becomes a temporary two-pane
workspace on desktop/tablet (results | read-only preview, §4). On mobile the
Search overlay stays single-column without a live preview pane; a result tap
or Enter opens the record page in a new tab.

---

## 3. Normal layout

There are two layout states:

    rail open | rail closed

expressed on `body` as `data-rail="open"` / `data-rail="closed"`. There is no
`focus` mode, no viewport width state in JS, and no ResizeObserver layout
state. Responsive behavior is CSS media query only, with one mobile-only
breakpoint (~720px).

### Desktop normal layout

    ┌────────────────┬──────────────────────────────────────────────┐
    │ SPOOL       [◀]│ COMPOSE                                      │
    │                │                                              │
    │ records: N     │ textarea                                     │
    │ storage: ...   │                                              │
    │ shell: ...     │                                              │
    │                │                                              │
    │ SEARCH         │                                              │
    │ PASTE AS NEW   │                                              │
    │ EXPORT ALL     │ [ SAVE ]                                     │
    └────────────────┴──────────────────────────────────────────────┘

- Left rail contains identity (`SPOOL`), status (record count, storage /
  shell), the commands `SEARCH`, `PASTE AS NEW` (primary), `EXPORT ALL`,
  export result, and the rail collapse control.
- There is no right rail, no top header, and no permanent footer.
- The Composer workspace is a flexible editor work area: `flex: 1;
  min-width: 0`. `max-width: 52rem` is NOT applied to the Composer; it uses
  the available workspace width. The Composer is a general text editor
  (memos, pastes, logs, Markdown source), not an A4 reading column.
- Composer and rail tops align; no extra header/footer height.
- The textarea uses the available height; long text scrolls inside the
  textarea (document does not grow with Composer content).
- `PASTE AS NEW` remains visually primary (reverse-video style).

### Rail collapse

The rail can be collapsed by the user (explicit action only; never
auto-collapsed because the viewport becomes narrower):

- rail open: collapse control (chevron-left, inline SVG,
  `aria-label: Collapse controls`) at the top of the rail.
- rail closed: the rail shrinks to a minimal strip (~2rem) that keeps only
  the reopen control (chevron-right, `aria-label: Expand controls`). The
  rail is never removed from the DOM; the reopen handle cannot be lost.
- Rail width is a narrow stable width (~12–14rem open).
- Width/wrapping of the Composer changes between open/closed on purpose:
  closing the rail widens the workspace. State is not persisted; reload
  starts open.

### Responsive

- Desktop / tablet: the rail remains visible regardless of width
  (1920, 1200, 960). The Composer shrinks naturally; no automatic top-bar
  conversion, no auto-collapse, no JS viewport handling.
- Actual mobile (~720px and below): the existing simple stacked layout
  (rail contents as top bar, commands as command row) is reused. No drawer
  framework, no hamburger menu, no new navigation system. Mobile does not
  need to share the desktop rail collapse state.

### Record view (transitional)

The transitional record view (in-tab `RECORD` section with `BACK TO COMPOSE`)
is reached only through `PASTE AS NEW`. Search results no longer use it: they
open the separate Saved Record page (§4, §10). The record view is kept
verbatim for Paste as New; the resulting asymmetry is transitional and will
be resolved in a later phase.

### Principle

Desktop/tablet: control rail | flexible Composer workspace.
Mobile: simple stacked layout.
Concentration = close the rail.
---

## 4. Search overlay

Search is a temporary overlay over the normal layout.

Example:

    ┌─ SEARCH RECORDS ────────────────────────────────────────────────┐
    │ search text...                                    [ CLEAR ]   │
    ├───────────────────────────────┬─────────────────────────────────┤
    │ 20260918-0932-空調設定変更.txt│ 20260918-0932-空調設定変更.txt  │
    │ 20260911-1540-東側空調.txt    │                                 │
    │                               │ stored plain text               │
    ├───────────────────────────────┴─────────────────────────────────┤
    │ ↑↓ select   Enter open                          [ CLOSE ]     │
    └─────────────────────────────────────────────────────────────────┘

While the overlay is open it is a temporary search workspace — not part of the
normal `rail | Composer` layout. Desktop/tablet (>= ~721px): results left,
read-only preview right. The overlay may widen on these viewports
(viewport-relative, e.g. `min(90vw, ...)`); it never exceeds the viewport and
closing it restores the normal geometry exactly. Mobile: the overlay stays
the current single-column results list; no preview pane at narrow widths.

Interaction:

- Open: `[ SEARCH ]` button only. The input autofocuses and is a plain text
  field: no terminal prompt, no `$`, no prompt placeholder.
- Query: plain typed text. `[ CLEAR ]` empties the query and restores the
  recent-records view while keeping the overlay open. It is disabled when the
  query is empty.
- Results: one filename per row, ellipsis truncated, never horizontal
  scrolling (vertical only). Result rows are not Tab stops.
- Selection: ArrowUp / ArrowDown. The selection is a browse/preview gesture:
  on desktop the preview pane (filename + saved text, read-only, internal
  vertical scroll) immediately shows the selected session record. Preview
  data comes from the existing in-memory Search session (getAll at open);
  no additional IndexedDB read happens per selection. Empty query = recent
  records, preview first result; 0 results = small empty state
  ("No matching record."); no hover preview.
- Open: Enter (selected row), or row click / tap — opens the Saved Record
  page in a separate browser tab (`record.html?name=<encoded-name>`,
  §10) directly from the user gesture (no `window.open` after `await`; no
  blob/data URL; only the record name is encoded into the URL). The original
  tab keeps Search open with query, filtered results, selection, preview, and
  Composer draft intact. Search no longer transitions to the in-tab record
  view; the transitional record view is reached only via Paste as New.
- Preview is a reading surface: it adds no Tab stops, no focus targets, and
  no Edit / Save / Delete / Rename / load-into-Composer commands.
- Close: `[ CLOSE ]`, backdrop click/tap, or Escape — all use the same close
  path, which discards the search session (query, cache, preview) as before.
  Clicks inside the search box do not close.
- Tab / Shift+Tab: restricted to input → `[ CLEAR ]` → `[ CLOSE ]` while the
  overlay is open (disabled CLEAR is skipped). Focus must not escape behind
  the overlay.
- The visible keyboard hint is `↑↓ select   Enter open` only; the `Esc close`
  hint is not shown.

When the query is empty, show recent records in the existing chronological
order. Each row shows the filename only; long names truncate with ellipsis.

Search should feel closer to dmenu / command palette behavior than to a
traditional search-results page.

---

## 5. Search matching

Initial search remains deliberately simple.

For both query and record text:

1. Unicode NFKC normalization
2. lowercase/case folding where applicable
3. split query on whitespace
4. every query token must occur as a substring

The searchable text of a record is its filename plus its body:

    record.name + "\n" + record.text

so both filenames and record contents are searchable.

Example:

    query:
      空調 設定

matches a record only if both:

    "空調"
    "設定"

occur in the searchable text.

No morphological analysis is required.

Do not add:

- MeCab
- reading conversion
- fuzzy edit distance
- embeddings
- semantic search
- external search service

These may be reconsidered only if simple substring search proves insufficient.

---

## 6. Mobile layout

Mobile reuses the simple stacked layout of §3 (rail contents as a top bar,
commands as a command row), not a miniature desktop layout. Use one main
view at a time.

Search remains an overlay.

### Mobile integration

- default view is the Composer
- `[ SEARCH ]` stays reachable in the command row
- a Search result opens the Saved Record page in a new tab; the overlay
  stays open and the Composer default view remains
- `BACK TO COMPOSE` returns to the Composer from the transitional record view
- the overlay spans the viewport width on mobile; it is not a separate screen
- no live Search preview pane on mobile (single-column results only)
- rail collapse is irrelevant on mobile: the stacked layout already is the
  minimal layout; the desktop `data-rail` state does not need to apply

The Phase 1 RECENT list is removed; the Search overlay (empty query = recent
records) is the single retrieval mechanism.

---

## 7. Visual language

The visual language is:

    TUI-inspired Web UI
    +
    wireframe-tool aesthetic

The interface should look intentionally simple, not unfinished.

### Typography

- prefer `ui-monospace` for interface and record-oriented text
- base size approximately 14–15 px
- use uppercase labels where they improve scanning
- no display font
- no decorative typography

### Geometry

- 1 px borders
- border radius: 0–2 px
- no shadows
- no gradients
- spacing scale based on 4 / 8 / 16 / 24 px
- rectangular controls
- strong alignment

### Color

Use very few colors.

Default:

- neutral background
- dark foreground
- subdued secondary text/border
- one optional accent
- restrained destructive color for Delete

Primary actions should not depend on fashionable accent colors.

`PASTE AS NEW` should be visually dominant using reverse-video style or another
high-contrast treatment.

Example:

    [ SAVE ]   [ OPEN PREVIEW ]        █ PASTE AS NEW █

### Controls

Prefer text labels over icons.

Avoid icon-only primary commands.

Commands should look clickable without requiring decorative card components.

---

## 8. Explicit visual prohibitions

Do not introduce:

- card-based dashboard layouts
- glassmorphism
- gradients
- large rounded corners
- floating action buttons
- hero sections
- decorative illustrations
- oversized empty marketing space
- fashionable component-library styling
- ornamental animation
- hand-drawn / sketch imitation
- fake terminal prompts used as decoration

The UI may be inspired by TUI applications without pretending to be a terminal.

---

## 9. Motion

Avoid decorative motion.

Allowed motion is limited to functional feedback such as:

- search overlay appearing/disappearing
- selection state
- save completion
- error feedback

Transitions should be short or absent.

---

## 10. Record display

Saved records are read-only.

### Saved Record page

A selected record can be opened in a separate browser tab:

    /record.html?name=<encoded-record-name>

Properties:

- read-only reading surface, not the Composer
- same-origin static page; it reads the record itself from IndexedDB
  (`spool` / `records`, keyPath `name`) by the record name in the URL
- filename header + saved plain text; text via `textContent` only, never
  HTML interpretation or Markdown rendering
- whitespace/newlines preserved (`white-space: pre-wrap`); very long single
  lines must not cause document horizontal overflow (`overflow-wrap`)
- constrained reading column (~52rem max-width, centered) — this width
  responsibility belongs to the record page only. The Composer stays the
  flexible editor workspace (§3); the 52rem cap is not restored there.
- minimal commands: `[ COPY ]` (exact saved text → clipboard)
- explicit small states: name missing / record not found / read failure
- no Edit, Save, Delete, Rename, Export All, Search, Paste as New

### In-tab record view (transitional)

After Paste as New, the saved record is shown in the in-tab record view:

    ┌─ RECORD ────────────────────────────────────┐
    │ 20260919-0945-example.txt                  │
    ├────────────────────────────────────────────┤
    │                                            │
    │ stored plain text                          │
    │                                            │
    ├────────────────────────────────────────────┤
    │ [ COPY ] [ EXPORT ] [ DELETE ]             │
    └────────────────────────────────────────────┘

Do not add Edit or Save-over-existing commands.

---

## 11. Composer behavior

The Composer is intentionally larger than the current prototype.

It should be comfortable for:

- quick capture
- short notes
- longer plain-text drafting
- Markdown drafting

It remains a volatile pre-save buffer.

For now:

- no draft autosave
- no document tabs
- no revision history
- no folders
- no rename operation

Reload may discard unsaved Composer text.

Draft persistence can be considered separately later.

---

## 12. Markdown preview

Markdown is a presentation mode for plain text.

Markdown does not change the storage format.

Stored data remains plain text.

The Markdown preview must not introduce:

- Markdown-specific record schema
- stored AST
- WYSIWYG editing
- preview-side editing
- save behavior different from normal plain text

The main-page preview and separate-tab preview should render the same Composer
contents.

---

## 13. Width responsibility

- Composer: flexible editor workspace, no reading-width cap (§3).
- Markdown Preview page: constrained reading column (~52rem); preview-only
  responsibility (§2).
- Saved Record page: constrained reading column (~52rem).
- Search overlay: temporary workspace; may widen on desktop/tablet while
  open (§4), normal layout is unaffected when closed.

## 14. Design stability

This UI is intended to remain recognizable for many years.

Prefer:

- browser standards
- plain CSS
- explicit HTML structure
- stable keyboard conventions
- minimal dependencies

over visual trends or framework-specific design systems.

When changing the UI, ask:

1. Does this make an existing operation clearer?
2. Does this reduce interaction cost?
3. Will the reason for this element still make sense in ten years?

If not, do not add it.