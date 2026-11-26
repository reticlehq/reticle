# A Linux desktop of its own for the agent: an X screen in memory, the accessibility bus, and the
# helper's needs. `reticle-computer --sandbox linux` builds it once and runs the application in
# it, so the agent works on its own screen and the person keeps theirs. Add your own applications
# with a Dockerfile that starts FROM this image.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-gi python3-gi-cairo gir1.2-atspi-2.0 gir1.2-gtk-3.0 at-spi2-core libatk-adaptor \
    xvfb xauth xdotool xprintidle dbus dbus-x11 curl ca-certificates \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*
