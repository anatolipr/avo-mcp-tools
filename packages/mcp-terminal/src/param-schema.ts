// Converts this package's flat ParamSpec map (same shape js-bridge-mcp's
// JSON->zod converter expects from window.__mcpTools) into a zod raw shape
// for McpServer#registerTool.
import { z } from 'zod';
import type { ParamSpec } from './types.js';

export function paramsToZodShape(params: Record<string, ParamSpec>): Record<string, z.ZodTypeAny> {
  let shape: Record<string, z.ZodTypeAny> = {};
  for (let [key, spec] of Object.entries(params)) {
    let base: z.ZodTypeAny =
      spec.type === 'number' ? z.number() :
      spec.type === 'boolean' ? z.boolean() :
      z.string();
    if (spec.description) base = base.describe(spec.description);
    shape[key] = spec.optional ? base.optional() : base;
  }
  return shape;
}
