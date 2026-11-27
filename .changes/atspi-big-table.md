### Fixed

- **`@reticlehq/computer` — on Linux, a read of a LibreOffice Calc sheet never ended.** A sheet gives the accessibility bus one child for each cell of the sheet. The helper read every child of a long table to keep the cells on the screen, and a read of Calc took more than two minutes, so every action in Calc timed out. A table with more than 5,000 children now gives only the cells on the screen, found through its table interface, and says how many it left out (`notShown`). A read of a Calc sheet now takes 2 to 5 seconds.
