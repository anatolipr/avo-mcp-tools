export type ShapeType = 'rect' | 'ellipse' | 'arrow' | 'line' | 'text' | 'step' | 'pen' | 'highlight' | 'blur' | 'tag' | 'picture' | 'magnifier';
export type Tool = ShapeType | 'select';

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
  // rect / ellipse / arrow / line / highlight / blur / picture: two corners (or ends).
  // pen: full stroke path. text: top-left anchor. step: center.
  // tag: arrow tip (or the bubble's top-left when tagArrow is 'none').
  points: Point[];
  // text and tag: may use a small Markdown subset (see richtext.ts)
  label?: string;
  // text and tag: formatting for the whole label
  textStyle?: TextStyle;
  // text only: wrap width in image pixels. Absent: no wrapping, the box grows with the text.
  width?: number;
  // text only: minimum box height in image pixels (the box still grows to fit its text).
  height?: number;
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
  // picture only: an extra image (data URL) placed on the page, stretched to its two corners.
  src?: string;
  // magnifier only: points[0] is the spot being enlarged, points[1] the lens
  // center; the lens has this radius and shows the spot at `magnify`×.
  lensRadius?: number;
  magnify?: number;
  // arrow / line only: ends snapped to a text, tag, or picture (by id), as a
  // spot in fractions of its box, so they follow it. null: a free end.
  ends?: [ArrowEnd | null, ArrowEnd | null];
}

export type TextFont = 'sans' | 'serif' | 'mono' | 'hand';

export interface TextStyle {
  // Absent means bold (labels were always bold before styles existed).
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right';
  font?: TextFont;
}

export interface ArrowEnd {
  id: string;
  fx: number;
  fy: number;
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
  shapes: Shape[];
  // Slide title, shown on the page's thumbnail and as the presenter heading.
  title?: string;
  // Speaker notes: shown only while presenting the open document.
  notes?: string;
  // Present this page's tags and step markers one per click, in the order added.
  reveal?: boolean;
  // Where the editor was looking, once the page has been panned or zoomed by
  // hand: the image point at the center of the view, and the zoom. Slides
  // center on that point too. Absent: fit to the content (the default).
  view?: { x: number; y: number; zoom: number };
}

/** Axis-aligned rectangle in canvas (image) pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
