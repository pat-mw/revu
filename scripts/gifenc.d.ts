/**
 * Minimal ambient types for `gifenc`, a small pure-JS GIF encoder that ships no
 * type declarations of its own. Only the surface this repo's capture pipeline
 * uses is described here: quantize a set of RGBA pixels to a palette, map each
 * frame's pixels onto that palette, and stream the indexed frames out as GIF
 * bytes. See the package README for the full runtime API.
 */
declare module 'gifenc' {
  /** A palette is a list of RGB (or RGBA) colour tuples, each channel a byte. */
  export type Palette = number[][]

  export interface QuantizeOptions {
    /** Colour packing used while quantizing; `rgb565` is the encoder default. */
    format?: 'rgb565' | 'rgb444' | 'rgba4444'
    oneBitAlpha?: boolean | number
    clearAlpha?: boolean
    clearAlphaThreshold?: number
    clearAlphaColor?: number
  }

  /** Reduce the colours in a flat RGBA buffer to at most `maxColors` entries. */
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: QuantizeOptions,
  ): Palette

  /** Map each RGBA pixel to the nearest index in `palette`, yielding an indexed bitmap. */
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array

  export interface WriteFrameOptions {
    /** Colour table for this frame; required on the first frame (the global table). */
    palette?: Palette
    /** Frame delay in milliseconds. */
    delay?: number
    /** GIF disposal method for this frame. */
    dispose?: number
    /** How many times the whole animation repeats; 0 means loop forever. */
    repeat?: number
    transparent?: boolean
    transparentIndex?: number
  }

  export interface GifEncoder {
    writeFrame(index: Uint8Array, width: number, height: number, options?: WriteFrameOptions): void
    finish(): void
    bytes(): Uint8Array
    reset(): void
  }

  export interface GifEncoderOptions {
    auto?: boolean
    initialCapacity?: number
  }

  export function GIFEncoder(options?: GifEncoderOptions): GifEncoder
}
