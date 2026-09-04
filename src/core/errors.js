export class SpoolError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'SpoolError';
    this.code = code;
    this.details = details;
  }
}

export const fail = (code, message, details) => {
  throw new SpoolError(code, message, details);
};
