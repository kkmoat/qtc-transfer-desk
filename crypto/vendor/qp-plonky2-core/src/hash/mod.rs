//! Hash-related utilities shared between prover and verifier.

pub mod path_compression;

pub use path_compression::{compress_merkle_proofs, decompress_merkle_proofs};
