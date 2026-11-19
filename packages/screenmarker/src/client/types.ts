export type ShapeType = 'rect' | 'ellipse' | 'arrow' | 'line' | 'text' | 'step' | 'pen' | 'highlight' | 'blur';
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
  points: Point[];
  // text only
  label?: string;
  // text and step: font size (step's circle radius scales with it)
  fontSize?: number;
  // rect / ellipse: filled instead of outlined. text: drawn on a solid
  // background box (in the shape's color, with contrasting text).
  fill?: boolean;
  // step only: the number shown in the circle
  stepNumber?: number;
}

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
