/**
 * Checks a value against the JSON Schema published in docs/schema, for the
 * tests: they hold what the app writes and reads to what the documentation
 * says. It knows the few keywords that schema uses and refuses any other, so
 * a schema that grows past it fails loudly rather than being half checked.
 * Strict, it also refuses a field the schema does not describe, so every
 * field the app writes is documented. The app itself does not load it.
 */

type Schema = Record<string, unknown>;

const KNOWN = new Set([
  "$schema", "$id", "title", "description", "$defs", "$ref",
  "type", "const", "enum", "pattern", "format", "minimum", "maximum", "maxItems",
  "required", "properties", "additionalProperties", "items", "oneOf",
]);

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Where the value breaks the schema, one line each; empty when it does not. */
export function schemaErrors(root: Schema, value: unknown, strict = false): string[] {
  const errors: string[] = [];
  const check = (schema: Schema, v: unknown, path: string): void => {
    for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`the schema uses ${key}, which this check does not know`);
    if (typeof schema.$ref === "string") {
      const name = /^#\/\$defs\/(.+)$/.exec(schema.$ref)?.[1];
      const target = name ? (root.$defs as Record<string, Schema> | undefined)?.[name] : undefined;
      if (!target) throw new Error(`no ${schema.$ref} in the schema`);
      check(target, v, path);
    }
    if (schema.oneOf) {
      const matching = (schema.oneOf as Schema[]).filter((option) => {
        const before = errors.length;
        check(option, v, path);
        const ok = errors.length === before;
        errors.length = before;
        return ok;
      });
      if (matching.length !== 1) errors.push(`${path}: matches ${matching.length} of oneOf`);
    }
    if ("const" in schema && v !== schema.const) errors.push(`${path}: not ${JSON.stringify(schema.const)}`);
    if (schema.enum && !(schema.enum as unknown[]).includes(v)) errors.push(`${path}: not one of ${JSON.stringify(schema.enum)}`);
    if (schema.type && !typeOk(schema.type as string, v)) return void errors.push(`${path}: not ${schema.type}`);
    if (typeof v === "string") {
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(v)) errors.push(`${path}: does not match ${schema.pattern}`);
      if (schema.format === "date-time" && (!TIME.test(v) || Number.isNaN(Date.parse(v)))) errors.push(`${path}: not a date-time`);
    }
    if (typeof v === "number") {
      if (typeof schema.minimum === "number" && v < schema.minimum) errors.push(`${path}: under ${schema.minimum}`);
      if (typeof schema.maximum === "number" && v > schema.maximum) errors.push(`${path}: over ${schema.maximum}`);
    }
    if (Array.isArray(v)) {
      if (typeof schema.maxItems === "number" && v.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
      if (schema.items) v.forEach((item, i) => check(schema.items as Schema, item, `${path}[${i}]`));
    }
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      for (const key of (schema.required as string[] | undefined) ?? []) if (!(key in o)) errors.push(`${path}.${key}: missing`);
      const properties = schema.properties as Record<string, Schema> | undefined;
      if (properties) {
        for (const [key, item] of Object.entries(o)) {
          const sub = properties[key];
          if (sub) check(sub, item, `${path}.${key}`);
          else if (schema.additionalProperties === false || (strict && schema.additionalProperties !== true)) errors.push(`${path}.${key}: not in the schema`);
        }
      }
    }
  };
  check(root, value, "$");
  return errors;
}

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      throw new Error(`type ${type} is not known to this check`);
  }
}
