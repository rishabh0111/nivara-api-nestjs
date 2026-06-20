/**
 * Runs `fn` with the given environment overrides, restoring the previous
 * environment afterwards. An `undefined` value deletes the variable.
 *
 * Configuration is read at boot, so a test that wants to observe a different
 * configuration has to change the environment and boot a fresh application
 * inside the override.
 */
export const withEnv = async (
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> => {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};
