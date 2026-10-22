/**
 * Loading spinner (UCS-285): one small spinning ring shown next to every
 * loading message, so each loading spot looks the same. The ring is styled by
 * the `loading-spinner` Tailwind component class in `style.css`; index.html
 * uses the same class for the spinners present before any script runs.
 *
 * The ring is decorative (`aria-hidden`); the message text stays the
 * accessible status. Its text content is empty, so an element's
 * `textContent` reads exactly as the message alone.
 */

const LOADING_SPINNER_CLASS = 'loading-spinner';

export function createLoadingSpinner(): HTMLSpanElement {
  const spinner = document.createElement('span');
  spinner.className = LOADING_SPINNER_CLASS;
  spinner.setAttribute('aria-hidden', 'true');
  return spinner;
}

/**
 * Shows a spinner followed by `message` as the element's only content. An
 * existing spinner is kept, so a frequently updated message does not restart
 * its animation.
 */
export function showLoadingMessage(element: HTMLElement, message: string): void {
  const first = element.firstElementChild;
  const spinner =
    first instanceof HTMLElement && first.classList.contains(LOADING_SPINNER_CLASS) ? first : null;
  if (!spinner) {
    element.replaceChildren(createLoadingSpinner(), message);
    return;
  }
  while (element.firstChild && element.firstChild !== spinner) element.firstChild.remove();
  while (spinner.nextSibling) spinner.nextSibling.remove();
  spinner.after(message);
}
