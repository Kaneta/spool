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

- `[ SEARCH ]`
- `Ctrl+K` on Windows/Linux
- `Cmd+K` on macOS

Do not use `/` as a shortcut because `/` is valid Composer input.

Inside Search:

    ↑ / ↓     move selection
    Enter     open selected record
    Esc       close search

Search is not a permanent pane.

### Preview

The right pane shows either:

1. Markdown preview of the current Composer, or
2. a selected saved record.

Saved records remain read-only.

An optional `OPEN PREVIEW` command may open the Markdown preview in a separate
browser tab.

The separate preview receives Composer updates through `BroadcastChannel`.

The preview is derived state only.
It does not save or edit records.

---

## 3. Desktop layout

Desktop uses two primary panes.

    ┌──────────────────────────────────────────────────────────────────────┐
    │ Spool                                  [ SEARCH ] [ PASTE AS NEW ]   │
    ├──────────────────────────────────┬───────────────────────────────────┤
    │ COMPOSE                          │ PREVIEW / RECORD                  │
    │                                  │                                   │
    │ ┌──────────────────────────────┐ │ # Markdown preview               │
    │ │                              │ │                                   │
    │ │ plain text / markdown        │ │ or                                │
    │ │                              │ │                                   │
    │ │                              │ │ selected saved record            │
    │ │                              │ │                                   │
    │ │                              │ │                                   │
    │ └──────────────────────────────┘ │                                   │
    │                                  │                                   │
    ├──────────────────────────────────┼───────────────────────────────────┤
    │ [ SAVE ]   [ OPEN PREVIEW ↗ ]    │ [ COPY ] [ EXPORT ] [ DELETE ]   │
    └──────────────────────────────────┴───────────────────────────────────┘
      records: 128              storage: persistent

The Composer should be large enough to work as a simple Web notepad.

Do not reserve a permanent pane for the record list.

Past records are retrieved through Search.

Phase 1 transitional note: until Search exists, a compact recent list lives
at the bottom of the right pane. It is a placeholder and will be replaced by
the Search overlay in Phase 2. Do not invest further in it.

---

## 4. Search overlay

Search is a temporary overlay over the normal two-pane layout.

Example:

    ┌─ SEARCH RECORDS ───────────────────────────────────────────────┐
    │ > 空調 設定                                                   │
    ├───────────────────────────────────────────────────────────────┤
    │ 20260918-0932-空調設定変更.txt                                │
    │ 明日の講義室について……                                       │
    ├───────────────────────────────────────────────────────────────┤
    │ 20260911-1540-東側空調.txt                                    │
    │ 東側ラウンジは……                                             │
    └───────────────────────────────────────────────────────────────┘
      ↑↓ select        Enter open        Esc close

When the query is empty, show recent records.

Selecting a record closes Search and opens that record in the right pane.

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

Mobile is not a miniature two-column desktop layout.

Use one main view at a time.

Default:

    ┌─────────────────────────────┐
    │ Spool                       │
    │ [ SEARCH ] [ PASTE AS NEW ] │
    ├─────────────────────────────┤
    │ COMPOSE                     │
    │                             │
    │ ┌─────────────────────────┐ │
    │ │                         │ │
    │ │ plain text / markdown   │ │
    │ │                         │ │
    │ │                         │ │
    │ └─────────────────────────┘ │
    │                             │
    │ [ SAVE ] [ PREVIEW ]        │
    └─────────────────────────────┘

Preview / selected record replaces the Composer view rather than being squeezed
beside it.

Search remains an overlay.

### Phase 1 transitional behavior

Until the Phase 2 Search overlay exists:

- mobile still shows one primary content view at a time
- the Composer view carries a compact RECENT navigation list below it
- selecting a RECENT item moves to the Record view
- `BACK TO COMPOSE` returns to the Composer view with RECENT still reachable
- PASTE AS NEW also enters the Record view directly

RECENT is a navigation mechanism only, not a third pane. It is replaced by the
Search overlay in Phase 2 and must not grow into a record browser.

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

When a saved record is open in the right pane:

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