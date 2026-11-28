### Fixed

- **The computer realm on Linux clicks menus, covered shapes and file icons that a person can click.** These are the refusals found in the OSWorld benchmark:
  - A menu of the LibreOffice menu bar was refused. LibreOffice gives its menu bar twice, with boxes some pixels apart. A control with the same role and name, in the same window and at most 8 pixels away, now counts as the same control.
  - An item of an open menu in VLC (Qt) or Thunderbird (Gecko) was refused. Their open menu is not a window of the application, so the hit test now starts in the open menu.
  - GIMP (GTK2) never says that the items of an open menu are showing. The realm did not read them, and an assert did not find them. An item that is visible in the open menu (the menu with the focus) is now on the screen.
  - A shape on a slide of Impress with another shape over its middle was refused. The hit test now also tries eight other points of the element, and a click without a point goes to the first open one.
  - When the toolkit stops its hit test at a container, a point that a later child covers is no longer taken. A click on a covered button went to the button on top.
  - A file icon in Files was refused as disabled: the icon gives no enabled state. It now takes the state of what holds it.
