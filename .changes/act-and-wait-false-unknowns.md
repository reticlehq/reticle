### Fixed

- **`@reticlehq/server`, `@reticlehq/browser` — `act_and_wait` said `unknown` about text that a user could see.** Three causes are fixed:
  - An entrance fade or a toast that mounts at opacity 0 reads hidden for its first frame. The wait matched on that frame, and the verdict was `hidden_match`. Now a match that holds only on hidden nodes is read again for up to one second. The verdict uses the reading that shows the node. A node that stays hidden is still `hidden_match`.
  - On a hidden tab, a fade-in stops at its first frame. Visibility already reads it as shown. The unreadable-text check read the same frame as "composed opacity 0.00", and the verdict was `inconclusive` for the whole budget. The check now ignores the opacity of a fade that the hidden tab stopped.
  - MUI and react-modal hide the page behind an open menu or dialog with a bare `aria-hidden`. Text on that page read as hidden, and the verdict was `hidden_match`. The page now reads as on screen, the same as behind a Radix overlay. An `aria-hidden` that the app sets itself still hides.
