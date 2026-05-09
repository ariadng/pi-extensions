import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type TestServerRoute = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

export async function startWebFetchTestServer(route: TestServerRoute): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((request, response) => {
		Promise.resolve(route(request, response)).catch((error) => {
			response.statusCode = 500;
			response.end(error instanceof Error ? error.message : String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Could not bind test server");
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}
