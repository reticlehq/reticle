#!/usr/bin/env python3
# A GTK application with one table of 200,000 rows for atspicheck.mjs. Its table gives the
# accessibility bus one child for each cell, as a sheet of LibreOffice Calc gives a child for each
# cell of the sheet. Only the cells on the screen can be read in the time an act has.
#
#   python3 native/linux/bigtable.py
import gi

gi.require_version('Gtk', '3.0')
from gi.repository import Gtk  # noqa: E402

ROWS = 200_000
store = Gtk.ListStore(str, str, str)
for r in range(ROWS):
    store.append([f'r{r}c0', f'r{r}c1', f'r{r}c2'])
table = Gtk.TreeView(model=store)
for c in range(3):
    table.append_column(Gtk.TreeViewColumn(f'Column {c}', Gtk.CellRendererText(), text=c))
scroll = Gtk.ScrolledWindow()
scroll.add(table)
window = Gtk.Window(title='Reticle big table')
window.set_default_size(360, 300)
window.move(700, 80)
window.add(scroll)
window.connect('destroy', Gtk.main_quit)
window.show_all()
Gtk.main()
