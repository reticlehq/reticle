### Fixed

`act_and_wait` now passes the declared network URLs to the contradiction engine, so an unrelated background duplicate POST is reported without downgrading the verdict. Replay verification also reports advisory duplicates without treating them as failed writes.
