# Design notes: "The Door"

The front end is themed around the product's name: a ticket's journey from purchase to walking through the
door. This is a presentation-only redesign. No routes, request or response shapes, or server behavior changed.
The previous front end is kept untouched in `public-classic/`.

## The idea in one paragraph

A softly lit doorway sits behind everything. On the shop page a ticket stub floats in front of it (three.js
when the device can afford it, pure CSS otherwise). The door is shut before the age check, opens a little when
the age answer is accepted, wider when the ticket is issued, and fully at the gate. A refusal keeps it shut and
shows a lock icon plus text. A slim journey rail (Buy → Verify → Ticket → Door) on every page shows where the
visitor is. Amber is reserved for tickets and primary actions; green and red only for admit/refuse and
success/error, and never on their own (always with an icon or a word).

## Ideas used, where they came from, and why they fit

Ideas were taken and rewritten from scratch. No code or assets were copied.

| Idea | Source | Why it fits Buy to Door |
| --- | --- | --- |
| Ticket stub cut-outs made with radial gradients used as a CSS mask, so the notches keep their size when the ticket resizes | Ahmad Shadeed, "Football ticket" (read in full): https://ishadeed.com/article/football-ticket-css-svg/ | The ticket is the product. A real-looking stub (notches, tear line) makes "your ticket" concrete. Used for the CSS fallback ticket on the stage. |
| Pointer-driven 3D tilt with perspective, plus a slow idle float | Codrops "Tilt hover effects" (https://tympanus.net/codrops/2016/11/23/tilt-hover-effects/; returned HTTP 403 when fetched, so only its search summary was seen) and general tilt-card tutorials in the same search | A ticket that leans toward the pointer feels like a physical object held in the light, without needing any interaction to complete a flow. |
| A collectible "ticket card" as the hero object | Awwwards inspiration, "Shiny Ticket Cards" (Klangtherapie Festival): https://www.awwwards.com/inspiration/shiny-ticket-cards-klangtherapie-festival (seen in search results) | Confirms the event-ticket-as-object direction; here it is a single calm object, not a gallery. |
| Cross-document page transitions with `@view-transition { navigation: auto; }`, CSS only, no JavaScript; unsupported browsers simply navigate normally | Chrome for Developers (read): https://developer.chrome.com/docs/web-platform/view-transitions/cross-document | This is a multi-page app. A soft fade between pages and a header that stays put make it feel like one journey. Wrapped in `prefers-reduced-motion: no-preference`. |
| Reduce or replace motion under `prefers-reduced-motion`; a fade is an acceptable replacement | MDN (read): https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion | All non-essential motion is switched off, the 3D scene never loads, and the static CSS doorway and ticket are shown instead. |
| Animate only compositor-friendly properties (transform, opacity) and stay inside the ~16 ms frame budget | web.dev "Rendering performance" (read): https://web.dev/articles/rendering-performance | Door swings, ticket flips, sheet entrances and count-ups use transform/opacity only. |
| Render at a capped pixel ratio, size the canvas from its container, and dispose GPU resources | three.js manual (https://threejs.org/manual/; the fetched pages returned only the site shell, so this guidance is from the manual's known content and the three.js examples list) | `setPixelRatio(min(dpr, 2))`, ResizeObserver sizing, `dispose()` on every geometry, material and texture, and `forceContextLoss()` on teardown. |
| Points with a soft sprite for floating dust in a light beam; canvas textures for printed faces; extruded 2D shapes for the ticket body | three.js examples list (https://threejs.org/examples/): `webgl_points_sprites`, `webgl_materials_texture_canvas`, `webgl_geometry_extrude_shapes` | Dust in the door light sells "light through a doorway" cheaply (220 points, one draw call). The ticket face and the QR-style back are drawn to canvas at load, so there are no image downloads. |
| Graceful degradation for WebGL and treating extensions as optional | MDN "WebGL best practices" (read): https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices | The 3D code is optional. Missing WebGL2, software rendering (`failIfMajorPerformanceCaveat`), data-saver mode, a low core or memory count, or a slow first 90 frames all fall back silently to CSS. |
| Glass panels need a solid fallback and their text checked against the effective (blurred and tinted) backdrop | Search results on `prefers-reduced-transparency` and glassmorphism contrast (secondary sources); MDN's accessibility media queries page lists `prefers-reduced-transparency` | The privacy receipt is frosted glass, with an opaque fallback under `prefers-reduced-transparency`. Text contrast was computed against the glass composited over the brightest door light. |
| Scroll-driven animations (`animation-timeline: view()`) | Chrome for Developers (read): https://developer.chrome.com/docs/css-ui/scroll-driven-animations | Considered and not used. Pages are short and task-focused, and support is uneven. Entrance animations run once when content appears instead. |

## Design system

All tokens live at the top of `public/styles.css`:

- **Colour:** light "paper" theme on `:root`; midnight theme under `prefers-color-scheme: dark` and `[data-theme="dark"]`; a flat high-contrast light theme forced on the gate (`data-page="gate"`). The header toggle remembers the visitor's choice in `localStorage`. Without a saved choice the system setting is followed, so a visitor on a light system sees light first.
- **Type:** system UI stack for body text; Bricolage Grotesque (variable, latin subset, 41 KB) for headings.
- **Scale:** `--step--2` to `--step-4`, `--space-1` to `--space-8`, radii `--r-sm` to `--r-xl`, shadows `--shadow-1` to `--shadow-3`.
- **Motion:** `--dur-fast` 150 ms, `--dur` 280 ms, `--dur-slow` 480 ms, `--dur-door` 720 ms (door transitions stay under 800 ms), easings `--ease-out`, `--ease-in-out` and `--ease-spring`.

Every text colour pair was checked at 4.5:1 or better in light, dark and gate themes, including text on glass
over the door light. The yellow "Simulated wallet. Test credential. Not a real ID." banner uses the same
yellow and dark ink in every theme (12.1:1).

## Honesty

The wallet answer in mock and hybrid mode is simulated, and the copy never says otherwise. The 3D ticket's back
shows a QR-style pattern that encodes nothing; the real ticket QR is the one rendered on the page. The privacy
receipt says "Received, then discarded" (not "never seen"), because the server does receive those fields before
the firewall drops them.

## Libraries added

Both are installed with npm at exact versions as devDependencies, and their built files are copied into
`public/vendor/`. Nothing is loaded from a CDN at runtime.

| Library | Version | License | Files in `public/vendor/` |
| --- | --- | --- | --- |
| three.js | 0.180.0 | MIT | `three/three.module.min.js`, `three/three.core.min.js`, `three/LICENSE-three-MIT.txt` |
| @fontsource-variable/bricolage-grotesque (Bricolage Grotesque font) | 5.2.8 | SIL Open Font License 1.1 | `fonts/bricolage-grotesque-latin-wght-normal.woff2`, `fonts/LICENSE-bricolage-grotesque-OFL.txt` |

To update three.js later: `npm install --save-dev --save-exact three@<version>`, then copy
`node_modules/three/build/three.module.min.js` and `three.core.min.js` into `public/vendor/three/`.

## Performance notes

- The 3D scene loads only on the shop page, at idle time, and only on capable devices. three.js is about
  703 KB minified and uncompressed, because `express.static` does not gzip. Most HTTPS tunnels compress it in
  transit. If that is too heavy, a tree-shaken bundle of just the classes used would be smaller; that needs a
  bundler step, which was left out to keep the vendored files exactly as published.
- Rendering pauses when the tab is hidden or the stage is off screen (IntersectionObserver), the pixel ratio is
  capped at 2, and a watchdog hands back to the CSS version if the median frame time over the first 90 frames is
  slower than about 28 fps.
- The wallet and gate pages load no 3D code and use no blur on the gate.
