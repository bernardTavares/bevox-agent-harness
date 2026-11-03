import { z, type ZodTypeAny } from "zod";

/**
 * Minimal JSON-Schema → Zod converter, tailored to the shapes used in
 * `manifest.yaml#parameters` across the built-in skills.
 *
 * Supports:
 *   - `type: "string"` with optional `description` and `enum`
 *   - `type: "number"` with optional `minimum`, `maximum`, `default`
 *   - `type: "boolean"`
 *   - `type: "object"` with optional `properties`, `required`, `additionalProperties`
 *   - `type: "array"` with optional `items`
 *
 * Returns a `ZodRawShapeCompat` (Record of Zod schemas) — the shape required
 * by `McpServer.registerTool({ inputSchema })`. The SDK wraps this raw shape
 * into a Zod object internally.
 *
 * Anything outside the supported set falls back to `z.unknown()` so the
 * server never crashes on a skill it does not fully understand — the skill
 * itself remains responsible for validating its own params at runtime.
 */
export type ZodRawShape = Record<string, ZodTypeAny>;

interface JsonSchemaNode {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaNode;
  items?: JsonSchemaNode;
}

function nodeToZod(node: JsonSchemaNode): ZodTypeAny {
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  let schema: ZodTypeAny;

  switch (type) {
    case "string": {
      if (Array.isArray(node.enum) && node.enum.length > 0) {
        const values = node.enum.filter((v): v is string => typeof v === "string");
        schema = values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string();
      } else {
        schema = z.string();
      }
      break;
    }
    case "number":
    case "integer": {
      let num = z.number();
      if (typeof node.minimum === "number") num = num.min(node.minimum);
      if (typeof node.maximum === "number") num = num.max(node.maximum);
      schema = num;
      break;
    }
    case "boolean":
      schema = z.boolean();
      break;
    case "array":
      schema = z.array(node.items ? nodeToZod(node.items) : z.unknown());
      break;
    case "object": {
      const shape: ZodRawShape = {};
      const required = new Set(node.required ?? []);
      for (const [key, sub] of Object.entries(node.properties ?? {})) {
        const child = nodeToZod(sub);
        shape[key] = required.has(key) ? child : child.optional();
      }
      let obj = z.object(shape);
      if (node.additionalProperties === true) {
        obj = obj.passthrough();
      }
      schema = obj;
      break;
    }
    default:
      schema = z.unknown();
  }

  if (typeof node.description === "string") {
    schema = schema.describe(node.description);
  }
  if (node.default !== undefined) {
    schema = schema.default(node.default as never);
  }
  return schema;
}

/**
 * Convert the top-level JSON Schema object from a manifest into the raw
 * shape (Record<string, ZodTypeAny>) expected by `McpServer.registerTool`.
 *
 * If the top-level schema is not an object (defensive — manifest validator
 * already enforces `type: "object"`), returns an empty shape so the tool
 * is callable with no arguments rather than crashing.
 */
export function manifestParametersToZodShape(parameters: Record<string, unknown>): ZodRawShape {
  const node = parameters as JsonSchemaNode;
  if (node.type !== "object" || !node.properties) {
    return {};
  }
  const required = new Set(node.required ?? []);
  const shape: ZodRawShape = {};
  for (const [key, sub] of Object.entries(node.properties)) {
    const child = nodeToZod(sub);
    shape[key] = required.has(key) ? child : child.optional();
  }
  return shape;
}
