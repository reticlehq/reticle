### Fixed

- **`@reticlehq/core`, `@reticlehq/server` — a check whose request was made read "no request was made".** A net check with a body clause (`requestBodyMatches`, `bodyContains`…) that failed on a call that DID fire was titled "No POST request to /api/orders was made". The sentence now reads the verdict's assertion: "A POST request to /api/orders was made, but it did not carry {"promoCode":"SAVE20"}".
