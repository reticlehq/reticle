### Fixed

- **`@reticlehq/browser` — clicking a link was blocked as destructive because of the text it showed.** An issue link titled "Checkout pay fails" was refused as a payment. A link that goes somewhere is now judged by where it goes (`/account/delete` is still guarded); one that goes nowhere (`#`, `javascript:`) is still judged by its text.
