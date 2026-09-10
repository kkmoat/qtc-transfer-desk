//! Plonky2 Verifier Library
//!
//! This crate provides verification functionality for Plonky2 proofs.
//! It is designed to be minimal, no-std compatible, and requires no randomness.
//!
//! This is ideal for on-chain verification where:
//! - Binary size matters
//! - No access to OS randomness
//! - no_std environment
//!
//! # Usage
//!
//! ```ignore
//! use qp_plonky2_verifier::{verify, VerifierCircuitData, ProofWithPublicInputs};
//!
//! let verifier_data = VerifierCircuitData::from_bytes(...)?;
//! let proof = ProofWithPublicInputs::from_bytes(...)?;
//!
//! verifier_data.verify(proof)?;
//! ```

#![allow(clippy::too_many_arguments)]
#![allow(clippy::needless_range_loop)]
#![deny(rustdoc::broken_intra_doc_links)]
#![deny(missing_debug_implementations)]
#![cfg_attr(not(feature = "std"), no_std)]

#[cfg(any(not(feature = "std"), test))]
extern crate alloc;

/// Re-export of `plonky2_field`.
#[doc(inline)]
pub use plonky2_field as field;

pub mod fri;
pub mod gates;
pub mod hash;
pub mod iop;
pub mod plonk;
pub mod util;

// Re-export commonly used types at crate root
pub use plonk::circuit_data::{
    CircuitConfig, CommonCircuitData, CommonVerifierData, VerifierCircuitData,
    VerifierOnlyCircuitData,
};
pub use plonk::config::{GenericConfig, GenericHashOut, Hasher, PoseidonGoldilocksConfig};
pub use plonk::proof::{CompressedProofWithPublicInputs, Proof, ProofWithPublicInputs};
pub use plonk::verifier::verify;

// Standard Plonky2 configuration type aliases
// These match the configuration used throughout the Quantus ecosystem
/// The extension degree for the field extension (D=2 provides 100-bits of security)
pub const D: usize = 2;
/// The standard Plonky2 configuration using Poseidon hash over Goldilocks field
pub type C = PoseidonGoldilocksConfig;
/// The Goldilocks prime field
pub type F = field::goldilocks_field::GoldilocksField;
