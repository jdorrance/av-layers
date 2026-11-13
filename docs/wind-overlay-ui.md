# Wind overlay build target

Build the approved Woodstock controls and three wind views in the standalone map.
The [data plan](weather-data-plan.md) owns delivery and implementation sequencing.

Approved 2026-11-13. These captures use published RRFS lift for Woodstock,
Virginia, with illustrative winds that strengthen with height. Production winds
follow the forecast, including shear and decreases with height. Updated controls
use the reference OpenStreetMap basemap; Google Terrain is the production target.

![Desktop wind controls](assets/wind-overlay/desktop.jpg)

<img src="assets/wind-overlay/phone-menu.jpg" alt="Phone controls with the wind menu open" width="390" />

## Map controls and defaults

Default to **Auto** forecast selection: the finest available model covering the
map center and selected time. Show a compact Auto control with other model choices
inside its collapsed details menu. Honor an explicit model in an existing URL and
show its actual name. Model selection remains independent of wind height.

Use **Google Terrain** as the production basemap through the official
[Map Tiles API](https://developers.google.com/maps/documentation/tile/terrain).
Keep its attribution visible. Provider setup belongs to the data plan.

Place a **36 × 36 px** current-location bullseye in the upper-right map controls.
On tap, request one location fix and center the map. Show locating, unavailable and
denied states; a failed request leaves the view intact. The mockup simulates this
control without requesting location.

Keep a small **km / mi** switch beside the map controls. It owns one app-wide
metric/imperial preference, including the map scale, rail, keys, probes and
Windgram. Use km/mi for distance, km/h/mph for horizontal wind, m/ft for height,
m/s/ft/min for vertical speed, °C/°F for temperature, mm/in for precipitation
(including hourly rates), hPa/inHg for pressure, and °C/km or °F/1,000 ft for lapse
rate. Persist the preference.
Keep canonical SI values, cached data, physical AGL stops and palette thresholds
unchanged; switching units updates labels and glyphs without downloading fields.

## Wind display

Support **White trails** (default), **XC barbs**, and **Flow + sparse barbs**.
Use thin, connected white trails. Keep speed coloring off. All three views sample
one wind field; switching the style reuses resident data. The hybrid reduces barb
density while retaining the same glyphs and speed values.

Place the wind menu directly above the height rail. Its closed button is
48 × 32 CSS px, with the selected style glyph and a chevron. The open menu is
about 100 × 62 px, bottom-aligned **6 px left** of the fixed trigger.
Opening or selecting a style leaves the trigger and rail in place. Its first row
selects the three styles; its second row contains wind visibility and animation
pause/play. Keep the popup clear of the trigger's hit area so its activation
cannot reach Pause or another newly revealed action.

Selecting a style enables wind and closes the menu. Hiding wind retains its style
and height. Pause is disabled for barbs and hidden wind. Show the paused/off state
on the closed control. Escape and outside click close the menu; restore keyboard
focus to its trigger. Use focus without scrolling when opening or closing the
menu. Keep these controls together beside the rail.

## Wind height

Keep the rail **48 CSS px wide**, about **198 px tall on phone / 238 px on desktop**,
including its top selector. Reserve map space below it for the timeline.

- The bottom stop is **Surface**: source 10 m wind above model terrain.
- Numeric stops are **600 through 6000 m AGL**, in 600 m steps, relative to the
  prepared local terrain. Display the selected value beside the thumb.
- **Top of lift** is a separate button above 6000, divided from the numeric rail
  and marked `auto`. It follows the local usable-lift ceiling across the map.
- Selecting Top of lift hides the fixed-height thumb and retains the last fixed
  selection. Moving the rail returns to fixed-height mode.

Keep `m AGL` or `ft AGL` inside the rail, following the global units. Convert the
same physical stops when units change. The phone has no duplicate upper-left wind label.
Unsupported height samples remain unavailable; Surface and valid calm remain
distinct. Top of lift may lie anywhere within the supported profile.
Point inspection shows values for valid samples, `Wind unavailable` for missing
support, `Outside forecast area` outside the domain, and `No usable lift` when
Top of lift has no target. All three absent states omit glyphs and trails. If no
LOD qualifies for the viewport, the wind control exposes `Zoom in for wind` and
retains the requested selection without an endless loading state.

## Lift shading

Place the separate **156 × 46 px** lift key in the **lower-left corner, 8 px above
the timeline**. Put the AGL/MSL radio toggle inside its existing `Lift m`/`Lift ft`
line. Put the short opacity slider on that same line; keep it visible and
adjustable in 5% steps. Default lift opacity to **50%** and honor explicit saved
opacity. Preserve the lift palette, converting key labels with the global units.

Changing the lift reference changes shading and its key. Wind heights remain AGL.
Opacity affects only lift shading. The key and its controls share one compact box.

## Timeline

Use the captured compact strip: maximum **540 px wide**, **40 px tall on desktop /
44 px on phone**, with a date/time block, playback button, and scrollable hours.

- Place previous/next-day arrows beside the date. Keep the nearest available
  hour when changing days; disable arrows at the first/last available day.
- Use a quiet common baseline and short `00`–`23` hour labels. Show the selected
  date, full time, and timezone in the date block.
- Show published frame times, including sparse three-hour intervals. Scroll in
  whole hour cells and keep the selected cell fully visible.
- Playback advances through available frames across midnight and stops at the
  last frame. Replay begins at the first frame.
- Preserve the current requested/displayed-time distinction while data loads.
  Replace a field atomically and clear old wind trails when its time changes.
  When lift advances before wind is ready, display matching-time coarse wind or
  hide stale wind with compact loading in the wind control. Keep cloud and
  precipitation identities consistent with the selected forecast too.

The capture uses `America/New_York` and UTC frame identities. Production uses the
application's explicit display timezone, including daylight-saving transitions.

## XC barb fidelity

The [XC guide](https://docs.xcskies.com/home/documentation/understanding-wind-barbs)
and observed [live map](https://www.xcskies.com/map) are the visual references.
Match the artwork with independent assets and the following measured targets:

- A world/tile-anchored **32 CSS px lattice**: eight centers per 256 px tile,
  starting at 16 px. Keep pan/zoom anchoring stable.
- Approximately 24 px glyph extent and 21 px full staff; 1 CSS px black stroke,
  butt caps, miter joins, and no outline halo. Rotate the staff with wind direction.
- Upright integer speed labels in Helvetica Neue/Arial, about 9.6 px. Apply the
  selected unit conversion before truncating the displayed value.
- Calm is the literal capital **O**, about 10 px Arial, when the displayed
  truncated speed is zero. A valid exact `(0, 0)` vector also renders calm.
- Missing wind draws no calm symbol. Feather thresholds and label offsets must
  match XC golden captures in each supported unit and direction.

Place the unfeathered tip at the sampled location; it points downwind, in the
direction particles travel. The feathers extend upstream.
Browser font rasterization may differ, so compare geometry and CSS-pixel sizes
separately from antialiasing.

## Acceptance

Verify the controls at 320 px and 390 px phone widths and a 1200 px desktop view.
Keep the rail clear of the timeline, labels unclipped, and the page free of
horizontal overflow. Keep the lower-left key clear of attribution and the
timeline, including phone safe areas.

Use one Tab stop per radio group, arrow/Home/End navigation, accessible names,
visible selection, and a labelled native range. Test day boundaries, unavailable
hours, Top of lift without lift, style changes while paused, wind off/on, and
rapid height/time changes. Compare barbs at calm and feather thresholds; verify
white trails and the hybrid against the same decoded vectors.

Verify fresh-load Auto/50% defaults and explicit saved overrides. Switch km/mi
with a point card open: every quantity and the rail update consistently, while
the selected physical height, time and cached fields stay fixed. Test location
success, timeout and denial. Repeated pointer, touch and keyboard style selections
must cause no layout shift, page scroll or accidental pause/visibility action.

Capture provenance: RRFS cycle `2026-11-12T18:00:00Z`, build
`20261112T215710Z-fefa6305-83de-488b-a745-700ec7eda922`, displayed forecast
`2026-11-13T18:00:00Z`. Map imagery credits remain visible in both captures.
