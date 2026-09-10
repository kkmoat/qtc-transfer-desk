#![allow(clippy::too_many_arguments)]
#![allow(clippy::needless_range_loop)]
#![deny(rustdoc::broken_intra_doc_links)]
#![deny(missing_debug_implementations)]
#![cfg_attr(not(feature = "std"), no_std)]

#[cfg(not(feature = "std"))]
pub extern crate alloc;

/// Re-export of `plonky2_field`.
#[doc(inline)]
pub use plonky2_field as field;
/// Re-export verification types from the verifier crate (canonical source)
#[doc(inline)]
pub use plonky2_verifier::verify;
pub use plonky2_verifier::{
    CommonCircuitData, CompressedProofWithPublicInputs, GenericConfig, GenericHashOut, Hasher,
    PoseidonGoldilocksConfig, Proof, ProofWithPublicInputs, VerifierCircuitData,
    VerifierOnlyCircuitData, C, D, F,
};

pub mod batch_fri;
pub mod fri;
pub mod gadgets;
pub mod gates;
pub mod hash;
pub mod iop;
pub mod plonk;
pub mod recursion;
pub mod util;

#[cfg(test)]
mod cross_crate_gate_tests;
#[cfg(test)]
mod lookup_test;
