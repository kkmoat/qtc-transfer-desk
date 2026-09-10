//! Hashing configuration for verification.
//!
//! This module re-exports the core configuration traits and types
//! for use in the verifier crate.

// Re-export all config types from core
pub use qp_plonky2_core::config::{
    GenericConfig, GenericHashOut, Hasher, KeccakGoldilocksConfig, PoseidonGoldilocksConfig,
};
