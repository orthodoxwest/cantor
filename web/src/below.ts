// Whether the guide voice is doubled by itself an octave below, for voices the guide sits
// high for. The singer chooses once; the choice is kept on this device and every page that
// sings shares it.
const KEY = "cantor.below";

/** Whether the singer has asked for the octave below. */
export function belowChosen(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

/** Keeps `box` and the choice together: ticked as chosen, and the choice kept, and `changed`
 * told, when the singer ticks or unticks it. */
export function belowBox(box: HTMLInputElement, changed: (below: boolean) => void = () => {}): void {
  box.checked = belowChosen();
  box.addEventListener("change", () => {
    try {
      localStorage.setItem(KEY, box.checked ? "on" : "off");
    } catch {
      // A browser that keeps nothing still sings the octave below until the page is left.
    }
    changed(box.checked);
  });
}
