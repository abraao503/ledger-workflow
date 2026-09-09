export class WorkflowApplicationError extends Error {
  constructor(
    public readonly code: string,
    message = code,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorkflowApplicationError';
  }
}

export const fail = (
  code: string,
  message = code,
  details?: Record<string, unknown>,
): never => {
  throw new WorkflowApplicationError(code, message, details);
};
