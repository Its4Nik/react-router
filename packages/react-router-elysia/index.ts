/**
 * react-router-elysia
 *
 * Elysia server request handler for React Router, optimized for Bun.
 *
 * This package provides an adapter that lets you serve React Router
 * server-rendered applications using the Elysia framework on Bun,
 * offering significantly better performance than the Express adapter due to:
 *
 * - Native Web API support (no Node.js stream conversions needed)
 * - Bun's optimized HTTP server and JavaScriptCore runtime
 * - Zero-cost type safety through Elysia's plugin system
 * - No dependency on @react-router/node stream utilities
 *
 * @example
 * ```typescript
 * import { Elysia } from "elysia";
 * import { createRequestHandler } from "react-router-elysia";
 *
 * const app = new Elysia()
 *   .all("/*", createRequestHandler({
 *     build: () => import("./build/server/index.js"),
 *   }))
 *   .listen(3000);
 * ```
 */

export {
    createRequestHandler,
    createRemixRequest,
    createRemixHeaders,
    type GetLoadContextFunction,
    type ElysiaLikeContext,
    type ElysiaRequestHandler,
} from "./server";

import type { AnyElysia } from "elysia";
import {
    createRequestHandler,
    type GetLoadContextFunction,
    type ElysiaLikeContext,
} from "./server";
import type { ServerBuild } from "react-router";

// ---------------------------------------------------------------------------
// Elysia Plugin
// ---------------------------------------------------------------------------

/**
 * Options for the `reactRouter` Elysia plugin.
 */
export interface ReactRouterElysiaPluginOptions {
    /**
     * The React Router server build, either as a direct import or a lazy
     * function that returns the build. Use a function when running in
     * development with Vite so the build can be reloaded on changes.
     */
    build: ServerBuild | (() => Promise<ServerBuild>);

    /**
     * A function that returns the value to use as `context` in route `loader`
     * and `action` functions.
     *
     * You can think of this as an escape hatch that allows you to pass
     * environment/platform-specific values through to your loader/action,
     * such as values derived from Elysia plugins or `beforeHandle` hooks.
     */
    getLoadContext?: GetLoadContextFunction;

    /**
     * The mode to run React Router in. Defaults to `process.env.NODE_ENV`.
     */
    mode?: string;
}

/**
 * Elysia plugin that integrates React Router SSR with the Elysia framework.
 *
 * This is the recommended way to use React Router with Elysia. It provides
 * full type-safety through Elysia's plugin system and automatically handles
 * all incoming requests through React Router's SSR pipeline.
 *
 * @example
 * ```typescript
 * import { Elysia } from "elysia";
 * import { reactRouter } from "react-router-elysia";
 *
 * const app = new Elysia()
 *   // Mount React Router as a catch-all handler
 *   .use(reactRouter({
 *     build: () => import("./build/server/index.js"),
 *     getLoadContext({ request, store }) {
 *       return {
 *         // Pass Elysia store values or other platform-specific data
 *         // to your React Router loaders and actions
 *         analytics: store.analytics,
 *       };
 *     },
 *   }))
 *   .listen(3000);
 *
 * console.log(`Server running at http://localhost:3000`);
 * ```
 *
 * @example With static build (production)
 * ```typescript
 * import { Elysia } from "elysia";
 * import { reactRouter } from "react-router-elysia";
 * import * as build from "./build/server/index.js";
 *
 * const app = new Elysia()
 *   .use(reactRouter({ build }))
 *   .listen(3000);
 * ```
 *
 * @example Combining with other Elysia plugins
 * ```typescript
 * import { Elysia } from "elysia";
 * import { swagger } from "@elysiajs/swagger";
 * import { cors } from "@elysiajs/cors";
 * import { reactRouter } from "react-router-elysia";
 * import * as build from "./build/server/index.js";
 *
 * const app = new Elysia()
 *   .use(cors())
 *   .use(swagger())
 *   // API routes are matched first, then React Router catches the rest
 *   .get("/api/health", () => ({ status: "ok" }))
 *   .get("/api/version", () => ({ version: "1.0.0" }))
 *   // React Router handles everything else (SSR pages, data routes, etc.)
 *   .use(reactRouter({ build }))
 *   .listen(3000);
 * ```
 */
export function reactRouter(options: ReactRouterElysiaPluginOptions) {
    const handler = createRequestHandler(options);

    return <const Instance extends AnyElysia>(app: Instance) =>
        app.all("/*", async ({ request, store, server, ...rest }) => {
            const context: ElysiaLikeContext = {
                request,
                store,
                server,
                ...rest,
            };
            return await handler(context);
        });
}
