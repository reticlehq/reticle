#!/usr/bin/env python3
# A small GTK application for atspicheck.mjs: a menu bar, a field, a button that writes what it
# saved, a check box, a paragraph without a name, a notebook with a second page and a covered button, and a canvas ("Ink") where a drag draws a line
# that no element shows. A red bar beside the canvas moves by itself all the time, as a video
# does: its pixels must not count as an effect.
#
#   python3 native/linux/fixture.py
import gi

gi.require_version('Gtk', '3.0')
gi.require_version('Atk', '1.0')
from gi.repository import Atk, GLib, Gtk  # noqa: E402

window = Gtk.Window(title='Reticle fixture')
window.set_default_size(460, 320)
window.move(80, 80)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
window.add(box)

# A menu bar with a closed menu of many items, as LibreOffice has hundreds.
menus = Gtk.MenuBar()
file_item = Gtk.MenuItem(label='File')
file_menu = Gtk.Menu()
for k in range(40):
    file_menu.append(Gtk.MenuItem(label=f'Export {k}'))
file_item.set_submenu(file_menu)
menus.append(file_item)
box.pack_start(menus, False, False, 0)

field = Gtk.Entry()
field.get_accessible().set_name('Name')
status = Gtk.Label(label='Ready')
save = Gtk.Button(label='Save')
save.connect('clicked', lambda _b: status.set_text(f'Saved: {field.get_text()}'))
remember = Gtk.CheckButton(label='Remember')
# A paragraph as LibreOffice gives one: words, and no name.
words = Gtk.Label(label='Words without a name')
words.get_accessible().set_name('')
words.get_accessible().set_role(Atk.Role.PARAGRAPH)
for widget in (field, save, remember, status, words):
    box.pack_start(widget, False, False, 0)

# A notebook: the button on its second page is in the tree, and not on the screen, as the hidden
# menu bar of Thunderbird is.
pages = Gtk.Notebook()
# A button over the left part of another, as a shape on a slide of Impress covers part of another.
# A click on "Under" goes to its open part, and says so in the status.
cover = Gtk.Overlay()
under = Gtk.Button(label='Under')
under.set_size_request(110, -1)
under.connect('clicked', lambda _b: status.set_text('Under clicked'))
cover.add(under)
over = Gtk.Button(label='Over')
over.set_size_request(80, -1)
over.set_halign(Gtk.Align.START)
over.connect('clicked', lambda _b: status.set_text('Over clicked'))
cover.add_overlay(over)
pages.append_page(cover, Gtk.Label(label='One'))
pages.append_page(Gtk.Button(label='Behind'), Gtk.Label(label='Two'))

row = Gtk.Box(spacing=6)
box.pack_start(row, True, True, 0)
ink = Gtk.DrawingArea()
ink.set_size_request(260, 160)
ink.get_accessible().set_name('Ink')
row.pack_start(ink, False, False, 0)
bar = Gtk.DrawingArea()
bar.set_size_request(100, 160)
row.pack_start(bar, False, False, 0)
row.pack_start(pages, False, False, 0)

lines = []
last = {'at': None}
ink.add_events(0x100 | 0x200 | 0x4)  # button press, button release, pointer motion


def on_press(_w, event):
    last['at'] = (event.x, event.y)


def on_motion(_w, event):
    if last['at'] is not None:
        lines.append((last['at'], (event.x, event.y)))
        last['at'] = (event.x, event.y)
        ink.queue_draw()


def on_release(_w, _event):
    last['at'] = None


def draw_ink(_w, cr):
    cr.set_source_rgb(1, 1, 1)
    cr.paint()
    cr.set_source_rgb(0, 0, 0)
    cr.set_line_width(4)
    for (a, b) in lines:
        cr.move_to(*a)
        cr.line_to(*b)
        cr.stroke()


step = {'n': 0}


def draw_bar(_w, cr):
    cr.set_source_rgb(1, 0, 0)
    cr.rectangle(step['n'] * 3, 20, 8, 20)
    cr.fill()


def tick():
    step['n'] = (step['n'] + 1) % 30
    bar.queue_draw()
    return True


ink.connect('button-press-event', on_press)
ink.connect('motion-notify-event', on_motion)
ink.connect('button-release-event', on_release)
ink.connect('draw', draw_ink)
bar.connect('draw', draw_bar)
GLib.timeout_add(30, tick)
window.connect('destroy', Gtk.main_quit)
window.show_all()
Gtk.main()
