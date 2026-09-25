### Fixed

- **`@reticlehq/server`: a page read keeps one element per line, whatever the app put in its text.** The compact page format quoted names and values but did not escape line breaks, so a textarea holding several lines split its element across lines, and what came after it no longer parsed as elements. Newlines and carriage returns are now escaped inside the quotes. Contributed by @thegoodengineer in #917.
