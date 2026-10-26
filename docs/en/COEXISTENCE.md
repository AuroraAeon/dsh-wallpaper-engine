# Coexistence: Glass Surfaces and Other UI Plugins

> **Chinese**: [../COEXISTENCE.md](../COEXISTENCE.md). This page describes the source branch; published releases may differ.

## Ownership Boundaries

Wallpaper and glass remain independent. Turning wallpaper off does not disable glass. The skin-centre marker `html[data-dsh-skin]` still makes the plugin yield as a whole and restore after the skin leaves.

While a wallpaper is active, the two page-let-through tokens (`--dsw-alias-bg-base`, `--dsw-specific-sidebar-fill`) are declared with author `!important` (`src/styles-base.js`, the `body[data-we-wallpaper]` and dark-theme blocks). This is a **cross-plugin contract**, not defensive coding: DSH's theme API lets a plugin (DS Bot's Bot mode, for example) colour the host through `ctx.theme.overrideTokens`, and the host writes the composed tokens as **inline styles** on `<body>`; a normal author declaration always loses to an inline one, so the wallpaper layer stays hidden behind the opaque page base ([#282](https://github.com/elysia395/dsh-wallpaper-engine/issues/282), the same "another plugin covers the wallpaper" class as [#279](https://github.com/elysia395/dsh-wallpaper-engine/issues/279)). The `!important` only applies inside the wallpaper gate; with no wallpaper this plugin declares nothing and the host's inline values apply unchanged — a one-way takeover that reads and writes no other plugin's state. A third-party panel that needs its own backing should paint its own surface background or use `data-we-surface-preserve` instead of rewriting these two page-background tokens.

The **page-level background-layer token mapping** (`--dsw-alias-bg-layer-1/2/3`, `--dsw-alias-button-elevated-fill`, `--dsw-alias-bg-overlay`, …) applies on `body[data-we-glass-page]` to the **whole page**: the host's own sidebar buttons, right-panel tab strip and settings-window cards all read that family, so scoping it to the chat flow alone makes those surfaces fall back to the host's solid fills. Every mapping still carries the readability floor (`--we-readability-floor`), so it is not unbounded transparency. Frost and backing plates for the settings window, sidebars and declared surfaces are still claimed per surface by the shared ownership runtime; unknown third-party panels keep their own background declarations, button semantics, syntax colours and terminal ANSI colours.

| Surface | Adaptation | Fallback |
|---|---|---|
| Native sidebars | Geometry-checked decorative leaves behind the page | Native background; no ancestor positioning or layer escalation |
| Settings window | Unused `::before` in an existing positioned stacking context | Native if blur, an occupied pseudo-element or unsafe structure prevents adaptation |
| Right-sidebar CodeMirror / xterm | Known canvases inside the expanded native sidebar | Ownership removed on native policy, preserve or sidebar close |
| Declared third-party surfaces | Explicit declaration and carrier safety checks | No guessing for undeclared or unsafe content |
| Extra selectors | Frost in an unused pseudo-element within an existing context | No new context or forced content-background removal |

Outer host-shell wallpaper transparency is separate from glass adaptation. These boundaries are not certification of every third-party plugin.

## Per-Surface Fallback

**Glass compatibility** in appearance settings offers **Automatic** and **Keep native** for each surface. `glassSurfacePolicy` controls adaptation eligibility; existing inherited/custom `glassMode` parameters keep their meaning. Missing policies mean automatic. Policies participate in settings and profile preset persistence, import and export.

Surface IDs: `left-sidebar`, `right-sidebar`, `settings-window`, `content`, `declared`, `extra`. The advanced list shows ownership records as `id / mode / reason`, without collecting plugin text or arbitrary styles. It is a panel-render snapshot, not compatibility certification.

This is not a global glass-off switch. Chat, title-bar and other independent gates are outside this table. See [ADR-0010](../adr/0010-glass-off-revisit-four-states.md).

## Author Declarations

```html
<section data-we-surface="v1" style="position:relative;z-index:1">
  <div data-we-surface-layout>Layout allowed to lose its background</div>
  <div data-we-surface-preserve>Content that must stay native</div>
</section>
```

- `data-we-surface="v1"` requests adaptation, not guaranteed ownership. Do not add a stacking context to shared ancestors merely for glass; the example assumes this positioning already exists.
- `data-we-surface-layout` permits background removal inside an owned declared surface, without crossing nested ownership boundaries.
- `data-we-surface-preserve` opts a node and descendants out, taking precedence over built-in adapters and extra selectors.
- Runtime attributes such as `data-we-surface-runtime` and `data-we-layout-runtime` are private. Third-party plugins must not set or depend on them.

No third-party nodes are moved, no third-party z-index is changed, and no top-layer escalation is used. While an external modal is visible, WE's rope, repository panel, update notice and automatic introduction hide. Ordinary non-modal `role="dialog"` does not trigger yielding.

## Troubleshooting

| Symptom | Check |
|---|---|
| A surface stays opaque | Inspect policy and reason; preserving unknown content can be intentional fallback. |
| Extra frost does not appear | Check existing positioning, non-auto z-index, blur, occupied `::before` and preserve. |
| A popup is covered or fixed content moves | Compare geometry and actual hit targets with WE disabled. Inspect transform, filter, contain and stacking ancestors, rather than raising z-index. |
| A plate survives sidebar collapse | Record sidebar mode, policy and reason; closing should revoke ownership and decorative leaves. |
| Glass does not restore after a skin leaves | Allow yield observation to settle; include versions, reproduction and diagnostics if it persists. |

## Verification and Limits

`node test/verify-glass-runtime-browser.mjs` runs actual bundle CSS and runtime in isolated Chromium. It checks themes, narrow screens, hit testing, focus, fixed geometry, pixels, fallback and cleanup. Set `WE_TEST_BROWSER` to an executable when necessary. A missing browser fails rather than silently skipping. This regression is in `npm run verify`.

Host-structure fixtures do not replace testing each real third-party window, prove a native crash fix, or establish long-term stability. Untested platforms and independent-review status must be reported separately.

Further reading: [surface ownership](../adr/0015-glass-surface-ownership.md), [token ledger](../TOKEN-CONTRACT.md), [troubleshooting](../TROUBLESHOOTING.md).
