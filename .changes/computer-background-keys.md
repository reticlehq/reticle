### Added

- **`@reticlehq/computer` — keys in the background on Windows and Linux.** A key without the foreground now goes to the window of the application alone, as on macOS: Windows posts it to the window of the control, and Linux sends it to the X window with `xdotool`. The pointer and the keyboard of the person are not used, and the window does not come to the front. On Windows a key with a modifier is not delivered in the background. On Linux the field takes the focus of its window only when it does not have it, because GTK chooses all the text of a field that takes the focus.
