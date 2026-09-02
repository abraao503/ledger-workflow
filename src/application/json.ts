export const encodeJson = (value: unknown): string => JSON.stringify(value);

export const decodeJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
