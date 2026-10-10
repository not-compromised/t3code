// culori ships no types. The desktop calls only these two functions, so it
// declares them here instead of depending on @types/culori: that lockfile entry
// sits beside @effect/vitest's and conflicted with every Effect upgrade when the
// fork's patches were replayed onto a new upstream nightly.
declare module "culori/css";

declare module "culori/fn" {
  interface Color {
    readonly mode: string;
  }

  interface Rgb extends Color {
    readonly mode: "rgb";
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly alpha?: number;
  }

  export function parse(color: string): Color | undefined;
  export function converter(mode: "rgb"): (color: Color) => Rgb;
}
