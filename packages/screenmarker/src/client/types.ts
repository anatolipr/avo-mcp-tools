export type ShapeType = 'rect' | 'arrow' | 'text' | 'pen' | 'highlight';
export type Tool = ShapeType | 'select';

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
