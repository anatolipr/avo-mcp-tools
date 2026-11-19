export type ShapeType = 'rect' | 'ellipse' | 'arrow' | 'line' | 'text' | 'step' | 'pen' | 'highlight' | 'blur' | 'tag';
export type Tool = ShapeType | 'select' | 'region';

export interface Point {
  x: number;
  y: number;
}

export interface Shape {
  id: string;
  type: ShapeType;
  color: string;
  // rect / ellipse / arrow / line / pen: stroke thickness. blur: pixel block
  // size multiplier. Unused by highlight (fixed fill), text, and step.
  lineWidth: number;
  // rect / ellipse / arrow / line / highlight / blur: two corners (or ends).
  // pen: full stroke path. text: top-left anchor. step: center.
  // tag: arrow tip (or the bubble's top-left when tagArrow is 'none').
  points: Point[];
  // text and tag
  label?: string;
  // text, step, and tag: font size (step's circle radius and a tag's
  // padding/arrow scale with it)
  fontSize?: number;
  // rect / ellipse: filled instead of outlined. text: drawn on a solid
  // background box (in the shape's color, with contrasting text).
  fill?: boolean;
  // step only: the number shown in the circle
  stepNumber?: number;
  // tag only: which edge of the bubble the pointer comes out of, and where
  // along it. 'none' is a plain note with no pointer.
  tagArrow?: TagArrow;
}

/** Clockwise around the bubble, three positions per side, plus 'none' (no pointer). */
export const TAG_ARROWS = [
  'top-left',
  'top-center',
  'top-right',
  'right-top',
  'right-center',
  'right-bottom',
  'bottom-right',
  'bottom-center',
  'bottom-left',
  'left-bottom',
  'left-center',
  'left-top',
  'none',
] as const;
export type TagArrow = (typeof TAG_ARROWS)[number];

export interface Page {
  id: string;
  name: string;
  imageDataUrl: string | null;
  shapes: Shape[];
}

/** Axis-aligned rectangle in canvas (image) pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
