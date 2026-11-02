### Fixed

- When no scanned port serves a page, the no-session answer now names the ports that processes in the project's folder listen on, instead of saying that nothing is listening. An app on a port no file names is no longer reported as not running. The answer gives these ports no URL, because agent tools also listen in that folder. Linux and macOS only. (#1543)
