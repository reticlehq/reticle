#!/usr/bin/env python3
# reticle-atspi: the Linux helper of the computer realm. It reads an application through AT-SPI,
# the accessibility bus of the Linux desktop, and acts on it. It answers in the same shape as the
# macOS helper (reticle-ax) and the Windows helper (reticle-uia.ps1): the same commands, the same
# JSON, and the roles named as macOS names them, so the realm reads all three with one reader.
#
#   python3 reticle-atspi.py serve
#
# Each line on standard input is one command as a JSON list of words; each answer is one line.
#   apps
#   tree    <pid>
#   reach   <pid> <path> <role> <name>
#   act     <pid> <path> <role> <name> <kind> <value> <budgetMs> <delivery[:quietMs]>
#   capture <pid> <file> [screen]
#
# It needs PyGObject with the AT-SPI and GDK typelibs (python3-gi, gir1.2-atspi-2.0,
# gir1.2-gtk-3.0 on Debian and Ubuntu), and an X session with xdotool: the real pointer and keys
# go through XTest, which a Wayland session does not take from a program. The pointer events of
# AT-SPI itself did not reach the application under Xvfb; xdotool's did.
import json
import os
import shutil
import subprocess
import sys
import time

import gi

gi.require_version('Atspi', '2.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Atspi, Gdk  # noqa: E402

READ_LIMIT = 20000
SHORT_LIST = 200
# A container with more children than this is not read child by child: a sheet of Calc has a child
# for each cell, and to read them took minutes.
LONG_TABLE = 5000
QUIET_MS = 150
PICTURE_WIDTH = 240
STEP = 24

# AT-SPI role names, named as macOS names them. A role that is not here is read as AXGroup.
ROLE_OF = {
    'frame': 'AXWindow', 'window': 'AXWindow', 'dialog': 'AXWindow', 'alert': 'AXWindow',
    'file chooser': 'AXWindow', 'push button': 'AXButton', 'toggle button': 'AXButton',
    'button': 'AXButton', 'entry': 'AXTextField', 'password text': 'AXTextField',
    'text': 'AXTextArea', 'document text': 'AXTextArea', 'paragraph': 'AXStaticText',
    'label': 'AXStaticText', 'static': 'AXStaticText', 'caption': 'AXStaticText',
    'heading': 'AXHeading', 'check box': 'AXCheckBox', 'check menu item': 'AXMenuItem',
    'radio button': 'AXRadioButton', 'radio menu item': 'AXMenuItem', 'combo box': 'AXComboBox',
    'list': 'AXList', 'list box': 'AXList', 'list item': 'AXRow', 'table': 'AXTable',
    'tree table': 'AXOutline', 'tree': 'AXOutline', 'table row': 'AXRow', 'tree item': 'AXRow',
    'table cell': 'AXCell', 'menu': 'AXMenu', 'menu bar': 'AXMenuBar', 'menu item': 'AXMenuItem',
    'page tab list': 'AXTabGroup', 'page tab': 'AXRadioButton', 'link': 'AXLink',
    'image': 'AXImage', 'icon': 'AXImage', 'canvas': 'AXImage', 'drawing area': 'AXImage',
    'slider': 'AXSlider', 'scroll bar': 'AXScrollBar', 'progress bar': 'AXProgressIndicator',
    'tool bar': 'AXToolbar', 'scroll pane': 'AXScrollArea', 'separator': 'AXSplitter',
    'split pane': 'AXSplitGroup', 'spin button': 'AXIncrementor', 'document frame': 'AXWebArea',
    'document web': 'AXWebArea',
}

# Key names of the realm, as X key symbols.
KEY_OF = {
    'return': 'Return', 'enter': 'Return', 'escape': 'Escape', 'tab': 'Tab',
    'backspace': 'BackSpace', 'delete': 'Delete', 'arrowup': 'Up', 'arrowdown': 'Down',
    'arrowleft': 'Left', 'arrowright': 'Right', 'home': 'Home', 'end': 'End',
    'pageup': 'Page_Up', 'pagedown': 'Page_Down', 'space': 'space',
}
# The modifiers a key or a click holds, as xdotool names them. Meta is Control, as on Windows.
MOD_KEY = {'shift': 'shift', 'control': 'ctrl', 'ctrl': 'ctrl', 'meta': 'ctrl', 'alt': 'alt', 'option': 'alt'}
POINTER = ('click', 'dblclick', 'rightclick', 'hover', 'drag', 'wheel')


def answer(value):
    sys.stdout.write(json.dumps(value) + '\n')
    sys.stdout.flush()


def safe(call, default=None):
    try:
        return call()
    except Exception:  # noqa: BLE001 - an element can go away while it is read
        return default


def app_of(pid):
    desktop = Atspi.get_desktop(0)
    for k in range(desktop.get_child_count()):
        app = safe(lambda: desktop.get_child_at_index(k))
        if app is not None and safe(app.get_process_id) == pid:
            return app
    return None


def states(el):
    return safe(el.get_state_set)


def has(el, state, held=None):
    # `held` is a state set already read: each read is a call on the bus.
    s = held if held is not None else states(el)
    return s is not None and s.contains(state)


def role_of(el, held=None):
    name = safe(el.get_role_name, '') or ''
    role = ROLE_OF.get(name, 'AXGroup')
    # GTK names a one-line field and a text area both "text".
    if role == 'AXTextArea' and has(el, Atspi.StateType.SINGLE_LINE, held):
        return 'AXTextField'
    return role


def frame_of(el):
    component = safe(el.get_component_iface)
    box = safe(lambda: Atspi.Component.get_extents(component, Atspi.CoordType.SCREEN)) if component is not None else None
    if box is None or box.width <= 0 or box.height <= 0:
        return None
    return [box.x, box.y, box.width, box.height]


def windows_of(app):
    shown, away = [], 0
    for k in range(safe(app.get_child_count, 0)):
        w = safe(lambda: app.get_child_at_index(k))
        if w is None:
            continue
        if has(w, Atspi.StateType.ICONIFIED):
            away += 1
            continue
        if has(w, Atspi.StateType.SHOWING) or has(w, Atspi.StateType.VISIBLE):
            shown.append(w)
    return shown, away


def children_of(el):
    return [c for c in (safe(lambda k=k: el.get_child_at_index(k)) for k in range(safe(el.get_child_count, 0))) if c is not None]


def child_at(el, k):
    return safe(lambda: el.get_child_at_index(k))


def on_screen_cells(el):
    """The places of the cells of a long table that are on the screen, or None if it cannot tell.

    The cells at two corners of the table's box give the first and the last row and column.
    """
    table, component = safe(el.get_table_iface), safe(el.get_component_iface)
    box = frame_of(el)
    if table is None or component is None or box is None:
        return None
    x, y, width, height = box

    def cell_at(px, py):
        cell = safe(lambda: Atspi.Component.get_accessible_at_point(component, px, py, Atspi.CoordType.SCREEN))
        return safe(cell.get_index_in_parent, -1) if cell is not None else -1

    # A column header has no cell under it: step down from the top, and up from the bottom.
    first = next((k for k in (cell_at(x + 2, y + 2 + STEP * j) for j in range(8)) if k >= 0), -1)
    last = next((k for k in (cell_at(x + width - 3, y + height - 3 - STEP * j) for j in range(8)) if k >= 0), -1)
    at = [first, last]
    if min(at) < 0:
        return None
    # A point on a column header is in no row: the rows start at the first one.
    rows = [max(0, safe(lambda i=i: Atspi.Table.get_row_at_index(table, i), 0)) for i in at]
    columns = [max(0, safe(lambda i=i: Atspi.Table.get_column_at_index(table, i), 0)) for i in at]
    places = []
    for r in range(rows[0], rows[1] + 1):
        for c in range(columns[0], columns[1] + 1):
            cell = safe(lambda r=r, c=c: Atspi.Table.get_accessible_at(table, r, c))
            place = safe(cell.get_index_in_parent, -1) if cell is not None else -1
            if place >= 0:
                places.append(place)
            if len(places) >= LONG_TABLE:
                return places
    return places


def value_of(el, role, held=None):
    if has(el, Atspi.StateType.CHECKABLE, held) or role in ('AXCheckBox', 'AXRadioButton'):
        return '1' if has(el, Atspi.StateType.CHECKED, held) else '0'
    text = safe(el.get_text_iface)
    # A static text gives its words as its value, as on macOS: a paragraph of LibreOffice has no name.
    if text is not None and role in ('AXTextField', 'AXTextArea', 'AXComboBox', 'AXStaticText'):
        count = safe(lambda: Atspi.Text.get_character_count(text), 0)
        return safe(lambda: Atspi.Text.get_text(text, 0, min(4000, count)), '')
    value = safe(el.get_value_iface)
    if value is not None:
        return str(safe(lambda: Atspi.Value.get_current_value(value), ''))
    return None


class Reader:
    def __init__(self):
        self.budget = READ_LIMIT
        self.unread = 0

    def node(self, el, depth):
        held = states(el)
        role = role_of(el, held)
        node = {'role': role}
        name = safe(el.get_name, '')
        if name:
            node['title'] = name
        help_text = safe(el.get_description, '')
        if help_text:
            node['help'] = help_text
        ident = safe(el.get_accessible_id, '')
        if ident:
            node['id'] = ident
        node['enabled'] = has(el, Atspi.StateType.ENABLED, held) or has(el, Atspi.StateType.SENSITIVE, held)
        node['focused'] = has(el, Atspi.StateType.FOCUSED, held)
        frame = frame_of(el)
        if frame is not None:
            node['frame'] = frame
        value = value_of(el, role, held)
        if value is not None:
            node['value'] = value
        if has(el, Atspi.StateType.SELECTED, held):
            node['selected'] = True
        count = safe(el.get_child_count, 0) if depth < 80 else 0
        if count > LONG_TABLE:
            # ponytail: no table interface or no cell at a corner, so the first children stand for the
            # rest. GTK says every cell is showing, so their states tell nothing.
            places = on_screen_cells(el)
            if places is None:
                places = list(range(SHORT_LIST))
            node['notShown'] = count - len(places)
            kids = [child_at(el, k) for k in places]
            return self.fill(node, kids, places, depth)
        kids = children_of(el) if depth < 80 else []
        places = None
        # A long list gives the items on the screen, with their places, and says how many it left out.
        # A menu gives only the items on the screen: a closed menu gives none, and says how many.
        # LibreOffice has hundreds of items in closed menus, and to read them took seconds.
        listed = len(kids) > SHORT_LIST and role in ('AXList', 'AXTable', 'AXOutline')
        if listed or (role == 'AXMenu' and kids):
            places = [k for k, c in enumerate(kids) if has(c, Atspi.StateType.SHOWING)]
            if listed or len(places) < len(kids):
                node['notShown'] = len(kids) - len(places)
                kids = [kids[k] for k in places]
            else:
                places = None
        return self.fill(node, kids, places, depth)

    def fill(self, node, kids, places, depth):
        if self.budget <= 0 and kids:
            node['notShown'] = node.get('notShown', 0) + len(kids)
            node['children'] = []
            return node
        self.budget -= len(kids)
        children = []
        for k, kid in enumerate(kids):
            try:
                one = self.node(kid, depth + 1)
            except Exception:  # noqa: BLE001
                self.unread += 1
                one = {'role': '', 'children': []}
            if places is not None:
                one['i'] = places[k]
            children.append(one)
        node['children'] = children
        return node


def read_app(pid):
    app = app_of(pid)
    if app is None:
        return None
    reader = Reader()
    shown, away = windows_of(app)
    return {
        'tree': {'role': 'AXApplication', 'title': safe(app.get_name, ''),
                 'children': [reader.node(w, 1) for w in shown]},
        'unread': reader.unread,
        'windowsNotOnScreen': away,
    }


def find(pid, path):
    places = [int(p) for p in path.split('.') if p != '']
    if not places:
        return {'app': True}
    app = app_of(pid)
    if app is None:
        return None
    shown, _ = windows_of(app)
    if places[0] >= len(shown):
        return None
    el = shown[places[0]]
    for place in places[1:]:
        # One child by its place: a sheet of Calc has a child for each cell.
        if place >= safe(el.get_child_count, 0):
            return None
        el = child_at(el, place)
        if el is None:
            return None
    return {'el': el}


def same(a, b):
    # ponytail: AT-SPI gives no identity to compare; the role, the name and the box stand for it.
    return role_of(a) == role_of(b) and safe(a.get_name) == safe(b.get_name) and frame_of(a) == frame_of(b)


def point_child(el, x, y):
    component = safe(el.get_component_iface)
    if component is None:
        return None
    return safe(lambda: Atspi.Component.get_accessible_at_point(component, x, y, Atspi.CoordType.SCREEN))


def reach(el, pid):
    frame = frame_of(el)
    if frame is None:
        return {'reach': 'unknown', 'detail': 'the element has no place on the screen'}
    x, y = frame[0] + frame[2] // 2, frame[1] + frame[3] // 2
    app = app_of(pid)
    shown, _ = windows_of(app) if app is not None else ([], 0)
    for w in shown:
        at = point_child(w, x, y)
        for _ in range(40):
            if at is None:
                break
            if same(at, el):
                return {'reach': 'yes'}
            deeper = point_child(at, x, y)
            if deeper is None or same(deeper, at):
                break
            at = deeper
        # The element holds the point it was hit at: what was hit is inside it.
        hit = frame_of(at) if at is not None else None
        if hit is not None and frame[0] <= hit[0] and frame[1] <= hit[1] and \
                hit[0] + hit[2] <= frame[0] + frame[2] and hit[1] + hit[3] <= frame[1] + frame[3]:
            return {'reach': 'yes'}
    return {'reach': 'unknown', 'detail': 'the hit test did not find the element'}


def wait_quiet(pid, budget_ms, quiet_ms):
    started = time.monotonic()
    last = json.dumps(read_app(pid))
    quiet_since = time.monotonic()
    while (time.monotonic() - started) * 1000 < budget_ms:
        time.sleep(0.05)
        now = json.dumps(read_app(pid))
        if now != last:
            last, quiet_since = now, time.monotonic()
            continue
        if (time.monotonic() - quiet_since) * 1000 >= quiet_ms:
            return True
    return False


def xdo(*words):
    subprocess.run(['xdotool', *[str(w) for w in words]], check=True, timeout=10)


def move(x, y):
    xdo('mousemove', int(x), int(y))


def click(x, y, times, button, hold_ms):
    move(x, y)
    for _ in range(times):
        if hold_ms > 0:
            xdo('mousedown', button)
            time.sleep(hold_ms / 1000)
            xdo('mouseup', button)
        else:
            xdo('click', button)


def no_real_input():
    # Why the real pointer and keys cannot be used here, or None when they can. A Wayland session
    # takes no input from a program; xdotool reaches only X.
    if os.environ.get('XDG_SESSION_TYPE') == 'wayland' or (
            os.environ.get('WAYLAND_DISPLAY') and not os.environ.get('DISPLAY')):
        return 'this Linux session is Wayland, which takes no pointer and no keys from a program'
    if not os.environ.get('DISPLAY'):
        return 'there is no X display (DISPLAY is not set)'
    if shutil.which('xdotool') is None:
        return 'xdotool is not installed (sudo apt-get install xdotool)'
    return None


def idle_ms():
    # ponytail: xprintidle reads the idle time of the X server. Without it there is no check.
    if shutil.which('xprintidle') is None:
        return 10 ** 9
    try:
        return int(subprocess.run(['xprintidle'], capture_output=True, text=True, timeout=5).stdout.strip())
    except (ValueError, subprocess.SubprocessError):
        return 10 ** 9


def arrange(pid, value):
    # The window of the application, moved and sized as X moves it: through the window manager when
    # there is one, and directly when there is none (a screen in memory).
    found = subprocess.run(['xdotool', 'search', '--onlyvisible', '--pid', str(pid)],
                           capture_output=True, text=True, timeout=10).stdout.split()
    if not found:
        return None
    wid = found[0]
    width, height = (int(n) for n in subprocess.run(['xdotool', 'getdisplaygeometry'], capture_output=True,
                                                     text=True, timeout=10).stdout.split())
    frames = {'left': (0, 0, width // 2, height), 'right': (width // 2, 0, width // 2, height),
              'zoom': (0, 0, width, height), 'fullscreen': (0, 0, width, height)}
    wanted = None
    if value == 'minimize':
        xdo('windowminimize', wid)
    elif value == 'restore':
        xdo('windowmap', wid)
    elif value in frames or value.startswith('frame:'):
        wanted = list(frames.get(value) or [int(float(n)) for n in value[len('frame:'):].split(',')])
        xdo('windowmove', wid, wanted[0], wanted[1])
        xdo('windowsize', wid, wanted[2], wanted[3])
    else:
        return None
    return {'pid': pid, 'wid': wid, 'wanted': wanted}


def window_state(arranged):
    # Read again after the change: the answer of X to a move is not the proof that it moved.
    shell = subprocess.run(['xdotool', 'getwindowgeometry', '--shell', arranged['wid']],
                           capture_output=True, text=True, timeout=10).stdout
    geometry = dict(line.split('=', 1) for line in shell.split() if '=' in line)
    shown = subprocess.run(['xdotool', 'search', '--onlyvisible', '--pid', str(arranged['pid'])],
                           capture_output=True, text=True, timeout=10).stdout.split()
    state = {'minimized': arranged['wid'] not in shown, 'fullscreen': False}
    if all(k in geometry for k in ('X', 'Y', 'WIDTH', 'HEIGHT')):
        state['frame'] = [int(geometry[k]) for k in ('X', 'Y', 'WIDTH', 'HEIGHT')]
    if arranged['wanted'] is not None:
        state['wanted'] = arranged['wanted']
    return state


def key_to_window(pid, el, value):
    if no_real_input() is not None:
        return False
    found = subprocess.run(['xdotool', 'search', '--onlyvisible', '--pid', str(pid)],
                           capture_output=True, text=True, timeout=10).stdout.split()
    if not found:
        return False
    # Only when it does not have it: GTK chooses all the text of a field that takes the focus,
    # and a Backspace then cleared the whole field.
    component = safe(el.get_component_iface) if el is not None else None
    if component is not None and not has(el, Atspi.StateType.FOCUSED):
        safe(lambda: Atspi.Component.grab_focus(component))
    parts = value.split('+')
    key = parts[-1]
    name = KEY_OF.get(key.lower(), key if len(key) == 1 else key.capitalize())
    xdo('key', '--window', found[0], '+'.join([*mods_of(parts[:-1]), name]))
    return True


def mods_of(words):
    return [MOD_KEY[m.lower()] for m in words if m.lower() in MOD_KEY]


def press_key(value):
    parts = value.split('+')
    key = parts[-1]
    name = KEY_OF.get(key.lower(), key if len(key) == 1 else key.capitalize())
    xdo('key', '--clearmodifiers', '+'.join([*mods_of(parts[:-1]), name]))


def middle_of(el):
    frame = frame_of(el) or [0, 0, 0, 0]
    return frame[0] + frame[2] / 2, frame[1] + frame[3] / 2


def press(el):
    action = safe(el.get_action_iface)
    count = safe(lambda: Atspi.Action.get_n_actions(action), 0) if action is not None else 0
    names = [safe(lambda k=k: Atspi.Action.get_action_name(action, k), '') for k in range(count)]
    for k, name in enumerate(names):
        if name in ('click', 'press', 'activate', 'toggle', 'jump'):
            return bool(safe(lambda k=k: Atspi.Action.do_action(action, k), False))
    if count > 0:
        return bool(safe(lambda: Atspi.Action.do_action(action, 0), False))
    # The words of a row: the row or the list that holds them chooses it, as a click chooses it.
    up = safe(el.get_parent)
    for _ in range(4):
        if up is None:
            break
        holder = safe(up.get_parent)
        index = safe(up.get_index_in_parent)
        if holder is not None and index is not None and safe(lambda: holder.select_child(index), False):
            return True
        up = holder
    return False


def set_value(el, value):
    try:
        number = float(value)
    except ValueError:
        number = None
    holder = safe(el.get_value_iface)
    if number is not None and holder is not None and safe(lambda: Atspi.Value.set_current_value(holder, number), False):
        return True
    editable = safe(el.get_editable_text_iface)
    return editable is not None and bool(safe(lambda: Atspi.EditableText.set_text_contents(editable, value), False))


def front_pid():
    desktop = Atspi.get_desktop(0)
    for k in range(desktop.get_child_count()):
        app = safe(lambda: desktop.get_child_at_index(k))
        if app is None:
            continue
        for w in children_of(app):
            if has(w, Atspi.StateType.ACTIVE):
                return safe(app.get_process_id)
    return None


# Pictures of the screen, made small, and what changed between them.
def shot(x, y, w, h):
    root = Gdk.get_default_root_window()
    pix = safe(lambda: Gdk.pixbuf_get_from_window(root, int(x), int(y), int(w), int(h)))
    if pix is None:
        return None
    pw = min(PICTURE_WIDTH, int(w))
    ph = max(1, int(h) * pw // int(w))
    small = pix.scale_simple(pw, ph, 2)  # GdkPixbuf.InterpType.BILINEAR
    return {'bytes': small.get_pixels(), 'w': pw, 'h': ph, 'stride': small.get_rowstride(),
            'n': small.get_n_channels()}


def moved(a, b):
    if a is None or b is None or a['w'] != b['w'] or a['h'] != b['h']:
        return None
    out = bytearray(a['w'] * a['h'])
    for y in range(a['h']):
        ra, rb = y * a['stride'], y * b['stride']
        for x in range(a['w']):
            pa, pb = ra + x * a['n'], rb + x * b['n']
            if abs(a['bytes'][pa] - b['bytes'][pb]) > STEP or abs(a['bytes'][pa + 1] - b['bytes'][pb + 1]) > STEP \
                    or abs(a['bytes'][pa + 2] - b['bytes'][pb + 2]) > STEP:
                out[y * a['w'] + x] = 1
    return out


def change(earlier, before, after, later, wx, wy, ww, wh):
    diff = moved(before, after)
    if diff is None:
        return {'changed': 1.0, 'box': [wx, wy, ww, wh]}
    w, h = before['w'], before['h']
    mask = bytearray(w * h)
    # What moved between the two pictures of each pair moves by itself (a video, a spinner): it is
    # made a little wider, and left out of the change.
    for self_moved in (moved(earlier, before), moved(after, later)):
        if self_moved is None:
            continue
        for p, on in enumerate(self_moved):
            if not on:
                continue
            y, x = divmod(p, w)
            for yy in range(max(0, y - 2), min(h, y + 3)):
                for xx in range(max(0, x - 2), min(w, x + 3)):
                    mask[yy * w + xx] = 1
    count = moving = 0
    min_x, min_y, max_x, max_y = w, h, -1, -1
    for p in range(w * h):
        if mask[p]:
            moving += 1
            continue
        if not diff[p]:
            continue
        count += 1
        y, x = divmod(p, w)
        min_x, max_x, min_y, max_y = min(min_x, x), max(max_x, x), min(min_y, y), max(max_y, y)
    result = {'changed': round(count / (w * h), 4)}
    if moving:
        result['moving'] = round(moving / (w * h), 4)
    if count:
        sx, sy = ww / w, wh / h
        result['box'] = [round(wx + min_x * sx), round(wy + min_y * sy),
                         round((max_x - min_x + 1) * sx), round((max_y - min_y + 1) * sy)]
    return result


def act(words):
    pid, path, role, name, kind, value = int(words[1]), words[2], words[3], words[4], words[5], words[6]
    budget_ms = int(words[7])
    how = words[8].split(':')
    quiet = int(how[1]) if len(how) > 1 else QUIET_MS
    foreground, direct = how[0] == 'foreground', how[0] == 'direct'
    if app_of(pid) is None:
        return {'error': 'app-gone'}
    found = find(pid, path)
    if found is None:
        return {'refused': 'stale', 'detail': 'no element at the path'}
    el = found.get('el')
    if el is not None:
        if role_of(el) != role or (safe(el.get_name, '') or '') != name:
            return {'refused': 'stale', 'detail': 'a different element is at the path'}
        enabled = has(el, Atspi.StateType.ENABLED) or has(el, Atspi.StateType.SENSITIVE)
        if not enabled and kind != 'raise':
            return {'refused': 'disabled'}
    pointer = kind in POINTER
    if pointer and not foreground:
        return {'refused': 'needs-foreground'}
    no_input = no_real_input()
    if no_input is not None and (pointer or kind == 'window' or (foreground and kind in ('type', 'key'))):
        return {'refused': 'no-real-input', 'detail': no_input}
    # A pointer value is its points, then the hand: "x,y|mods=shift+alt|hold=300|pixels=1".
    hand = {}
    if pointer:
        parts = str(value).split('|')
        value = parts[0]
        for part in parts[1:]:
            pair = part.split('=', 1)
            if len(pair) == 2:
                hand[pair[0]] = pair[1]
    held = mods_of(hand.get('mods', '').split('+'))
    hold_ms = min(10000, max(0, int(hand.get('hold', '0') or 0)))
    # The person at the machine is typing or moving the pointer: wait, and refuse when they still are.
    if foreground and idle_ms() < 800:
        time.sleep(0.8)
        if idle_ms() < 800:
            return {'refused': 'person-active', 'detail': 'the person at the machine is typing or moving the pointer'}
    rch = reach(el, pid) if el is not None else {'reach': 'yes'}
    if rch['reach'] != 'yes' and not direct and kind not in ('raise', 'window') and pointer:
        if rch['reach'] == 'no':
            return {'refused': 'unreachable', 'detail': rch.get('detail')}
        return {'refused': 'reach-unknown', 'detail': rch.get('detail')}
    before = read_app(pid)
    shots = None
    if pointer and kind != 'hover' and hand.get('pixels') == '1':
        shown, _ = windows_of(app_of(pid))
        wr = frame_of(shown[0]) if shown else None
        if wr is not None:
            shots = {'rect': wr, 'earlier': shot(*wr)}
            time.sleep(0.1)
            shots['before'] = shot(*wr)
    for m in held:
        xdo('keydown', m)
    delivered = True
    arranged = None
    try:
        if kind == 'press':
            delivered = press(el)
        elif kind == 'set':
            delivered = set_value(el, value)
        elif kind == 'raise':
            target = el if el is not None else (windows_of(app_of(pid))[0] or [None])[0]
            component = safe(target.get_component_iface) if target is not None else None
            delivered = component is not None and bool(safe(lambda: Atspi.Component.grab_focus(component), False))
        elif kind in ('type', 'key'):
            if not foreground and kind == 'type':
                # Text in the background goes to the field as its value.
                delivered = set_value(el, value)
            elif not foreground:
                # A key in the background goes to the window of the application alone, as an X
                # event sent to that window: the pointer and the keyboard of the person are not used.
                # The element takes the focus of its window first, as a click in it does.
                delivered = key_to_window(pid, el, value)
            elif front_pid() not in (None, pid):
                return {'refused': 'no-keyboard'}
            elif kind == 'type':
                xdo('type', '--delay', 8, '--', value)
            else:
                press_key(value)
        elif kind in ('click', 'dblclick', 'rightclick', 'hover'):
            xy = [v for v in str(value).split(',') if v != '']
            x, y = (float(xy[0]), float(xy[1])) if len(xy) >= 2 else middle_of(el)
            if kind == 'hover':
                move(x, y)
            else:
                # "count=3" is a triple-click, "button=middle" the middle button.
                times = 2 if kind == 'dblclick' else min(3, max(1, int(hand.get('count', '1') or 1)))
                button = 3 if kind == 'rightclick' else (2 if hand.get('button') == 'middle' else 1)
                click(x, y, times, button, hold_ms)
        elif kind == 'drag':
            # Two numbers: the end, from the middle of the element. Four or more: a path, from its
            # first point. The pointer walks each part in small steps, as a hand moves.
            n = [float(v) for v in str(value).split(',') if v != '']
            way = [middle_of(el)] if len(n) == 2 else []
            way += [(n[k], n[k + 1]) for k in range(0, len(n) - 1, 2)]
            if len(way) < 2:
                return {'error': 'a drag needs an end'}
            move(*way[0])
            xdo('mousedown', 1)
            if hold_ms:
                time.sleep(hold_ms / 1000)
            for a, b in zip(way, way[1:]):
                steps = max(4, min(40, int(((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5 / 6)))
                for s in range(1, steps + 1):
                    move(a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps)
                    time.sleep(0.008)
            xdo('mouseup', 1)
        elif kind == 'wheel':
            n = str(value).split(',')
            x, y = (float(n[1]), float(n[2])) if len(n) >= 3 else middle_of(el)
            move(x, y)
            lines = float(n[0] or 0)
            for _ in range(int(abs(lines) // 3) or (1 if lines else 0)):
                xdo('click', 5 if lines > 0 else 4)
            # "across=5" turns the wheel to the side: more than 0 is to the right.
            across = int(hand.get('across', '0') or 0)
            for _ in range(abs(across) // 3 or (1 if across else 0)):
                xdo('click', 7 if across > 0 else 6)
        elif kind == 'window':
            arranged = arrange(pid, value)
            delivered = arranged is not None
        else:
            return {'error': f'unknown-action {kind}'}
    except Exception as error:  # noqa: BLE001
        delivered = False
        last_error = str(error)
    else:
        last_error = None
    finally:
        for m in held:
            xdo('keyup', m)
    settled = wait_quiet(pid, budget_ms, quiet)
    after = read_app(pid)
    if after is None:
        return {'delivered': delivered, 'reachable': True, 'settled': settled, 'appGone': True,
                'before': before['tree'], 'after': {'role': 'AXApplication', 'children': []},
                'unreadBefore': before['unread'], 'unreadAfter': 0}
    result = {'delivered': delivered, 'reachable': rch['reach'] == 'yes', 'settled': settled,
              'before': before['tree'], 'after': after['tree'], 'unreadBefore': before['unread'],
              'unreadAfter': after['unread']}
    if shots is not None:
        wr = shots['rect']
        seen = shot(*wr)
        time.sleep(0.1)
        later = shot(*wr)
        result['pixels'] = change(shots['earlier'], shots['before'], seen, later, *wr)
    if arranged is not None:
        result['windowState'] = window_state(arranged)
    if os.environ.get('RETICLE_ATSPI_DEBUG') and last_error:
        result['atspiError'] = last_error
    return result


def capture(words):
    pid, path, screen = int(words[1]), words[2], len(words) > 3 and words[3] == 'screen'
    app = app_of(pid)
    shown, _ = windows_of(app) if app is not None else ([], 0)
    frame = frame_of(shown[0]) if shown else None
    if frame is None:
        return {'ok': False, 'reason': 'the application has no window on the screen'}
    root = Gdk.get_default_root_window()
    area = [0, 0, root.get_width(), root.get_height()] if screen else frame
    pix = Gdk.pixbuf_get_from_window(root, *area)
    if pix is None:
        return {'ok': False, 'reason': 'the screen could not be read'}
    pix.savev(path, 'png', [], [])
    result = {'ok': True, 'window': area, 'scale': 1}
    if screen:
        result['appWindow'] = frame
    return result


def command(words):
    if words[0] == 'apps':
        desktop = Atspi.get_desktop(0)
        apps = []
        for k in range(desktop.get_child_count()):
            app = safe(lambda k=k: desktop.get_child_at_index(k))
            if app is not None and windows_of(app)[0]:
                name = safe(app.get_name, '')
                apps.append({'name': name, 'process': name, 'pid': safe(app.get_process_id), 'regular': True})
        return {'apps': apps}
    if words[0] == 'tree':
        read = read_app(int(words[1]))
        return {'error': 'app-gone'} if read is None else read
    if words[0] == 'reach':
        found = find(int(words[1]), words[2])
        if found is None or found.get('el') is None:
            return {'refused': 'stale'}
        return reach(found['el'], int(words[1]))
    if words[0] == 'act':
        return act(words)
    if words[0] == 'capture':
        return capture(words)
    return {'error': 'usage'}


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'serve':
        for line in sys.stdin:
            try:
                answer(command([str(w) for w in json.loads(line)]))
            except Exception as error:  # noqa: BLE001
                answer({'error': str(error)})
    else:
        answer(command(sys.argv[1:]))


if __name__ == '__main__':
    main()
