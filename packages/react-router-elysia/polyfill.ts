/**
 * Bun polyfill for `renderToPipeableStream`.
 *
 * Bun ships `react-dom/server.bun.js` which only exports Web Streams APIs
 * (`renderToReadableStream`). React Router v7 internally imports
 * `renderToPipeableStream` (Node Streams API), which doesn't exist on Bun.
 *
 * This polyfill patches the `react-dom/server` module in Bun's shared
 * require/import cache to provide a `renderToPipeableStream` that wraps
 * `renderToReadableStream` with a Node.js `PassThrough` stream — which
 * Bun supports through its Node compatibility layer.
 *
 * ## How it works
 *
 * 1. `require("react-dom/server")` synchronously loads the Bun module into
 *    the shared module cache.
 * 2. We detect that `renderToPipeableStream` is missing and `renderToReadableStream`
 *    is present.
 * 3. We add a `renderToPipeableStream` function that:
 *    - Returns `{ pipe(writable), abort() }` synchronously (matching the Node API)
 *    - Internally calls `renderToReadableStream` (async, returns `Promise<ReadableStream>`)
 *    - When the promise resolves (shell ready), calls `onShellReady()` and starts
 *      pumping Web Stream chunks into a Node.js `PassThrough`
 *    - `pipe(destination)` connects the PassThrough to the caller's writable
 *
 * ## Load order
 *
 * This file MUST be evaluated before React Router's code imports from
 * `react-dom/server`. In this package, `server.ts` imports this polyfill as its
 * very first static import. ES module evaluation order guarantees:
 *
 * ```
 * polyfill.ts  (no static deps → evaluated first → patches react-dom/server)
 *   ↓ require("react-dom/server") → loaded & cached
 * react-router (evaluated second → imports react-dom/server → gets patched version)
 * server.ts    (evaluated last)
 * ```
 */

// --- Internal types ---

interface RenderToPipeableStreamOptions {
    onShellReady?: () => void;
    onShellError?: (error: unknown) => void;
    onError?: (error: unknown) => void;
    onAllReady?: () => void;
    onReadyToStream?: () => void;
    identifierPrefix?: string;
    nonce?: string;
    bootstrapScriptContent?: string;
    bootstrapModules?: string[];
    bootstrapScripts?: Array<{ src: string; integrity?: string }>;
    progressiveChunkSize?: number;
    signal?: AbortSignal;
}

interface PipeableStream {
    pipe<T extends NodeJS.WritableStream>(destination: T): T;
    abort(): void;
}

// --- Polyfill implementation ---

// Use `require()` instead of `import` so that `react-dom/server` is NOT a static
// ES module dependency of this file. This ensures:
//   (a) `react-dom/server` is loaded on-demand during our body execution
//   (b) The module is placed in Bun's shared require/import cache
//   (c) We can mutate the cached object before React Router resolves its own import
const reactDomServer = require("react-dom/server") as Record<string, unknown>;

if (
    !("renderToPipeableStream" in reactDomServer) &&
    "renderToReadableStream" in reactDomServer
) {
    const renderToReadableStream = reactDomServer.renderToReadableStream as (
        element: unknown,
        options?: {
            onError?: (error: unknown) => void;
            onShellError?: (error: unknown) => void;
            onAllReady?: () => void;
            identifierPrefix?: string;
            nonce?: string;
            bootstrapScriptContent?: string;
            bootstrapModules?: string[];
            bootstrapScripts?: Array<{ src: string; integrity?: string }>;
            progressiveChunkSize?: number;
            signal?: AbortSignal;
        },
    ) => Promise<ReadableStream<Uint8Array>>;

    const { PassThrough } = require("node:stream") as typeof import("node:stream");

    reactDomServer.renderToPipeableStream = function renderToPipeableStream(
        element: unknown,
        options?: RenderToPipeableStreamOptions,
    ): PipeableStream {
        const body = new PassThrough();
        let aborted = false;
        let shellSettled = false;
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        const internalAbort = new AbortController();

        /**
         * Read chunks from the Web ReadableStream and push them into
         * the Node.js PassThrough, which is already piped to the caller's
         * writable stream.
         */
        function pump(): void {
            if (!reader || aborted) return;
            reader
                .read()
                .then(({ done, value }) => {
                    if (done || aborted) {
                        if (!aborted) body.end();
                        return;
                    }
                    body.push(Buffer.from(value));
                    pump();
                })
                .catch((error: Error) => {
                    if (!aborted) {
                        body.destroy(error);
                    }
                });
        }

        // Start rendering asynchronously.
        // renderToReadableStream resolves when the shell is ready (same timing
        // as onShellReady in the Node version).
        renderToReadableStream(
            element,
            {
                // Forward error callbacks
                onError(error: unknown) {
                    options?.onError?.(error);
                },
                onShellError(error: unknown) {
                    if (!shellSettled) {
                        shellSettled = true;
                        options?.onShellError?.(error);
                    }
                },
                onAllReady() {
                    options?.onAllReady?.();
                },
                // Forward rendering options
                identifierPrefix: options?.identifierPrefix,
                nonce: options?.nonce,
                bootstrapScriptContent: options?.bootstrapScriptContent,
                bootstrapModules: options?.bootstrapModules,
                bootstrapScripts: options?.bootstrapScripts,
                progressiveChunkSize: options?.progressiveChunkSize,
                signal: internalAbort.signal,
            },
        )
            .then((stream) => {
                if (aborted || shellSettled) return;

                reader = stream.getReader();

                // The shell is ready. Call onShellReady so the consumer can
                // set headers and pipe the response body.
                // React Router's default entry.server does:
                //   const { pipe } = renderToPipeableStream(element, { onShellReady() { pipe(body); } });
                // Our pipe() connects the PassThrough to body, THEN we start pumping.
                options?.onShellReady?.();

                // Start streaming rendered chunks into the PassThrough
                pump();
            })
            .catch((error: unknown) => {
                if (shellSettled) return;
                shellSettled = true;
                options?.onShellError?.(error);
            });

        return {
            /**
             * Connect this render output to a Node.js writable stream.
             * React Router's entry.server calls this inside `onShellReady`.
             */
            pipe<T extends NodeJS.WritableStream>(destination: T): T {
                body.pipe(destination);
                return destination;
            },

            /**
             * Abort in-flight rendering. Called by React Router after a timeout
             * if the client disconnects.
             */
            abort(): void {
                aborted = true;
                internalAbort.abort();
                reader?.cancel().catch(() => { });
                body.destroy();
            },
        };
    };

    // Also polyfill `renderToStaticMarkup` variants if needed in the future.
    // Bun's react-dom/server.bun.js should already have renderToString and
    // renderToStaticMarkup.
}
