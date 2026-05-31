# Architecture notes

This document is for you (Nathan) — a tour of how the pieces fit together, what trade-offs the code is making, and where the interesting decisions live, so you can speak about the project intelligently. It's not customer-facing.

---

## 1. The 30-second elevator pitch

The app generates Catan boards under a stack of constraints. A *board* is a set of hex tiles (resource + dice number) plus ports. The user toggles constraints (no same number adjacent, no multiple reds on a resource, include desert, etc.) and a "challenge flavor" (none / scarcity / boom-or-bust / drought). The generator brute-forces candidate boards, scores each one, and returns the first one that satisfies all hard constraints AND meets the fairness threshold — or, if 5000 attempts can't satisfy the threshold, the best-scoring candidate it saw with a "best-effort" notice.

Why is this interesting? Three things:

1. **Constraint satisfaction with a fairness objective.** The hard constraints are easy. The fairness check is a soft objective measured by simulating the first round of a snake-draft pick. That's a 30-line simulator that ranks settlement spots, picks the best, blocks neighbors per the distance-2 rule, and repeats for `2N` rounds. The standard deviation across player pick-value totals is the "fairness" number.
2. **Per-spot scoring is multidimensional.** Each intersection (corner where three hexes meet) gets a score combining: raw pip value, resource diversity, port proximity (with type/resource match bonus), city/road synergy combos, scarcity premium, same-number penalty, and an expansion-potential bonus. This is what lets the snake-draft simulator pick "good" spots, which is what makes the fairness check meaningful.
3. **The mobile build is interesting on its own.** Rendering the board as inline SVG and panning/zooming smoothly across desktop Chrome, iOS Safari at retina, and 4K full-screen Chrome required a non-trivial transform pipeline — see [§ 6](#6-the-pan-zoom-transform-pipeline).

---

## 2. Project structure

```
src/
├── game/
│   ├── types.ts          Type definitions for the whole domain.
│   ├── constants.ts      Per-player-count board specs (resource counts,
│   │                     number counts, port distributions), red numbers,
│   │                     pip values, fairness thresholds.
│   ├── coords.ts         Axial coordinate math + hex-corner geometry +
│   │                     intersection graph builder.
│   └── layout.ts         Builds the empty hex layout and canonical port
│                         slot positions.
├── generator/
│   ├── randomize.ts      The constraint-driven random placer.
│   ├── constraints.ts    Hard-constraint check after placement.
│   ├── score.ts          Spot scoring + snake-draft fairness simulation.
│   └── generate.ts       The top-level loop that ties it all together.
├── state/
│   └── store.ts          Zustand store. View toggles, current map, etc.
├── url/
│   └── encode.ts         JSON-over-base64url URL hash encoding/decoding.
├── ui/
│   ├── Board.tsx         The SVG-rendered board. Includes gesture handling
│   │                     and the hybrid transform pipeline.
│   ├── Controls.tsx      Mobile-drawer + desktop-side-panel options UI.
│   ├── TileIcon.tsx      Per-resource hex artwork (trees, sheep, etc.).
│   ├── app.css           All app CSS in one file.
│   └── theme.css         Palette + global resets.
└── main.tsx / App.tsx    Entry point + root composition.
```

---

## 3. The hex coordinate system

The board is stored in **axial coordinates** (`q`, `r`) — a standard hex-grid system where each hex has two axes 60° apart. Pixel positions come from `axialToPixel`:

```ts
x = sqrt(3) * (q + r/2)
y = (3/2) * r
```

This is pointy-top orientation (corners at the top and bottom of each hex). Every other coord system in the codebase derives from axial + a corner index 0–5.

The intersection graph (corners where three hexes meet) is built by enumerating every hex's six corners, rounding pixel positions to a key, and de-duplicating. Two intersections are neighbors if they share a hex side. This graph is what the snake-draft simulator walks.

There's one subtle issue: for the 5–6 expansion (rows of 3-4-5-6-5-4-3 hexes), the row widths and `r` values have parity collisions that, with naive centering, produce a zigzag layout. The fix in `buildHexLayout` forces all odd-`r` rows to round qStart in the same direction as their even neighbors, which makes the whole board uniformly shifted by half a hex unit instead of zigzagging. The water frame's bbox-centering then re-centers it visually.

---

## 4. The generator

`generate.ts` is a `for` loop over up to `MAX_ATTEMPTS = 5000` candidate boards. Each iteration:

1. **`randomizeMap`** — fills hexes and ports.
2. **`checkHardConstraints`** — confirms the user's enabled hard constraints are met (or skip this candidate).
3. **`resolveChallenge`** — if a challenge flavor was selected, pick the rolled flavor (and target resource for scarcity/boom-or-bust).
4. **`challengeMatches`** — confirm this candidate produces the challenge condition (scarce resource has ≤ 4 pips, or boom-or-bust has ≥ 60% pip concentration on one number, etc.). If not, skip.
5. **`scoreMap`** — compute per-spot scores and the snake-draft fairness report.
6. **`fairnessOk = scored.fairness.stdev <= threshold`** — accept if balanced, keep iterating otherwise. Track the best (lowest-stdev) seen so far as a fallback.

If the loop exits without finding a board that hits the fairness threshold, return the best-seen with `fellBack: true`, which surfaces a "best-effort" notice in the UI.

### The two fairness thresholds

`game/constants.ts` has two threshold tables:

- `FAIRNESS_THRESHOLD` (1.0 across the board) — used for challenge modes, which intentionally produce imbalanced boards.
- `FAIRNESS_THRESHOLD_BALANCED` (0.6–0.8 depending on player count, tighter) — used when `challenge.flavor === 'none'`.

`generate.ts` picks the right one based on `variants.challenge.flavor`. The strict threshold means more iterations on average, but produces noticeably tighter pick-value spreads in balanced mode.

### Number placement is two-phase

`placeNumbers` in `randomize.ts` is the interesting part of the generator. It does:

1. **Phase 1 — high-yield (5, 6, 8, 9) first.** Reds (6, 8) are sorted first because they have the tightest neighbor constraint. For each number, a candidate pool is built by filtering hexes that don't violate any hard constraint. Then several soft preferences narrow the pool:
   - Spread across resources (place on the resource with fewest high-yields so far).
   - Don't place this number on a resource that already has it.
2. **Phase 2 — fill in the rest.** Low-yield numbers (2, 3, 4, 10, 11, 12) drop into the remaining slots with a softer set of preferences.

Two-phase placement matters because the high-yield numbers are where most of the fairness comes from. Get those right and the rest is filler.

### Hard constraint checks happen after placement

There's a `checkHardConstraints` pass that runs after randomization. If it fails, the whole candidate is thrown out and the next attempt starts. This is cheaper than trying to fix-up a bad placement.

---

## 5. The scoring system

`score.ts` is the brain of the fairness check. The per-spot score combines:

- **Pip value** — raw expected income (each number has a "pips" value 1–5, summed across adjacent hexes).
- **Diversity bonus** — `0.5 × (unique resources − 1)`.
- **Port bonus** — `+1.0` if you have a 2:1 port matching an adjacent resource, `+0.3` for any other port.
- **Synergy bonus** — `+1.5` for road combo (brick + wood with shared numbers), `+1.5` for city combo (ore + wheat with shared numbers), `+0.5` for all-settlement-resources.
- **Same-number penalty** — duplicates of the same number on adjacent hexes is a double-edged sword: you double up when it rolls but you have fewer distinct numbers feeding the spot. Penalty scales by pip value (a 12-on-12 is much worse than a 6-on-6).
- **Scarcity bonus** — proportional to the pip-yield scarcity of each adjacent resource on this specific map. **Production scarcity only**, not tile-count scarcity: the bag's tile distribution is fixed by the rules (brick = 3, ore = 3, others = 4), so the only meaningful scarcity is "this resource rolls rarely on this particular board." A previous tile-count term that rewarded 3-tile-resource adjacencies was removed after a full-regeneration validation showed it amplified a small structural per-tile pip advantage for brick/ore into ~50% top-spot dominance with no compensating gameplay benefit. Pip-yield scarcity alone keeps the principled signal (production-rarity) without the category error.
- **Expansion potential** — looks two intersections away (the closest legal future settlements under the distance-2 rule) and bonuses spots with viable expansion targets nearby.

The snake-draft simulator then loops `2N` times (each player picks 2 spots, second pick in reverse order). On each iteration:

1. Filter out blocked spots.
2. Sort by total score, descending.
3. Pick the top spot.
4. Block that spot and all its neighbors (the distance-2 rule).

Player totals are summed, and `stdev` / `spread` reported. `stdev` drives the fairness threshold; `spread` (max − min) is shown in the UI because it's more intuitive.

This is intentionally a **greedy** simulator, not a perfect game-theoretic optimizer. Real human players don't always pick the theoretical maximum — they pick "good" — so a greedy simulator is a reasonable proxy for whether the board is balanced for real play.

### High-yield placement strategy

`randomize.ts` exposes a `spreadHighYieldMode` option that controls how high-yield numbers (5/6/8/9) are distributed across resources during placement:

- **`byCount`** (default) — equalize the total number of high-yield placements per resource. With 8 high-yields across 5 resources, each resource gets ~1.6 high-yields. Because 3-tile resources (brick, ore) have fewer tiles to spread that count across, they end up with a higher per-tile high-yield rate (~50%) than 4-tile resources (~42%). This produces a small structural per-tile pip advantage for brick/ore.
- **`byRate`** — equalize the per-tile high-yield rate across resources. Removes the 3-tile per-tile bias, but inverts it (brick/ore drop to 35% per-tile rate, others rise to 49%) and **doubles the rate of unhealthy resources per map** (3-tile resources get starved more often when high-yields are diverted to 4-tile resources). Validated via 1,000-map regeneration and rejected.
- **`off`** — no placement preference. Surprisingly, the per-tile bias still exists in `off` mode (caused by the always-on "don't duplicate this number on this resource" soft preference, which favors 3-tile resources because they're less likely to already-have-this-number). Disabling spread entirely only drops brick+ore top-spot frequency by ~2.6pp.

`byCount` remains the default because the small per-tile pip advantage it allows reflects real Catan economics (brick+ore corners genuinely *are* more valuable on the box-distribution), and the alternatives produce no meaningful gameplay improvement.

---

## 6. The pan-zoom transform pipeline

This is the most engineered part of the UI. The requirements pull in opposite directions:

- **Smooth** at 60fps during drag/pinch/wheel, including on a 4K full-screen Chrome window.
- **Sharp** at rest, including on iOS Safari at retina, even when zoomed in.

The naive options each fail one requirement:

- **CSS `transform` on the `<svg>` only** — fast (GPU composite) but iOS Safari keeps the bitmap stretched after `will-change` is cleared, so the static zoom-in view stays blurry.
- **SVG-native `transform` on an inner `<g>` only** — sharp at any zoom but re-rasterizes ~150 vector nodes per frame, which lags visibly on both iOS and 4K Chrome during active gestures.

The solution is a **hybrid** that swaps modes at gesture boundaries (`enterCSSMode` / `exitCSSMode` in `Board.tsx`):

- During an active gesture: clear the inner group's SVG transform, apply CSS transform on the outer `<svg>` (with `will-change: transform`). Fast bitmap composite.
- On gesture end: clear the CSS transform, apply the equivalent SVG matrix transform on the inner group. Browser re-renders vector at the resting zoom. Sharp.

The math is set up so both modes produce the same visual position, and the browser batches both DOM writes into one frame so the user never sees a jump.

Other performance details in the same pipeline:

- **`viewRef` stores x/y/scale in SVG user units**, not pixels. Drag deltas come from `useGesture` in pixels and are converted via `px2unit()`. This keeps the math consistent across the CSS↔SVG swap.
- **`ResizeObserver`-cached container bounds.** `getBoundingClientRect()` would trigger a forced layout flush every gesture frame.
- **`requestAnimationFrame` coalescing.** Some pointer devices fire pointermove > 120Hz; without coalescing each event triggers its own style mutation + paint.
- **`translate3d(x, y, 0)`** instead of 2D `translate(x, y)`. Guarantees a dedicated GPU compositor layer across all browsers.
- **`contain: layout style paint`** on `.app__board`. Scopes browser invalidation work to the SVG subtree.
- **No `feDropShadow` filters.** Large filter regions at 4K force per-frame buffer reallocation; iOS Safari also silently drops sub-perceptible feDropShadow filters entirely. The water frame uses a gradient + stroke instead.

---

## 7. iOS Safari SVG quirks

iOS Safari has three SVG quirks the code works around. None of them are documented as "bugs" — they're "this works on Chromium and renders silently wrong on iOS":

1. **`em` units in SVG `dy` resolve against the document root font-size**, not the text element's `font-size`. The code uses numeric `dy` values (computed as `0.35 × fontSize` at write-time) for every text element that needs vertical centering. Touching SVG `<text>` requires the same pattern.

2. **`dominant-baseline: central` silently falls back to the alphabetic baseline.** All text elements use the explicit `dy` + `textAnchor="middle"` pattern instead of relying on `dominant-baseline`.

3. **`feDropShadow` with sub-perceptible values drops the entire filtered group from the render tree.** This is how the number tokens were originally invisible on iOS. The fix: don't use feDropShadow at all in this project.

These are recorded in the memory file `feedback_ios_safari_svg_quirks.md` so future passes don't re-derive them.

---

## 8. The mobile UI

`Controls.tsx` does double duty as a desktop side panel and a mobile bottom drawer. On mobile (< 900px):

- The drawer is `position: fixed` at the bottom, with `max-height: 75dvh`.
- It uses `transform: translateY()` to slide between "open" (translateY 0) and "closed" (just the peek bar showing).
- The transform is set imperatively via `useGesture` from `@use-gesture/react`, so the drawer follows the finger 1:1 during drag.
- On release, the gesture handler snaps to open or closed based on net movement past the midpoint OR fast-swipe velocity (`vy > 0.5`).
- While closed, the body has `pointer-events: none` so the sliver of cream-colored body bleeding above the safe-area inset doesn't hijack accidental swipes.
- `filterTaps: true` on the drag config means short taps fall through to the button's native `onClick`, which toggles open/closed.

The header is `position: absolute` with `pointer-events: none` on the bar itself and `pointer-events: auto` only on the title and seed pills. That's so the board can extend edge-to-edge underneath the header without the pills blocking pan gestures over their footprint.

The board view controls (rotate ±30°, reset rotation, reset pan/zoom) sit `position: absolute; bottom: calc(56px + safe-area + 12px)` on mobile so they stay clear of the collapsed drawer's peek bar.

---

## 9. URL sharing

`url/encode.ts` serializes only the **seed + player count + non-default variants** into the URL hash — NOT the full hex/port data. The recipient re-runs `generateMap` with the same parameters, and because the RNG (`mulberry32`) is deterministic, gets the byte-identical board.

That keeps the URL around 50 chars for a typical balanced board (vs. ~1400 chars if we shipped the full state). Only fields that differ from `defaultVariants()` are written, so a default 4-player URL looks like:

```
#m=eyJ2IjoyLCJzIjoidDk5YXU4IiwicCI6NCwieiI6e319
```

decode reads the wire version field: `v: 2` triggers the regenerate path, `v: 1` triggers a legacy "rebuild from embedded data" path so URLs shared before the format change still load.

---

## 10. Testing

The generator has a Vitest suite (`tests/generator.test.ts`) that checks the hard constraints and the fairness math. There are no UI tests — the UI behavior is mostly browser-rendered behavior that wouldn't be well-tested by jsdom.

---

## 11. Hosting / deploy

GitHub Pages serves project repos at `username.github.io/<repo-name>/`. The `vite.config.ts` sets `base: '/catan-map-generator/'` to match. The `.github/workflows/deploy.yml` runs on push to `main`:

1. Build (`npm ci` + `npm run build`)
2. Upload `dist/` as a Pages artifact
3. Deploy via `actions/deploy-pages@v4`

Repo settings → Pages must be set to "GitHub Actions" as the source for the workflow to actually deploy.

---

## 12. Talking points (if asked)

Things you can pull out in a conversation about this project:

- **Constraint-driven generation with a fairness objective**, not just random placement. Two-phase placement (high-yield first, low-yield filler).
- **Per-spot scoring is multidimensional** — pip value + diversity + port + synergy + scarcity + expansion potential + same-number penalty — and drives a snake-draft simulator that measures fairness as the standard deviation of player pick-value totals.
- **Mobile-first SVG rendering** with a hybrid CSS-during-gesture / SVG-after-gesture transform pipeline. Smooth at 60fps during gestures, sharp at rest.
- **iOS Safari quirks** documented and worked around: numeric `dy` instead of `em`, no `dominant-baseline: central`, no `feDropShadow`.
- **Shareable URLs**: any board state round-trips through a short base64url-encoded hash.
- **Zero canvas, zero raster images.** Everything is inline SVG, including the resource artwork (trees, sheep, mountains, etc.).
