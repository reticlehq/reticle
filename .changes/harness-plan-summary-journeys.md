### Fixed

- **`@reticlehq/server` — a Harness plan run that drove nothing was summarised "Nothing was driven and nothing was replayed: the run made no action against the app".** The plan page kept that line, and "give it a `persona`" advice, under runs whose journeys had replayed or been stopped by a guard. A plan run's summary now leads with its journeys' verdict and its replays; the persona advice is only for persona drives.
