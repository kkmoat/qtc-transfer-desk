//! Hash type definitions for the prover.
//!
//! All types are re-exported from qp-plonky2-core.

// Re-export all hash types from core
pub use qp_plonky2_core::hash_types::{BytesHash, HashOut, RichField, NUM_HASH_OUT_ELTS};
pub use qp_plonky2_core::iop::hash_target::{HashOutTarget, MerkleCapTarget};
