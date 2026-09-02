export class WorkflowApplicationError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'WorkflowApplicationError';
  }
}

export const fail = (code: string, message = code): never => {
  throw new WorkflowApplicationError(code, message);
};
