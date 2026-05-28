type KeyboardNavigationDocument = Pick<Document, 'addEventListener' | 'removeEventListener' | 'documentElement'>;

export function installKeyboardNavigationIntent(doc: KeyboardNavigationDocument = document) {
  function showKeyboardNavigation(event: KeyboardEvent) {
    if (event.key === 'Tab') {
      doc.documentElement.dataset.keyboardNavigation = 'true';
    }
  }

  function hideKeyboardNavigation() {
    delete doc.documentElement.dataset.keyboardNavigation;
  }

  doc.addEventListener('keydown', showKeyboardNavigation, true);
  doc.addEventListener('pointerdown', hideKeyboardNavigation, true);

  return () => {
    doc.removeEventListener('keydown', showKeyboardNavigation, true);
    doc.removeEventListener('pointerdown', hideKeyboardNavigation, true);
  };
}
