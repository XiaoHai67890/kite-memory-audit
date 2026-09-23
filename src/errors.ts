export class ServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 503) {
    super(message);
    this.name = 'ServiceError';
  }
}
