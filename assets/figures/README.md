# Figures

HTML sources for the rendered images in `docs/images/`. Committed so the images can be
edited and regenerated rather than being binaries nobody can change.

Render with headless Chrome:

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Open Graph card -> docs/images/og.png
"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1200,630 \
  --screenshot=docs/images/og.png "file://$PWD/assets/figures/og.html"

# Annotated verdict -> docs/images/verdict-annotated.png
"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1400,940 \
  --screenshot=docs/images/verdict-annotated.png "file://$PWD/assets/figures/verdict.html"
```

```bash
# Desktop IPC showcase -> docs/images/desktop-ipc.png
"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1400,760 \
  --screenshot=docs/images/desktop-ipc.png "file://$PWD/assets/figures/desktop.html"
```

The window height must fit the content — Chrome clips rather than growing the page, and a
too-short window silently cuts the bottom off. Check the rendered PNG, every time.
