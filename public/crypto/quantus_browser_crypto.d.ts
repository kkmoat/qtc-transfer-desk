/* tslint:disable */
/* eslint-disable */

/**
 * Holds official zeroize-on-drop keypairs. No secret accessors are exposed.
 */
export class SecretHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Immediately drop and zeroize secret key material; safe to call repeatedly.
     */
    clear(): void;
    /**
     * Sign the complete SCALE SignedPayload. Performs Substrate's >256-byte hash rule.
     * It never assembles or broadcasts a transaction.
     */
    signPayload(payload: Uint8Array, spec_version: number): Uint8Array;
    readonly accountId: Uint8Array;
    readonly address: string;
    readonly cleared: boolean;
    readonly path: string;
    readonly publicKey: Uint8Array;
    readonly scheme: string;
}

/**
 * An official HD seed retained only inside the local Worker/WASM session.
 * No mnemonic, seed, secret or first-hash getter is exported.
 */
export class WormholeSession {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    accountId(index: number, branch: number): Uint8Array;
    clear(): void;
    computeNullifier(index: number, branch: number, transfer_count: string, expected_address: string): Uint8Array;
    deriveAddress(index: number, branch: number): string;
    readonly cleared: boolean;
}

export function deriveAccount(mnemonic: string, scheme: string, account_index: number): SecretHandle;

/**
 * Explicit canonical BIP44 path option for accounts created with custom HD indices.
 */
export function deriveAccountAtPath(mnemonic: string, scheme: string, path: string): SecretHandle;

export function openWormhole(mnemonic: string): WormholeSession;

export function verifyPayload(public_key: Uint8Array, payload: Uint8Array, signature: Uint8Array, scheme: string, spec_version: number): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_secrethandle_free: (a: number, b: number) => void;
    readonly __wbg_wormholesession_free: (a: number, b: number) => void;
    readonly deriveAccount: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly deriveAccountAtPath: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly openWormhole: (a: number, b: number) => [number, number, number];
    readonly secrethandle_accountId: (a: number) => [number, number];
    readonly secrethandle_address: (a: number) => [number, number];
    readonly secrethandle_clear: (a: number) => void;
    readonly secrethandle_cleared: (a: number) => number;
    readonly secrethandle_path: (a: number) => [number, number];
    readonly secrethandle_publicKey: (a: number) => [number, number];
    readonly secrethandle_scheme: (a: number) => [number, number];
    readonly secrethandle_signPayload: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly verifyPayload: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly wormholesession_accountId: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wormholesession_clear: (a: number) => void;
    readonly wormholesession_cleared: (a: number) => number;
    readonly wormholesession_computeNullifier: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly wormholesession_deriveAddress: (a: number, b: number, c: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
