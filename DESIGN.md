---
name: skyback
description: A flat, light-and-dark search page for one person's Bluesky archive, with a blue band and a search card, built so a query can be refined again and again.
colors:
  signal-blue: "#1083fe"
  signal-blue-dark: "#4aa3ff"
  band-blue: "#0a6ddf"
  band-blue-dark: "#0b3d7a"
  signal-blue-ink: "#ffffff"
  signal-blue-ink-dark: "#06121f"
  paper: "#eef4fb"
  paper-dark: "#0e1116"
  card: "#ffffff"
  card-dark: "#161b22"
  ink: "#15181c"
  ink-dark: "#e8edf2"
  muted: "#5f6b7a"
  muted-dark: "#93a1b0"
  hairline: "#d6e3f3"
  hairline-dark: "#262e38"
  highlight: "#fff1a8"
  highlight-dark: "#5b4a00"
  highlight-ink: "#15181c"
  highlight-ink-dark: "#fff6cc"
  caution: "#9a5b00"
  caution-dark: "#ffcc80"
  caution-wash: "#fff4e0"
  caution-wash-dark: "#2b2112"
  error: "#b42318"
  error-dark: "#ff8a80"
typography:
  display:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.45
    letterSpacing: "-0.02em"
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.45
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  search:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  meta:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  sm: "6px"
  md: "10px"
  lg: "16px"
  xl: "18px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "14px"
  xl: "20px"
components:
  wordmark-tab:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    typography: "{typography.display}"
    rounded: "14px"
    padding: "2px 14px 4px"
  search-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    typography: "{typography.search}"
    rounded: "{rounded.xl}"
    padding: "14px"
  button:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: "32px"
    padding: "0 12px"
  button-accent:
    backgroundColor: "transparent"
    textColor: "{colors.signal-blue}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: "32px"
    padding: "0 12px"
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "{colors.signal-blue-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: "32px"
    padding: "0 12px"
  chip:
    backgroundColor: "{colors.card}"
    textColor: "{colors.muted}"
    typography: "{typography.meta}"
    rounded: "{rounded.pill}"
    height: "28px"
    padding: "0 12px"
  post-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "14px"
  notice:
    backgroundColor: "{colors.caution-wash}"
    textColor: "{colors.caution}"
    rounded: "{rounded.lg}"
    padding: "10px 14px"
---

# Design System: skyback

## Overview

**Creative North Star: "The Narrowing Search"**

skyback is used in loops. A half-remembered word goes in, a pile of posts comes back, and the next move is to refine: add a word, quote a phrase, swap a guess for another, filter to a feed or a week. A common word can return hundreds of posts, so the system is built for the second and third query as much as the first. The search box is always at the top of the page, stays put, and holds its text; the filters sit directly beneath it; the results, with the matched words marked, sit directly below that. Nothing else competes.

The surface is flat and bordered. A solid blue band across the top carries the wordmark and status; the search box and its filters sit in one white card that overlaps the band's lower edge, so the query is the first thing the eye lands on. Below it, a pale sky-tinted page (or near-black in dark mode) holds white cards separated by hairlines, in system type, with one blue used for the things you can act on. Posts are the content and the interface steps back. The look is deliberately close to Bluesky's own, since the archive is of Bluesky, but it is a tool for one person, not a feed to scroll for pleasure.

The same page serves two audiences. The owner sees the working controls (status, Sync now, Feeds, Search further back); a stranger on `/demo` sees the same layout with sample posts and a plain note about what it is. The two share one visual language so the demo is an honest picture of the real thing.

**Key Characteristics:**
- Search first: the query sits in a card that overlaps the blue band, with filters one line below.
- The wordmark rides on a white tab: dark "sky", Signal Blue "back".
- Flat everywhere: borders, never shadows.
- One accent, used only on things you can act on or that have focus.
- Matched words are always visibly marked in results.
- Pill-shaped small controls, softly rounded larger containers.
- Light and dark follow the system, with matching structure in both.
- Phone width is the primary constraint; the 720px column simply stays narrow on desktop.

## Colors

A cool, desaturated neutral set with one Bluesky blue. All colors are CSS custom properties on `:root`, redefined under `prefers-color-scheme: dark`. Light values are listed first; the `-dark` tokens in the frontmatter are their dark counterparts.

### Primary
- **Bluesky Signal Blue** (#1083fe light, #4aa3ff dark): links, the focus ring, the primary and accent buttons, the progress bar and the filled state of feed checkboxes. It is a signal for what can be acted on, not a decoration. Text on a filled signal-blue button is white in light mode and a near-black blue (#06121f) in dark.

### Neutral
- **Sky Paper** (#eef4fb light, #0e1116 dark): the page background, a faint blue tint in light mode.
- **Card White** (#ffffff light, #161b22 dark): cards, inputs, buttons, chips and the feeds panel.
- **Ink** (#15181c light, #e8edf2 dark): primary text.
- **Quiet Slate** (#5f6b7a light, #93a1b0 dark): secondary text, timestamps, handles, hints, the status line and footer.
- **Hairline** (#d6e3f3 light, #262e38 dark): every border and divider, and the placeholder fill behind avatars and thumbnails.

### Band
- **Band Blue** (#0a6ddf light, #0b3d7a dark): the full-width band behind the wordmark, status line and demo note. Slightly deeper than Signal Blue so 13px white text keeps at least 4.5:1 contrast. Text on it is white; the status and Sync buttons are white-outlined with a faint white fill.

### Functional
- **Match Highlighter** (#fff1a8 on #15181c light, #5b4a00 on #fff6cc dark): marks the words a post matched. This is the one warm color on the page and is reserved for matches.
- **Caution Amber** (#9a5b00 on #fff4e0 light, #ffcc80 on #2b2112 dark): notices and the "search further back" prompt.
- **Error Red** (#b42318 light, #ff8a80 dark): failed feed fetches and hard errors.
- **Signal wash**: signal blue mixed 12% into the card color (`color-mix`), for the backfill banner, the demo note and the demo pill hover.

### Named Rules
**The One Signal Rule.** Signal blue marks what you can act on or what has focus, plus the "back" of the wordmark. The only other blue is the band and the 12% wash.

**The Matches Are Yellow Rule.** The highlighter is the only warm, saturated mark in the interface. Nothing else uses it, so a yellow word always means "this is why this post matched."

## Typography

**Display, Body and Label Font:** the platform system sans (`system-ui, -apple-system, "Segoe UI", sans-serif`). No web fonts are loaded, which keeps the page fast and native on every device.

**Character:** plain, readable and unbranded. The only typographic gesture is the wordmark, set in bold with a tight negative tracking and the second half ("back") in signal blue.

### Hierarchy
- **Wordmark** (700, 26px, -0.02em tracking): "sky" in ink, "back" in signal blue, on a white tab (card color, 14px radius) so the original colors read against the band.
- **Search input** (400, 20px; placeholder 16px): larger than body so the box reads as the main control and avoids iOS zoom.
- **Body** (400, 16px, 1.45): post text, preserving line breaks and breaking long strings.
- **Title** (600, 15 to 16px): author names, link card titles, feed names, panel headings.
- **Secondary** (400, 14px, Quiet Slate): handles, extra text under a post, link card descriptions, hints and tips.
- **Label** (400 or 600, 13px): select and button text, timestamps, the status line, footer.
- **Meta** (12px): chips, compact status buttons, the demo pill.

### Named Rules
**The Post Is The Biggest Thing Rule.** Post text is body size (16px) and in full-strength ink. Everything about a post (who, when, which feed) is smaller and muted, so the words you are hunting for are always the most prominent thing in a card.

## Layout

A single centered column, max width 720px, with 16px side padding and 80px bottom padding. A full-width blue band sits above it holding the header, the status line (owner only) and the demo note; the search card overlaps the band by about 52px. Vertical order, top to bottom: band (wordmark tab, tagline, status), search card (query line, filters, tips), optional banners and the feeds panel, result summary, result cards, More, footer.

Rhythm is tight and small: gaps of 6, 8, 10 and 14px inside components, 10px between cards, 14 to 18px between larger groups. The filter row wraps; a flexible spacer pushes the Feeds and Search further back buttons to the right edge when there is room. Result cards stack with no multi-column layout, at every width.

At 520px and below the header drops its right-hand clearance and takes a 44px top margin so it clears the fixed demo pill and the sign-in badge. Avatars, thumbnails and the header share the single column; image thumbnails scroll horizontally inside their card rather than wrapping.

### Named Rules
**The Search Stays Put Rule.** The search card and its filters are the stable top of the page. Refining a query must never move them, collapse them, or clear what was typed.

## Elevation & Depth

Flat. There are no shadows anywhere. Depth comes from tone and hairlines: cards are one step lighter than the page background (white on sky paper, a lifted dark on near-black) and are outlined with a 1px hairline. The search card overlapping the band is the one deliberate layering, done with overlap and not with a shadow. The fixed demo pill sits above content with the same border and no shadow.

### Named Rules
**The Hairlines Not Shadows Rule.** Separate surfaces with a 1px hairline and a tonal step. Never add a shadow or a blur.

## Shapes

Two families. Small interactive controls (buttons, selects, chips, the demo pill) are full pills (999px). Containers (post cards, the feeds panel, banners and notices) use a 16px radius; the search card is 18px and the wordmark tab 14px. Nested content inside a card (link cards, quoted posts) uses 10px, thumbnails and feed icons 8px, inline code 6px, and the highlight mark 3px. Author avatars are circles. Borders are always 1px.

## Components

### Search card
- **Style:** one white card, 18px radius, 1px hairline, 14px padding, overlapping the band. Inside: the query field (20px, no border of its own, a hairline under it), then the filter row and tips.
- **Focus:** a 2px signal-blue outline offset 2px on the whole card while the query field has focus.
- **Placeholder:** 16px, names the syntax by example (words, "a phrase", from:someone); it is clipped on the narrowest phones.

### Wordmark tab
- **Style:** a card-colored tab (14px radius) on the band holding "sky" in ink and "back" in signal blue.

### Buttons
- **Shape:** 32px tall pills, 13px text, 12px side padding, hairline border on a card-colored fill.
- **Default:** card background, ink text.
- **Accent:** transparent with a signal-blue border and text, 600 weight; used for "Search further back".
- **Primary:** filled signal blue with the on-accent ink, 600 weight, no border.
- **Compact:** status-line buttons are 26px and chips 28px; backfill actions are 28px.
- **Focus:** a 2px ring in signal blue at 45% opacity, offset 1px.
- **Disabled:** 60% opacity, default cursor.

### Selects
- **Style:** the same pill as buttons with a small chevron drawn inline at the right and 26px right padding; the label ("Feed", "When", "Order") sits before the select in muted 12px type.

### Chips
- **Style:** 28px muted pills used for example searches on the demo; the same border and fill as buttons.

### Post card
- **Structure:** an optional muted "seen in" line, then author (36px circular avatar, bold name, muted handle, timestamp pushed right), the post text, optional alt text or extra in muted 14px, thumbnails, link card, quoted post, and a footer row with an "Open" style link in signal blue at the right.
- **Style:** card fill, 1px hairline, 16px radius, 14px padding, 10px gap to the next card.
- **Matches:** query words are wrapped in the highlighter mark.
- **Long text:** names and handles truncate with an ellipsis; post text wraps anywhere so long URLs never overflow.

### Link card and quoted post
- **Style:** a bordered block inside the card, 10px radius, 10px by 12px padding; title in 600 weight, description and address in muted 14px.

### Banners and notices
- **Backfill banner:** signal wash, 16px radius, with a 4px progress bar (card-colored track, signal fill) and a row of small action buttons.
- **Prompt variant:** the same banner in caution amber when it is asking the owner to do something.
- **Notice:** caution amber on its wash; the error variant switches the text to error red.
- **Demo note:** translucent white on the band, white 14px text and links.

### Feeds panel
- **Style:** a card-like panel with a heading, a hint, and one row per feed: a checkbox (signal-blue accent), a 32px rounded icon, name with muted meta, and status. Rows separate with hairlines.

### Navigation
There is no navigation bar. The fixed top-left demo pill (a two-part pill reading "demo" and a signal-blue "login" link, hairline border, card fill) is the only global chrome; owner controls live in the status line and filter row.

## Do's and Don'ts

### Do:
- **Do** keep the search card directly under the band, unchanged, as the query is refined.
- **Do** mark every matched word in results with the highlighter.
- **Do** use hairlines and tonal steps to separate surfaces.
- **Do** define every color as a custom property with a dark counterpart, and keep the two modes structurally identical.
- **Do** keep controls at least 26px tall, and prefer 32px for anything the owner taps on a phone.
- **Do** build post content with `textContent`; highlights arrive as markers and become `<mark>` nodes.
- **Do** keep owner controls and demo content strictly separated in markup (the owner and demo blocks).

### Don't:
- **Don't** add shadows, blurs, gradients or glass effects.
- **Don't** use signal blue for decoration beyond the wordmark, or yellow for anything but a match.
- **Don't** load web fonts or icon fonts.
- **Don't** put owner-only controls (Sync, Feeds, Search further back, status) in the demo markup.
- **Don't** make the interface louder than the posts it contains.
- **Don't** reflow or clear the search input when results update.
