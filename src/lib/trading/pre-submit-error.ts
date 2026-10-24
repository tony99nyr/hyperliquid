/** The order was neither signed nor sent, so it cannot have filled. */
export class PreSubmitError extends Error {
  constructor(message: string, public readonly originalCause?: unknown) {
    super(message);
    this.name = 'PreSubmitError';
  }
}
