---
name: Kiln
colors:
  paper: "#F6F5F1"
  surface: "#FCFBF8"
  well: "#EFEDE7"
  rule: "#E2DED5"
  rule-strong: "#CBC6BA"
  ink: "#1D1E20"
  ink-secondary: "#57554F"
  ink-tertiary: "#8A867D"
  primary: "#22508A"
  primary-strong: "#1A3F6E"
  primary-tint: "#E5EBF3"
  caution: "#8F6416"
  caution-tint: "#F4EAD6"
  error: "#A13A2C"
  error-tint: "#F6E3DF"
  stage-top: "#F1EFEA"
  stage-bottom: "#D9D5CC"
typography:
  display:
    fontFamily: Source Serif 4
    fontSize: 26px
    fontWeight: 500
  title:
    fontFamily: Source Serif 4
    fontSize: 20px
    fontWeight: 550
  section:
    fontFamily: Source Serif 4
    fontSize: 15px
    fontWeight: 550
  body:
    fontFamily: Public Sans
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: Public Sans
    fontSize: 12px
    fontWeight: 550
  caption:
    fontFamily: Public Sans
    fontSize: 11px
    fontWeight: 400
  data:
    fontFamily: IBM Plex Mono
    fontSize: 11px
    fontWeight: 400
rounded:
  sm: 4px
  md: 6px
  lg: 10px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
  2xl: 24px
  3xl: 32px
---

# Design System: Kiln

## 1. Visual Theme & Atmosphere

A calm museum workbench. Kiln feels like a conservation studio inside a public collection: warm gallery neutrals, a seamless photographic sweep behind the artifact, and catalog-card typography for the record. The artifact is always the loudest thing on screen. Chrome stays quiet, light, and precise, in the spirit of Smithsonian collection pages rather than a dark SaaS dashboard.

Signature element: the comparison stage. One camera drives a split view with a white hairline divider, so source and optimized halves stay pixel-aligned while you orbit. Raking light, a 1:1 texel zoom, and clay and wire surfaces turn it into an inspection tool for surface detail and decimation.

Motion is purposeful and short: 120 to 180 ms eases on state changes, a 420 ms camera glide for reset and focus. There are no looping animations or idle render loops. The 3D view renders only on interaction, state change, or resize. Reduced motion removes transitions and makes camera moves instant.

## 2. Color Palette & Roles

- **Paper (#F6F5F1)**: window background. Matches the Electron window color so launch has no flash.
- **Surface (#FCFBF8)**: header, panel, record, floating controls.
- **Well (#EFEDE7)**: segmented control tracks, notes, progress tracks.
- **Rule (#E2DED5) / Rule strong (#CBC6BA)**: hairline dividers, input borders.
- **Ink (#1D1E20)**: primary text and the active floating segment.
- **Ink secondary (#57554F) / tertiary (#8A867D)**: supporting text, captions, file paths.
- **Archive blue (#22508A, hover #1A3F6E, tint #E5EBF3)**: the single action color. Primary buttons, selected preset, switches, slider fill, focus rings, savings figures, the kiln mark.
- **Ochre (#8F6416, tint #F4EAD6)**: caution only. Normal map compression risks, missing Blender, source warnings, size increases.
- **Brick (#A13A2C, tint #F6E3DF)**: errors and the development mock badge.
- **Stage sweep (#F1EFEA to #D9D5CC)**: radial gradient behind the model, like a photography backdrop. The canvas is transparent over it.

## 3. Typography Rules

All fonts are bundled from `src/assets/fonts` under the SIL Open Font License. No network font loading.

- **Source Serif 4** (variable, optical sizes): wordmark, empty-state title, section titles, record title, and figures in the record and ledger. Lining tabular numerals for data.
- **Public Sans** (variable): all interface text. 13 px body, 12 px labels at weight 550, 11 px captions. Group titles are 11 px uppercase with 0.07em tracking.
- **IBM Plex Mono**: file paths, preset specs, texture specs, texel scale. Small and tertiary colored.
- Sentence case everywhere. No em dashes in product copy. No decorative eyebrows.

## 4. Component Stylings

- **Buttons**: 34 px tall (38 px block buttons), 6 px radius, weight 550. Primary is archive blue on white text. Quiet is surface with a strong rule border. Disabled at 50% opacity. Press nudges 0.5 px down.
- **Floating stage controls**: translucent surface (88%) with 6 px blur, hairline border, soft float shadow. Active floating segment inverts to ink with surface text.
- **Segmented controls**: native radios in a well track. Selected segment is raised surface with a 1 px shadow. Keyboard arrows and focus come from the native inputs.
- **Preset cards**: 6 px radius, rule border. Selected card gets a blue border, faint blue tint, and a filled radio. Each shows name, purpose, and a mono spec generated from the preset values, so tuned presets describe themselves.
- **Switches**: 32 by 18 px, blue when on. Hints sit under the label and must state the real effect, including what lossless does not protect (resizing).
- **Sliders**: 4 px track with blue fill to the value, 14 px surface thumb with blue ring. Disabled sliders go gray and their value reads "Lossless" or "PNG, lossless" instead of a number.
- **Risk notes**: ochre text on ochre tint with a triangle icon, placed directly under the control they concern.
- **Stage toolbar**: one centered row of three segments: Source, Split, Optimized (1 to 3), then Texture, Clay, Wire (M cycles), then Studio, Raking (L toggles). Below 900 px of stage width the surface and lighting segments show icons only, keeping their names as tooltips and for screen readers. Clay is a warm matte gray with every map removed, so a normal map cannot hide lost geometry. Wire draws faint ink edges over clay, so dense areas darken instead of going solid. Without textures, the split labels show triangle counts instead of texture specs.
- **Split divider**: 1 px white line with a 28 px round handle. Draggable, and a keyboard slider (arrows, Shift for larger steps, Home, End).
- **Overlay and error cards**: surface, 10 px radius, card shadow, short rise-in. Errors name the problem and offer the remedy as buttons (Locate Blender, Choose another file, Try again).
- **Progress**: 4 px bar. Determinate when the engine reports a percent. When unknown, a still partial bar, never a looping shimmer.
- **Folder list**: when a folder is open it replaces the stage and record. A surface header names the folder and where results are saved, then a ledger-style list with a sticky column header shows each model's path (folders in tertiary ink), source size, web copy size and change, and its status icon: hollow circle waiting, blue dot processing with an inline 4 px bar, blue check done, gray check up to date, ochre triangle needs Blender, brick alert failed with the reason underneath. The panel footer becomes "Process N models" and shows "Model 3 of 27" while running. Finished rows carry an eye button and open on click: the comparison stage appears above the list (which keeps about a third of the height), the row gets a blue tint, and a floating pager sits at the bottom center of the stage with previous and next arrows, the model path and "3 of 12", and a close button. Left and Right step through finished models, Esc closes. The view, surface and lighting carry over from model to model; there is no coach. If the open model is processed again, the stage holds its place with a short note until the new web copy is ready. A sash on the hairline between stage and list (a small surface grip, darker on hover, blue while dragging) shares the height, double-click resets it to about two thirds for the stage, and dragging well past either minimum folds that panel. Each panel folds with its own button (in the pager for the stage, at the end of the column header for the list) into a 40 px surface bar with a blue "Show preview" or "Show list" action on the right. The folded stage stays mounted, so it reopens instantly on the same view, and its bar keeps the pager arrows. The folded list bar shows the model count and the model being processed with its percent. Choosing a row reopens a folded stage, and closing the preview always brings the list back.
- **Ledger**: borderless table with hairline rows. Source in secondary ink, optimized in bold ink, change in blue (smaller) or ochre (larger).
- **Focus**: 2 px surface gap plus 2 px blue ring on every interactive element.

## 5. Layout Principles

- Three zones: a 52 px header, the stage with the asset record under it, and a settings panel on the right (360 px, 320 px below 1180 px wide).
- The panel scrolls on its own. Its footer stays pinned with the memory estimate, viewer needs, and the Optimize action.
- The flow reads left to right and top to bottom: choose a preset, Optimize, compare on the stage, then Export from the record.
- The stage fits the whole object in both horizontal and vertical fields of view on load and on resize until the user moves the camera.
- The record shows source facts before a result, then a Source vs Optimized ledger with the export block beside it. Below 1180 px the title moves to its own row.
- The stage is a container. Below 700 px of stage width, toolbars align left and keyboard hints hide.
- Target sizes: 1280 by 900 and 1024 by 768. Smaller windows scroll (app minimum 900 by 620).

## 6. Voice & Tone

Plain, exact, and reassuring about the original. Name controls by what people recognize ("Keep triangles", "Shape tolerance", "1:1 detail"). Describe effects honestly, including tradeoffs and viewer requirements. Estimates are labeled as estimates. Never claim lossless when resizing still removes detail.
