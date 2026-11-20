// A small Electron application for native/mac/electroncheck.mjs. Nothing of Reticle is in it.
//   Add   puts the text of the field in the list, and counts the notes.
//   Slow  changes the count text after 400 ms.
//   Dead  does nothing.
//   Priority  a list of two choices.  Pinned  a checkbox.
import { app, BrowserWindow } from 'electron';

const page = `<h1>Notes</h1>
<input aria-label="New note">
<button id="add">Add</button><button id="slow">Slow</button><button>Dead</button>
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

// Not in the Dock and not in front: the person at the machine keeps the application they use.
app.setActivationPolicy('accessory');

void app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 420, height: 320, title: 'Notes', show: false });
  // Over the other windows, and not the one that takes the keyboard: the realm presses only what
  // a person could press, and a run must not take the keyboard of the person at the machine.
  window.setAlwaysOnTop(true, 'floating');
  window.setVisibleOnAllWorkspaces(true);
  window.showInactive();
  void window.loadURL(`data:text/html,${encodeURIComponent(page)}`);
});
app.on('window-all-closed', () => app.quit());
