import { describe, expect, test, vi } from 'vitest';
import { installKeyboardNavigationIntent } from './keyboardNavigation';

function createFakeDocument() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const documentElement = { dataset: {} as DOMStringMap } as HTMLElement;

  return {
    documentElement,
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      const bucket = listeners.get(type) ?? new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatch(type: string, event: Event) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    }
  };
}

describe('installKeyboardNavigationIntent', () => {
  test('keeps skip-link hidden on startup and shows it only after Tab navigation', () => {
    const doc = createFakeDocument();

    installKeyboardNavigationIntent(doc);

    expect(doc.documentElement.dataset.keyboardNavigation).toBeUndefined();

    doc.dispatch('keydown', { key: 'Enter' } as unknown as Event);
    expect(doc.documentElement.dataset.keyboardNavigation).toBeUndefined();

    doc.dispatch('keydown', { key: 'Tab' } as unknown as Event);
    expect(doc.documentElement.dataset.keyboardNavigation).toBe('true');
  });

  test('clears keyboard-navigation intent after pointer input', () => {
    const doc = createFakeDocument();

    installKeyboardNavigationIntent(doc);

    doc.dispatch('keydown', { key: 'Tab' } as unknown as Event);
    doc.dispatch('pointerdown', new Event('pointerdown'));

    expect(doc.documentElement.dataset.keyboardNavigation).toBeUndefined();
  });
});
