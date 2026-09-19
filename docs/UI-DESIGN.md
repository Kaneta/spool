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

    ↑ / ↓     move selection
    Enter     open selected record
    Esc       close search

Search is not a permanent pane.

### Preview

There is no permanent preview / record pane in the current layout.

1. Markdown preview of the current Composer, or
2. a selected saved record

are possible future presentation modes. Saved records remain read-only.
A separate-tab preview would receive Composer updates through
`BroadcastChannel`; it adds no storage behavior and edits nothing.
Until such a mode is implemented, opened records use the transitional
record view described in §3.

---

## 3. Normal layout

Layout state is:

    normal | focus

There is no rail open/close state, no third layout mode, and no viewport
width state in JS. Responsive behavior is CSS media query only, with one
breakpoint.

### Wide normal layout

At wide viewports the surplus horizontal space around the Composer is used
for two UI rails:

    ┌──────────────────┬──────────────────────────────────┬──────────────────┐
    │ spool            │ COMPOSE                          │ SEARCH           │
    │ records: 123     │                          [ ⛶ ]   │ PASTE AS NEW     │
    │ storage: ...     │ ┌──────────────────────────────┐ │ EXPORT ALL       │
    │                  │ │ textarea                     │ │                  │
    │                  │ └──────────────────────────────┘ │                  │
    │                  │ [ SAVE ]                         │                  │
    └──────────────────┴──────────────────────────────────┴──────────────────┘

- Left rail: spool title, record count, storage / app-shell state.
- Right rail: commands — `SEARCH`, `PASTE AS NEW` (primary), `EXPORT ALL`.
- The central Composer column has `max-width: ~52rem`. Even at 1920px the
  textarea is not stretched to full width; line width stays stable.
- `PASTE AS NEW` remains visually primary.
- Status is carried by the rails; the header is not stacked on top of the
  Composer (the Composer first line is not pushed down unnecessarily).

The breakpoint is a single value (implemented at 1281px): at or above is
wide, below is narrow. No multi-step breakpoints.

### Narrow normal layout

Below the breakpoint the rails are not squeezed: the left rail contents
become a top bar and the right rail contents become a command row:

    ┌──────────────────────────────────────────────┐
    │ spool  records: N  storage: ...              │
    ├──────────────────────────────────────────────┤
    │ COMPOSE                              [ ⛶ ]  │
    │ textarea                                     │
    │ [ SAVE ]                                     │
    └──────────────────────────────────────────────┘
    │ [ SEARCH ] [ PASTE AS NEW ] [ EXPORT ALL ]   │

The Composer keeps its max-width and shrinks naturally within the available
width on mobile.

### Record view (transitional)

There is no permanent Saved Record Preview pane. When a record is opened
(Search result click, Paste as New), the existing record view replaces the
Composer view; `BACK TO COMPOSE` returns to the Composer. This is the
Phase 3 transitional behavior; no permanent record pane is reintroduced.

### Focus mode

Focus state is `normal | focus` only, expressed on `body`. No URL state, no
persistence; reload starts in normal. The Browser Fullscreen API is not
used.

- Normal mode: a small fullscreen-style Focus button (inline SVG, not a
  text button, no icon library) sits at the top-right of the Composer text
  area, belonging to the text area like a chat code-block copy button.
  `aria-label: Enter focus mode`.
- Focus mode: rails, top bar, status / commands, Search and Record view UI
  are hidden. Only the same-width Composer (+ SAVE) remains centered.
  Focus removes peripheral UI; it never widens the prose.
- Exit: a `×` fixed at the top-right of the viewport (not the Composer
  corner), `aria-label: Exit focus mode`. The Normal Focus icon and the
  Focus × never share position or shape: Normal → Focus is a local action
  belonging to the text area; Focus → Normal is a global action ending the
  screen state. This asymmetry is canonical.
- Save remains usable in focus; draft, scroll position and caret are
  preserved (the textarea DOM is never rebuilt for a mode change).

### Principle

Wide screen: use surplus horizontal space for controls.
Narrow screen: move controls above/around content.
Focus: remove peripheral UI, do not widen prose.
---

## 4. Search overlay

Search is a temporary overlay over the normal layout.

Example:

    ┌─ SEARCH RECORDS ───────────────────────────────────────────────┐
    │ search text...                                    [ CLEAR ]   │
    ├───────────────────────────────────────────────────────────────┤
    │ 20260918-0932-空調設定変更.txt                               │
    │ 20260911-1540-東側空調.txt                                    │
    ├───────────────────────────────────────────────────────────────┤
    │ ↑↓ select   Enter open                          [ CLOSE ]     │
    └───────────────────────────────────────────────────────────────┘

Interaction:

- Open: `[ SEARCH ]` button only. The input autofocuses and is a plain text
  field: no terminal prompt, no `$`, no prompt placeholder.
- Query: plain typed text. `[ CLEAR ]` empties the query and restores the
  recent-records view while keeping the overlay open. It is disabled when the
  query is empty.
- Results: one filename per row, ellipsis truncated, never horizontal
  scrolling (vertical only). Result rows are not Tab stops.
- Selection: ArrowUp / ArrowDown; Enter opens the selected row; row
  click / tap opens.
- Close: `[ CLOSE ]`, backdrop click/tap, or Escape — all use the same close
  path. Clicks inside the search box do not close.
- Tab / Shift+Tab: restricted to input → `[ CLEAR ]` → `[ CLOSE ]` while the
  overlay is open (disabled CLEAR is skipped). Focus must not escape behind
  the overlay.
- The visible keyboard hint is `↑↓ select   Enter open` only; the `Esc close`
  hint is not shown.

When the query is empty, show recent records in the existing chronological
order. Each row shows the filename only; long names truncate with ellipsis.

Selecting a record closes Search and opens that record in the record view
(§3).
Record-pane semantics, including stale-read guards, are unchanged.

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

Mobile is the narrow layout of §3: top bar + one-column Composer + command
row, not a miniature desktop layout. Use one main view at a time.

Search remains an overlay.

### Mobile integration

- default view is the Composer
- `[ SEARCH ]` stays reachable in the command row
- a Search result closes the overlay and moves to the Record view
- `BACK TO COMPOSE` returns to the Composer
- the overlay spans the viewport width on mobile; it is not a separate screen
- Focus mode works on mobile: Focus button in the Composer corner, `×` at
  the viewport top-right, peripheral UI hidden, same Composer width

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

When a saved record is open in the record view:

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

## 13. Design stability

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