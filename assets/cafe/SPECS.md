# Cafe section — photography specs

Real photography needed for the three atmosphere panels in the "Cafe" section
of `index.html` (`#cafe`). Until real photos exist, those panels use a
CSS-only dark carbon-texture + red-glow treatment (`.cafe-visual-panel` in
`css/style.css`) with an icon and short caption - deliberately not filled
with stock or placeholder photography.

This file is not referenced anywhere in the live site - it costs nothing to
keep here, it's just a spec sheet for whoever shoots/sources the photos.

## Required specs - all three panels

| | |
|---|---|
| Aspect ratio | 4:5 (portrait) |
| Recommended export size | 1200 x 1500 px |
| Format | JPEG, quality ~80-85 |
| Do not stretch | If a source photo isn't natively 4:5, crop to 4:5 - never distort it to fit |
| Lighting | Should read true under the venue's own red accent lighting, not washed out or overly color-cast |

## The three shots

1. `rig-bay.jpg` - "Race": the Static/Motion simulator rigs in use - wheel,
   pedals, and screens visible.
2. `pit-lane-detail.jpg` - "Xperience": a close/medium shot of the matte
   black, carbon-texture, and red-LED detailing - the "pit lane" look.
3. `lounge.jpg` - "Hangout": the cafe/lounge seating area, ideally with
   people in it, showing the social side of the venue.

## To go live

Once a file exists at `assets/cafe/<name>.jpg`, swap it into the matching
`.cafe-visual-panel` in `index.html` - either as an `<img>`, or as that
panel's `background-image` in CSS. The icon + caption can stay as an overlay
on top of the photo, or be dropped once the photo makes the label obvious on
its own.
