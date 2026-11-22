// A small Electron application for native/mac/electroncheck.mjs. Nothing of Reticle is in it.
//   Add   puts the text of the field in the list, and counts the notes.
//   Slow  changes the count text after 400 ms.
//   Dead  does nothing.
//   Priority  a list of two choices.  Pinned  a checkbox.
import { app, BrowserWindow } from 'electron';

const page = `<h1>Notes</h1>
<input aria-label="New note">
<button id="add" title="Adds the note">Add</button><button id="slow">Slow</button><button>Dead</button>
<select aria-label="Priority"><option>Low</option><option>High</option></select>
<label><input type="checkbox"> Pinned</label>
<p id="count">0 notes</p><ul></ul>
<script>
  const count = document.querySelector('#count');
  document.querySelector('#add').onclick = () => {
    const item = document.createElement('li');
    item.textContent = document.querySelector('input').value;
    document.querySelector('ul').append(item);
    count.textContent = document.querySelectorAll('li').length + ' notes';
  };
  document.querySelector('#slow').onclick = () => setTimeout(() => (count.textContent = 'slow done'), 400);
</script>`;

// A page for native/mac/layercheck.mjs: an empty layer over the whole window that clicks pass
// through, as Discord's layer for popups, a dialog with a backdrop that clicks do not pass, and a
// popup with a backdrop and no mark of a dialog.
const LAYERS = `<h1>Layers</h1>
<button id="go">Go</button><button id="open">Open dialog</button><button id="menu">Open menu</button>
<p id="count">0 clicks</p>
<div class="layerContainer" style="position:fixed;inset:0;pointer-events:none;z-index:10"></div>
<div id="backdrop" hidden style="position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:20"></div>
<div id="dialog" role="dialog" aria-label="Settings" hidden
  style="position:fixed;top:30px;left:200px;z-index:30;background:#fff;padding:12px">
  <button id="ok">Done</button></div>
<div id="popup" hidden style="position:fixed;inset:0;z-index:40">
  <div style="position:absolute;inset:0;background:rgba(0,0,0,.3)"></div>
  <div style="position:absolute;top:30px;left:200px;background:#fff;padding:12px">
    <button id="keep">Keep</button></div></div>
<script>
  let clicks = 0;
  const count = document.querySelector('#count');
  document.querySelector('#go').onclick = () => (count.textContent = ++clicks + ' clicks');
  document.querySelector('#open').onclick = () => {
    document.querySelector('#backdrop').hidden = false;
    document.querySelector('#dialog').hidden = false;
  };
  document.querySelector('#menu').onclick = () => (document.querySelector('#popup').hidden = false);
  document.querySelector('#keep').onclick = () => {
    document.querySelector('#popup').hidden = true;
    count.textContent = 'kept';
  };
  document.querySelector('#ok').onclick = () => (count.textContent = 'dialog done');
</script>`;
const PAGE = 'layers' === process.env['RETICLE_FIXTURE_PAGE'] ? LAYERS : page;

// Not in the Dock and not in front: the person at the machine keeps the application they use.
// With RETICLE_FIXTURE_REGULAR it is an ordinary application with a menu bar, for the check of
// the menu bar. That check brings it to the front.
const REGULAR = '1' === process.env['RETICLE_FIXTURE_REGULAR'];
if (!REGULAR) {
  app.setActivationPolicy('accessory');
}

void app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 420, height: 320, title: 'Notes', show: false });
  // Over the other windows, and not the one that takes the keyboard: the realm presses only what
  // a person could press, and a run must not take the keyboard of the person at the machine.
  window.setAlwaysOnTop(true, 'floating');
  window.setVisibleOnAllWorkspaces(true);
  window.showInactive();
  void window.loadURL(`data:text/html,${encodeURIComponent(PAGE)}`);
});
app.on('window-all-closed', () => app.quit());
