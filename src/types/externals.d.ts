/**
 * Type shims for the two kinds of module this package consumes but does not
 * install locally.
 *
 *  * The Harness packages resolve at runtime from the Harness installation, so
 *    they are external in the Host build and must not be local dependencies.
 *  * The `.css` imports are inlined as text by esbuild's `text` loader.
 *
 * The declared shapes mirror the 0.2.0-rc.2 surfaces this plugin actually uses,
 * verified against the published typings and the live service directory.
 */

declare module '*.css' {
  const content: string
  export default content
}

declare module '@deepseek-ai/cordis' {
  /** The subset of the Cordis context this plugin touches. */
  export interface Context {
    effect(callback: () => unknown, label?: string): unknown
    plugin(plugin: unknown, config?: unknown): unknown
    on(event: string, listener: (...args: any[]) => void): () => void
    logger?: { info?(message: string): void; warn?(message: string): void }
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-storage-domain' {
  export function defineDomain(spec: unknown): unknown
  export function domainTable(valueSchema: unknown): unknown
}

declare module '@deepseek-ai/dsh-session' {
  /** Brand a plain string as a session id. */
  export function SessionId(id: string): string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  /** The Cordis context face a Typert remote service uses. */
  export interface TypertContextLike {
    effect(callback: () => unknown, label?: string): unknown
    on(event: string, listener: (...args: any[]) => void): () => void
    [key: string]: any
  }

  /**
   * Base class for a Typert remote service. It registers the instance on the
   * Context under `name` and installs the `typertRemote` binding the API gateway
   * validates on every invocation.
   *
   * `options.namespace` defaults to `name`. It MUST be passed whenever the wire
   * namespace differs from the Cordis service key, or the gateway rejects every
   * call with `binding-invalid`.
   */
  export class TypertRemoteService {
    constructor(ctx: TypertContextLike, name: string, options?: { namespace?: string })
    readonly ctx: TypertContextLike
    readonly name: string
    readonly typertRemote: {
      readonly service: unknown
      readonly serviceKey: string
      readonly namespace: string
    }
  }
}
