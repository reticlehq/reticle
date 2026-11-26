#!/usr/bin/env python3
# A small GTK application for atspicheck.mjs: a field, a button that writes what it saved, a check
# box, and a canvas ("Ink") where a drag draws a line that no element shows. A red bar beside the
# canvas moves by itself all the time, as a video does: its pixels must not count as an effect.
#
#   python3 native/linux/fixture.py
import gi

gi.require_version('Gtk', '3.0')
from gi.repository import GLib, Gtk  # noqa: E402

window = Gtk.Window(title='Reticle fixture')
window.set_default_size(460, 320)
window.move(80, 80)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
window.add(box)

field = Gtk.Entry()
field.get_accessible().set_name('Name')
status = Gtk.Label(label='Ready')
save = Gtk.Button(label='Save')
save.connect('clicked', lambda _b: status.set_text(f'Saved: {field.get_text()}'))
remember = Gtk.CheckButton(label='Remember')
for widget in (field, save, remember, status):
    box.pack_start(widget, False, False, 0)

row = Gtk.Box(spacing=6)
box.pack_start(row, True, True, 0)
ink = Gtk.DrawingArea()
ink.set_size_request(260, 160)
ink.get_accessible().set_name('Ink')
row.pack_start(ink, False, False, 0)
bar = Gtk.DrawingArea()
bar.set_size_request(100, 160)
row.pack_start(bar, False, False, 0)

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
