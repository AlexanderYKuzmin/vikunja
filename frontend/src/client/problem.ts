// Only a parsed JSON body; Error instances come from the transport or our own interceptors.
function isWireProblem(error: unknown): error is Record<string, unknown> {
	return typeof error === 'object' && error !== null && Object.getPrototypeOf(error) === Object.prototype
}

// Echo rejects some /api/v2 requests before Huma (rate limits, invalid JWT) and answers with a
// v1-shaped body, so the top-level status/detail of api.md only holds once we stamp it on.
export function normalizeProblemBody(error: unknown, response: Response | undefined): unknown {
	if (!response || !isWireProblem(error) || typeof error.status === 'number') {
		return error
	}
	return {
		...error,
		status: response.status,
		detail: error.detail ?? error.message,
	}
}

// Our wrappers rethrow the SDK's problem body as an Error's cause.
export function problemCause(error: unknown): {status?: number, code?: number} {
	const cause = typeof error === 'object' && error !== null && 'cause' in error ? error.cause : undefined
	if (typeof cause !== 'object' || cause === null) {
		return {}
	}
	return {
		status: 'status' in cause && typeof cause.status === 'number' ? cause.status : undefined,
		code: 'code' in cause && typeof cause.code === 'number' ? cause.code : undefined,
	}
}
