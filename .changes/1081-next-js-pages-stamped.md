### Fixed

- **`@reticlehq/next`: a JavaScript Next.js project gets source locations.** create-next-app's JavaScript template writes every page as `.js`, and `withReticle` only stamped `.tsx` and `.jsx`, so no element in those apps had a `file:line` and every verdict reported `no-source-mapping`. `.js` files with JSX are now stamped on webpack and on Turbopack; a `.js` file with no JSX is passed through without being parsed, and on Turbopack the rule leaves `node_modules` alone (Next 16 and later). Closes #1081.
