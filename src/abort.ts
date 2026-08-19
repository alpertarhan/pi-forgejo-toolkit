export function waitWithSignal<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const cleanup = (): void => signal.removeEventListener("abort", onAbort);
		const onAbort = (): void => {
			cleanup();
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}
