export type ShapeType = 'rect' | 'arrow' | 'text' | 'pen' | 'highlight';
export type Tool = ShapeType | 'select' | 'region';

export interface Point {
  x: number;
  y: number;
}

export interface Shape {
  id: string;
  type: ShapeType;
  color: string;
  // rect / arrow / pen: stroke thickness. Unused by highlight (fixed fill) and text.
  lineWidth: number;
  // rect / arrow / highlight: two corners. pen: full stroke path.
  points: Point[];
  // text only
  label?: string;
  fontSize?: number;
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
