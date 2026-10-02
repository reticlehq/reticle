// The pairing token travels in <meta name="reticle-pairing-*">, not vite.define
// (that channel does not reach Astro's client pipeline on 7.2+, so the identifier
// stays literal in the served module). A processed page <script> imports the SDK
// and reads the meta tags, so there is no injected global left to declare.
