'use server';

import { revalidatePath } from 'next/cache';
import { notes, tags } from './store';

/**
 * TWO distinct Server Actions, both writing to `/actions`.
 *
 * React posts each to the page's OWN url with its own `Next-Action` header and a multipart body —
 * no fetch in the app's code, no JSON response, and no body fingerprint Reticle can compute. Two of
 * them fired by one user action are the shape #1121 reported: distinct writes that method plus URL
 * cannot tell apart until the header joins the identity. `SaveBoth` fires both from one click.
 */
export async function addNote(formData: FormData): Promise<void> {
  const text = String(formData.get('note') ?? '').trim();
  if (text.length > 0) notes.push(text);
  revalidatePath('/actions');
}

export async function addTag(formData: FormData): Promise<void> {
  const text = String(formData.get('tag') ?? '').trim();
  if (text.length > 0) tags.push(text);
  revalidatePath('/actions');
}
