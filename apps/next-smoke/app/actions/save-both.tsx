'use client';

import { addNote, addTag } from './actions';

/** ONE user action, TWO Server Actions: the double write #1121 reported as a false duplicate. */
async function saveBoth(): Promise<void> {
  const note = new FormData();
  note.set('note', 'note from one click');
  const tag = new FormData();
  tag.set('tag', 'tag from one click');
  await addNote(note);
  await addTag(tag);
}

export function SaveBoth() {
  return (
    <button data-testid="save-both" type="button" onClick={() => void saveBoth()}>
      Save both
    </button>
  );
}
