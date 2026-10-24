### Fixed

- **`@reticlehq/browser` — three documented calls did not compile in a strict TypeScript app.** `jotaiStore` and `recoilStore` rejected atoms of different value types, for example `{ cart: cartAtom, user: userAtom }`. `canvasChartData(canvasEl, window)` rejected `window`. Each call worked at runtime. The store now sets the atom type, so each atom keeps its own value type. `canvasChartData` now accepts `Window`, and its globals type is exported as `ChartGlobals`. This works on TypeScript before 5.4. The state-management page now shows the `registerStore` import in each example.
