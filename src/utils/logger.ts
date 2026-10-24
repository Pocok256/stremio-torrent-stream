for (const method of ["debug", "info", "log", "warn", "error"] as const) {
  const original = console[method].bind(console);

  Object.defineProperty(console, method, {
    configurable: true,
    value: (...args: unknown[]) =>
      original(`[${new Date().toISOString()}]`, ...args),
  });
}
