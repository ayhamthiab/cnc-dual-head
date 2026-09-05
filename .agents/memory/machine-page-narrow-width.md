---
name: Machine-page narrow-width checks
description: How to verify responsive machine controls when fixed navigation substantially reduces the usable content pane.
---

Judge the Machine Controller's narrow layout against the actual scrollable main
pane width, not only the browser viewport width. At a 320px viewport, fixed
navigation and the vertical scrollbar can leave roughly 241px for machine
content. Flex rows with fixed-width actions or auto-margin status badges must
wrap or stack at that real width.

**Why:** Viewport breakpoints alone made several controls look mobile-ready
while they still produced small horizontal overruns inside the much narrower
main pane. Repeated browser measurements were needed to isolate the offenders.

**How to apply:** In responsive browser checks, compare the main pane's
`scrollWidth` and `clientWidth` at 320px, 402px, laptop, and zoomed desktop
sizes. Keep the page's main pane as the normal vertical scroller; only the two
per-head console outputs should retain nested vertical scrolling.