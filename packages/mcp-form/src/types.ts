export type FieldType =
  | 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'radio'
  | 'date' | 'datetime' | 'range' | 'multiselect' | 'file' | 'list'
  | 'color' | 'html_output';

export type SubFieldType = Exclude<FieldType, 'list' | 'html_output' | 'file'>;

export interface ValidationRules {
  required?: boolean;
  pattern?: string;
  patternMessage?: string;
  minLength?: number;
  maxLength?: number;
}

export interface SubFieldDef extends ValidationRules {
  name: string;
  label: string;
  type: SubFieldType;
  placeholder?: string;
  options?: string[];
  default?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface FieldDef extends ValidationRules {
  name: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  options?: string[];
  default?: string;
  accept?: string;
  fields?: SubFieldDef[];
  min?: number;
  max?: number;
  step?: number;
  html?: string;
  css?: string;
  itemLabel?: string;
}

export interface FormDef {
  title?: string;
  fields: FieldDef[];
}

export type FieldValues = Record<string, string>;

export function initialValuesFor(formDef: FormDef): FieldValues {
  const values: FieldValues = {};
  for (const f of formDef.fields) {
    if (f.type === 'html_output') continue;
    values[f.name] = f.default ?? '';
  }
  return values;
}
