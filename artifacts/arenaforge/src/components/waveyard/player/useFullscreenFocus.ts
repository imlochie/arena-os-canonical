import { useLayoutEffect, useRef } from "react";

/** CSS fullscreen must isolate keyboard navigation just like a modal. */
export function useFullscreenFocus(fullscreen: boolean) {
  const surface = useRef<HTMLElement>(null);
  const wasFullscreen = useRef(false);
  useLayoutEffect(() => {
    const element = surface.current;
    const leaving = wasFullscreen.current && !fullscreen;
    wasFullscreen.current = fullscreen;
    if (!element) return;
    const toggle = element.querySelector<HTMLButtonElement>("[data-fullscreen-toggle]");
    // Restore after the exit DOM commit, not during effect cleanup (before
    // React has updated the fullscreen layout and button).
    if (leaving) {
      toggle?.focus();
      toggle?.scrollIntoView({ block: "center" });
    }
    if (!fullscreen) return;
    const background = new Map<HTMLElement, boolean>();
    // Isolate siblings at every ancestor, including the room navigation.
    for (let branch: HTMLElement | null = element; branch?.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling instanceof HTMLElement && sibling !== branch) {
          background.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
      if (branch.parentElement === document.body) break;
    }
    toggle?.focus();
    toggle?.scrollIntoView({ block: "nearest" });
    const containFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [...element.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex]',
      )].filter((control) => control.tabIndex >= 0 && control.getClientRects().length > 0 && !control.closest("[inert]"));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    element.addEventListener("keydown", containFocus);
    return () => {
      element.removeEventListener("keydown", containFocus);
      for (const [sibling, inert] of background) sibling.inert = inert;
    };
  }, [fullscreen]);
  return surface;
}
