// First import of the app: web3.js / anchor / the MagicBlock SDK touch Buffer while loading.
import { Buffer } from "buffer";

(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
