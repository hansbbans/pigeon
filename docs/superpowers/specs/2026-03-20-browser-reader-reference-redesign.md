# Browser Reader Reference Redesign

Date: 2026-03-20

## Goal

Redesign the existing browser reader at `/app` so it feels much closer to the provided Feedbin reference while staying honest about Pigeon's real feature set.

This is a visual redesign, not a product expansion. The browser reader should keep the same read-only behavior, auth flow, routes, and data model that already exist. The work should improve layout, hierarchy, spacing, chrome, and reading presentation without introducing fake functionality.

## Design Target

The target is a close homage to the reference image:

- crisp three-pane desktop layout
- tighter, more product-like app chrome
- calmer, wider reading pane
- cleaner separation between navigation, article stream, and reader
- more polished reader typography and spacing

Pigeon should still feel like its own app in naming and content, but the visual direction should clearly lean toward that reference rather than the current warm, rustic shell.

The reference image from this conversation is the visual calibration point for implementation review.

## What Stays The Same

The redesign does not change:

- password-based login via the existing app password
- private reader entry point at `/app`
- status data loaded from `/app/status`
- read-only browser behavior
- feed/article loading logic
- iframe isolation for full article HTML
- existing route structure and API reuse

No schema change is required.

## Product Constraints

The redesigned UI should stay honest to current functionality:

- the left sidebar should show real views and real feeds only
- the toolbar may visually resemble the reference, but only supported controls should be fully active
- unsupported actions may appear as subdued, non-primary controls if needed for visual balance, but they must not look like core working actions

The implementation should also leave a clear path for future interaction features.

## Layout Direction

### Desktop

Use a three-pane layout that is noticeably closer to the reference than the current build:

1. narrow left navigation rail
2. stronger middle stream column
3. wider right reading pane

Target feel:

- less oversized outer padding
- thinner, cleaner dividers between panes
- less floating-card framing around the entire app
- more “desktop product” and less “single-page document”

The pane proportions should prioritize the reading pane while still letting the article stream breathe. The middle column should feel like a real stream, not a cramped utility list.

### Mobile

Mobile should preserve the same design language, but not literally shrink the desktop layout. It should stack or simplify into a usable narrow-screen reading flow.

The mobile version should:

- keep the cleaner product chrome
- simplify toolbar density
- preserve readable article typography
- avoid squeezing three desktop panes into a cramped narrow layout

## Visual System

Shift the app away from the current warm paper palette and toward a cooler, sharper product UI.

### Color

Use:

- cool whites and near-whites for surfaces
- soft gray dividers
- dark neutral text
- a stronger blue selection state in the stream column

Avoid:

- decorative parchment-like gradients
- heavy warm beige tones
- soft “editorial paper” framing for the whole app

The selected article state in the middle column should be the strongest accent in the interface, similar to the reference.

### Chrome

Introduce a tighter product shell:

- browser-style top bar
- cleaner app header
- sharper pane seams
- lighter toolbar treatment
- less oversized rounding on outer surfaces

The result should feel more like a polished feed-reading product than a stylized static page.

## Left Sidebar

Keep the sidebar honest to Pigeon’s actual data, but present it more like the reference.

The sidebar should contain:

- current real views such as `All items` and `Unread`
- the real feed list
- counts where they already exist

The redesign should improve:

- hierarchy between global views and feeds
- spacing and scanability
- compactness without crowding
- clearer active-state treatment

The redesign should not invent fake sections just to mimic the reference.

## Middle Stream

The middle column should move much closer to the reference’s article-stream feel.

### Card Treatment

Articles should feel like stream cards rather than plain stacked buttons.

Show:

- title
- feed/source name
- preview text
- timestamp

Where content allows it, make the stream more image-forward.

### Image Handling

If a loaded article includes a suitable image or hero-like content, the card may present that image prominently. If it does not, the card should fall back to a deliberate text-first card rather than looking broken or empty.

This redesign should rely on article data that is already available to the current browser reader. It should not expand scope into new image extraction or content-processing work.

The stream should still look coherent when many items are text-only.

### Selected State

The selected item should get a strong highlighted state similar to the reference:

- blue selection surface
- inverted or softened text treatment inside the selected card
- clear distinction from surrounding cards

## Reading Pane

The reading pane is one of the top priorities for the redesign.

It should become more typographic, calmer, and more reference-like.

### Reader Header

Separate app-level metadata from article content more clearly.

Show the article area with:

- a lighter toolbar row
- stronger article title treatment
- quieter feed and timestamp metadata
- more disciplined spacing between header and content

### Reader Body

The iframe remains required for HTML isolation, but the surrounding pane should make the reading experience feel more integrated and polished.

The pane should improve:

- reading width and margins
- spacing around hero media
- title hierarchy
- visual quietness around the embedded article

The redesign should make the iframe feel like part of a product reading surface, not like a generic embedded box dropped into the page.

## Toolbar Behavior

The redesigned top and reader chrome may include a toolbar row closer to the reference, but controls must be split into two categories.

### Supported Real Controls

These can remain fully active if they already exist in the current reader:

- selecting views
- selecting articles
- opening settings
- logging out

If mobile navigation affordances are needed, only add a real navigation control where the current app can actually support it cleanly.

### Presentational Future Controls

Buttons that visually suggest reference-like capabilities are optional. If used, they may appear only if they are clearly secondary and non-misleading.

They should not be styled as high-confidence primary actions unless they actually work.

## Follow-Up Actions Worth Adding

The redesign should include notes for future behavior work that matches the reference more closely.

The highest-value follow-ups are:

1. mark read / unread from the browser UI
2. star / unstar from the browser UI
3. better mobile back behavior between stream and reader
4. richer article actions from the reader toolbar

These are follow-up product features, not part of this redesign implementation.

Implementation notes should explicitly record which toolbar controls are visual-only today and which follow-up actions are recommended next.

## Scope Boundaries

This redesign should not:

- change the auth model
- add write APIs
- change the database
- add feed management features
- add fake working controls
- rewrite article HTML before iframe rendering

Keep the work focused on layout, styling, and presentation polish only.

## Implementation Shape

The redesign should mostly live inside the existing browser reader shell and client rendering code.

Expected files to change:

- `src/browser-app.ts`
- `src/browser-app-client.ts` only if light presentation helpers are useful
- existing browser reader tests

The redesign should preserve the current architecture rather than introducing a framework, build step, or new frontend subsystem.

## Testing And Verification

Keep the existing browser reader behavior tests in place and extend them only where needed for layout or shell-contract changes.

Verification should include:

- existing automated test suite
- TypeScript check
- real browser check on desktop width
- real browser check on narrow mobile width

Manual verification should confirm:

- login screen still works
- feed list still loads
- article stream still loads
- selected article still renders in the reader
- settings still opens and shows status
- desktop shell feels substantially closer to the reference
- mobile still remains usable

## Success Criteria

This redesign is successful if:

- the browser reader feels clearly closer to the provided reference than the current implementation
- the three-pane desktop layout has better proportions and cleaner chrome
- the reading pane feels more polished and intentional
- the sidebar remains honest to real Pigeon functionality
- no current reader behavior regresses
- the app still reads as a real product rather than a stylized document shell
