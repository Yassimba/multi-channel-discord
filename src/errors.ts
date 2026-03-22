/** Base error class for all application errors. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 500,
  ) {
    super(message)
  }
}

/** Session name not found in routing table. */
export class SessionNotFoundError extends AppError {
  constructor(name: string) {
    super('session_not_found', `Session '${name}' not found`, 404)
  }
}
