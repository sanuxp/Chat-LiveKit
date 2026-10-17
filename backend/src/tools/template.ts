/** {{field}} placeholders; unknown fields render as an empty string. */
export function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Recursively replace ${VAR} in strings with environment variables. Throws if a variable is unset. */
export function resolveEnv<T>(value: T, where: string): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
      const v = process.env[name];
      if (v === undefined) throw new Error(`${where}: environment variable ${name} is not set`);
      return v;
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v, i) => resolveEnv(v, `${where}[${i}]`)) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveEnv(v, `${where}.${k}`)]),
    ) as unknown as T;
  }
  return value;
}
