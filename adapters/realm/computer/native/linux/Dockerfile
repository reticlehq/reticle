# A Linux desktop of its own for the agent: an X screen in memory, the accessibility bus, and the
# helper's needs. `reticle-computer --sandbox linux` builds it once and runs the application in
# it, so the agent works on its own screen and the person keeps theirs. Add your own applications
# with a Dockerfile that starts FROM this image.
# Pinned by digest, so a rebuild gets the same base image. Update the digest with the tag.
FROM ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-gi python3-gi-cairo gir1.2-atspi-2.0 gir1.2-gtk-3.0 at-spi2-core libatk-adaptor \
    xvfb xauth xdotool xprintidle dbus dbus-x11 curl ca-certificates xz-utils \
  && rm -rf /var/lib/apt/lists/*
# Node from nodejs.org, checked against its published SHA-256 before it is unpacked. No script
# from the network runs.
ARG NODE_VERSION=22.23.5
RUN arch="$(dpkg --print-architecture)" \
  && case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "no Node for $arch" >&2; exit 1 ;; esac \
  && file="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
  && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${file}" \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${file}\$" | sha256sum -c - \
  && tar -xJf "$file" -C /usr/local --strip-components=1 --no-same-owner \
  && rm "$file" \
  && node --version
